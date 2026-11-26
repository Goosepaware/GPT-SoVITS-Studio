import fs from 'node:fs'
import path from 'node:path'
import type { HistoryEntry, Voice, VoiceFolderInfo, VoiceLibrary } from '@shared/types'
import { sidecarPaths } from './subtitles'

interface StoredHistory extends Omit<HistoryEntry, 'filePath'> {
  fileRel: string
}

interface StoredVoice extends Omit<Voice, 'audioPath'> {
  audioRel: string
}

interface VoiceManifest {
  format: string
  version: number
  name: string
  transcript: string
  promptLang: string
  duration: number
  createdAt: number
  originalName?: string
  audioExt: string
}

interface VoiceUsage {
  version: number
  lastUsedAt: Record<string, number>
}

export interface VoiceImportResult {
  voices: Voice[]
  imported: number
  skipped: number
}

const VOICE_EXT = '.v5t'
const VOICE_MAGIC = 'V5T1'
const VOICE_FORMAT = 'gpt-sovits-studio/voice'
const VOICE_VERSION = 1
const VOICE_LANGS = new Set(['auto', 'zh', 'ja', 'en', 'yue', 'ko'])
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma'])

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf-8')
  fs.renameSync(temp, file)
}

function relativePath(dataRoot: string, file: string): string {
  const rel = path.relative(dataRoot, file)
  return rel.startsWith('..') ? file : rel
}

function absolutePath(dataRoot: string, file: string): string {
  return path.isAbsolute(file) ? file : path.join(dataRoot, file)
}

function safeName(value: string, fallback = '音色'): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
  return (cleaned || fallback).slice(0, 64)
}

function safeFolderName(value: string): string {
  return safeName(value, '新建文件夹')
}

function normalizeFolder(value: unknown): string {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!raw) return ''
  const parts = raw.split('/').filter(Boolean)
  if (parts.some((part) => part === '.' || part === '..' || /[<>:"|?*\u0000-\u001f]/.test(part))) {
    throw new Error(`非法文件夹路径：${raw}`)
  }
  return parts.join('/')
}

function normalizeLang(value: unknown): string {
  const lang = String(value || 'auto').trim().toLowerCase()
  return VOICE_LANGS.has(lang) ? lang : 'auto'
}

function normalizeExt(value: unknown): string {
  const ext = String(value || '.wav').toLowerCase()
  return AUDIO_EXTENSIONS.has(ext) ? ext : '.wav'
}

function normalizeManifest(raw: Partial<VoiceManifest>, fallbackName: string): VoiceManifest {
  return {
    format: raw.format || VOICE_FORMAT,
    version: Number(raw.version) || VOICE_VERSION,
    name: String(raw.name || fallbackName || '未命名音色').trim() || '未命名音色',
    transcript: String(raw.transcript || ''),
    promptLang: normalizeLang(raw.promptLang),
    duration: Number(raw.duration) || 0,
    createdAt: Number(raw.createdAt) || Date.now(),
    originalName: raw.originalName ? String(raw.originalName) : undefined,
    audioExt: normalizeExt(raw.audioExt)
  }
}

/**
 * .v5t 单文件格式：
 *   0..3   "V5T1"
 *   4..7   UInt32LE，元数据 JSON 字节数
 *   8..   元数据 JSON（UTF-8）
 *   之后   原始音频字节
 */
function writeVoicePackage(file: string, manifest: VoiceManifest, audio: Buffer): void {
  const meta = Buffer.from(JSON.stringify(manifest), 'utf-8')
  const header = Buffer.alloc(8)
  header.write(VOICE_MAGIC, 0, 'ascii')
  header.writeUInt32LE(meta.length, 4)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, Buffer.concat([header, meta, audio]))
  fs.renameSync(temp, file)
}

function readVoicePackage(file: string): { manifest: VoiceManifest; audio: Buffer } | null {
  try {
    const buffer = fs.readFileSync(file)
    if (buffer.length < 9 || buffer.subarray(0, 4).toString('ascii') !== VOICE_MAGIC) return null
    const metaLength = buffer.readUInt32LE(4)
    if (metaLength <= 0 || 8 + metaLength > buffer.length) return null
    const raw = JSON.parse(buffer.subarray(8, 8 + metaLength).toString('utf-8')) as Partial<VoiceManifest>
    const fallbackName = path.basename(file, path.extname(file))
    return {
      manifest: normalizeManifest(raw, fallbackName),
      audio: buffer.subarray(8 + metaLength)
    }
  } catch {
    return null
  }
}

/** Read only the header + JSON metadata. Listing hundreds of voices must not load all audio. */
function readVoiceMeta(file: string): VoiceManifest | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const header = Buffer.alloc(8)
    if (fs.readSync(fd, header, 0, 8, 0) !== 8 || header.subarray(0, 4).toString('ascii') !== VOICE_MAGIC) return null
    const metaLength = header.readUInt32LE(4)
    if (metaLength <= 0 || metaLength > 4 * 1024 * 1024) return null
    const meta = Buffer.alloc(metaLength)
    if (fs.readSync(fd, meta, 0, metaLength, 8) !== metaLength) return null
    const raw = JSON.parse(meta.toString('utf-8')) as Partial<VoiceManifest>
    return normalizeManifest(raw, path.basename(file, path.extname(file)))
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch {}
    }
  }
}

export class Storage {
  private voiceCacheDir: string
  private libraryFile: string
  private migrated = false

  constructor(
    private dataRoot: string,
    private historyFile: string,
    private voicesFile: string,
    private voicesDir: string
  ) {
    this.voiceCacheDir = path.join(dataRoot, 'cache', 'voices')
    this.libraryFile = path.join(dataRoot, 'voice-library.json')
  }

  listHistory(): HistoryEntry[] {
    const stored = readJson<StoredHistory[]>(this.historyFile, [])
    return stored
      .map((entry) => ({ ...entry, filePath: absolutePath(this.dataRoot, entry.fileRel) }))
      .filter((entry) => fs.existsSync(entry.filePath))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  addHistory(entry: HistoryEntry): HistoryEntry[] {
    const stored = readJson<StoredHistory[]>(this.historyFile, [])
    const next: StoredHistory = {
      ...entry,
      fileRel: relativePath(this.dataRoot, entry.filePath)
    }
    const merged = [next, ...stored.filter((item) => item.id !== entry.id)].slice(0, 300)
    writeJson(this.historyFile, merged)
    return this.listHistory()
  }

  updateHistory(id: string, patch: Partial<Omit<HistoryEntry, 'id' | 'filePath'>>): void {
    const stored = readJson<StoredHistory[]>(this.historyFile, [])
    const i = stored.findIndex((item) => item.id === id)
    if (i < 0) return
    stored[i] = { ...stored[i], ...patch }
    writeJson(this.historyFile, stored)
  }

  removeHistory(id: string): HistoryEntry[] {
    return this.removeHistoryMany([id])
  }

  removeHistoryMany(ids: string[]): HistoryEntry[] {
    const removeSet = new Set(ids)
    const stored = readJson<StoredHistory[]>(this.historyFile, [])
    for (const entry of stored) {
      if (!removeSet.has(entry.id)) continue
      try {
        const audioAbs = absolutePath(this.dataRoot, entry.fileRel)
        fs.rmSync(audioAbs, { force: true })
        for (const side of sidecarPaths(audioAbs)) fs.rmSync(side, { force: true })
      } catch {
        // ignore
      }
    }
    writeJson(
      this.historyFile,
      stored.filter((item) => !removeSet.has(item.id))
    )
    return this.listHistory()
  }

  exportHistory(ids: string[], targetDir: string): string[] {
    const selected = new Set(ids)
    const entries = this.listHistory().filter((entry) => selected.has(entry.id))
    fs.mkdirSync(targetDir, { recursive: true })
    const copied: string[] = []
    for (const entry of entries) {
      const parsed = path.parse(entry.filePath)
      let target = path.join(targetDir, parsed.base)
      let index = 1
      while (fs.existsSync(target)) {
        target = path.join(targetDir, `${parsed.name}（${index++}）${parsed.ext}`)
      }
      try {
        fs.copyFileSync(entry.filePath, target)
        copied.push(target)
      } catch {
        // ignore individual copy failures
      }
    }
    const manifest = targetDir
      ? path.join(targetDir, `history-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
      : ''
    if (manifest) {
      fs.writeFileSync(manifest, JSON.stringify(entries, null, 2), 'utf-8')
    }
    return copied
  }

  clearHistory(): void {
    const stored = readJson<StoredHistory[]>(this.historyFile, [])
    for (const entry of stored) {
      try {
        const audioAbs = absolutePath(this.dataRoot, entry.fileRel)
        fs.rmSync(audioAbs, { force: true })
        for (const side of sidecarPaths(audioAbs)) fs.rmSync(side, { force: true })
      } catch {
        // ignore
      }
    }
    writeJson(this.historyFile, [])
  }

  listVoices(): Voice[] {
    this.ensureMigrated()
    const usage = this.readUsage().lastUsedAt
    const voices: Voice[] = []
    for (const file of this.packageFiles()) {
      const manifest = readVoiceMeta(file)
      if (!manifest) continue
      const id = path.basename(file, path.extname(file))
      voices.push({
        id,
        name: manifest.name,
        audioPath: this.cachedAudioPath(id, manifest.audioExt),
        packagePath: file,
        transcript: manifest.transcript,
        promptLang: manifest.promptLang,
        duration: manifest.duration,
        createdAt: manifest.createdAt,
        originalName: manifest.originalName,
        folder: this.folderOf(file),
        lastUsedAt: usage[id]
      })
    }
    return voices.sort((a, b) => b.createdAt - a.createdAt)
  }

  library(): VoiceLibrary {
    const voices = this.listVoices()
    const counts = new Map<string, number>()
    for (const voice of voices) counts.set(voice.folder, (counts.get(voice.folder) || 0) + 1)
    const folders: VoiceFolderInfo[] = this.folderPaths().map((folder) => ({
      path: folder,
      name: folder.slice(folder.lastIndexOf('/') + 1),
      parent: folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '',
      depth: folder.split('/').length - 1,
      voiceCount: counts.get(folder) || 0
    }))
    return { voices, folders }
  }

  touchVoice(id: string): void {
    if (!this.fileForId(id)) return
    const usage = this.readUsage()
    usage.lastUsedAt[id] = Date.now()
    this.writeUsage(usage)
  }

  voiceAudio(id: string): string {
    const file = this.fileForId(id)
    if (!file) throw new Error('音色不存在，可能已经被删除')
    const parsed = readVoicePackage(file)
    if (!parsed || parsed.audio.length === 0) throw new Error('音色包损坏，无法读取参考音频')
    const audio = this.ensureCachedAudio(id, file, parsed)
    if (!audio) throw new Error('无法解包音色参考音频')
    return audio
  }

  folderAbsolutePath(folder: string): string {
    return this.folderAbsolute(folder)
  }

  createFolder(parent: string, name: string): VoiceLibrary {
    const parentPath = this.folderAbsolute(normalizeFolder(parent))
    const folderName = safeFolderName(name)
    const target = path.join(parentPath, folderName)
    this.assertFolderInside(target)
    if (fs.existsSync(target)) throw new Error('同一位置已存在同名文件夹')
    fs.mkdirSync(target)
    return this.library()
  }

  renameFolder(folder: string, name: string): VoiceLibrary {
    const current = normalizeFolder(folder)
    if (!current) throw new Error('不能重命名根目录')
    const source = this.folderAbsolute(current)
    this.assertFolderInside(source)
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('文件夹不存在')
    const target = path.join(path.dirname(source), safeFolderName(name))
    this.assertFolderInside(target)
    if (path.resolve(target) === path.resolve(source)) return this.library()
    if (fs.existsSync(target)) throw new Error('同一位置已存在同名文件夹')
    fs.renameSync(source, target)
    return this.library()
  }

  removeFolder(folder: string): VoiceLibrary {
    const current = normalizeFolder(folder)
    if (!current) throw new Error('不能删除根目录')
    const target = this.folderAbsolute(current)
    this.assertFolderInside(target)
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error('文件夹不存在')
    if (fs.readdirSync(target).length > 0) throw new Error('文件夹不为空，请先移动或删除其中的音色和子文件夹')
    fs.rmdirSync(target)
    return this.library()
  }

  moveVoice(id: string, folder: string): VoiceLibrary {
    const file = this.fileForId(id)
    if (!file) throw new Error('音色不存在，可能已经被删除')
    const targetDir = this.folderAbsolute(normalizeFolder(folder))
    this.assertFolderInside(targetDir)
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) throw new Error('目标文件夹不存在')
    const target = path.join(targetDir, path.basename(file))
    if (path.resolve(target) === path.resolve(file)) return this.library()
    if (fs.existsSync(target)) throw new Error('目标文件夹已有同名音色')
    fs.renameSync(file, target)
    return this.library()
  }

  importVoice(payload: {
    sourcePath: string
    name: string
    transcript: string
    promptLang: string
    duration: number
    originalName?: string
    folder?: string
  }): Voice[] {
    this.ensureMigrated()
    const audio = fs.readFileSync(payload.sourcePath)
    const name = payload.name.trim() || '未命名音色'
    const existing = this.findByName(name)
    const file = existing ? existing.file : this.uniqueFilePath(name, null, normalizeFolder(payload.folder))
    const manifest: VoiceManifest = {
      format: VOICE_FORMAT,
      version: VOICE_VERSION,
      name,
      transcript: payload.transcript,
      promptLang: normalizeLang(payload.promptLang),
      duration: payload.duration,
      createdAt: existing?.manifest.createdAt || Date.now(),
      originalName: payload.originalName || path.basename(payload.sourcePath),
      audioExt: normalizeExt(path.extname(payload.sourcePath))
    }
    writeVoicePackage(file, manifest, audio)
    this.clearCachedAudio(path.basename(file, path.extname(file)))
    return this.listVoices()
  }

  updateVoice(
    id: string,
    patch: Partial<Pick<Voice, 'name' | 'transcript' | 'promptLang' | 'duration'>>
  ): Voice[] {
    const file = this.fileForId(id)
    if (!file) return this.listVoices()
    const parsed = readVoicePackage(file)
    if (!parsed) return this.listVoices()
    const nextName = patch.name?.trim() || parsed.manifest.name
    const target = nextName === parsed.manifest.name ? file : this.uniqueFilePath(nextName, file)
    const manifest: VoiceManifest = {
      ...parsed.manifest,
      ...patch,
      name: nextName,
      promptLang: patch.promptLang ? normalizeLang(patch.promptLang) : parsed.manifest.promptLang
    }
    writeVoicePackage(target, manifest, parsed.audio)
    if (target !== file) {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        // ignore
      }
    }
    this.clearCachedAudio(id)
    const newId = path.basename(target, path.extname(target))
    if (newId !== id) {
      const usage = this.readUsage()
      if (usage.lastUsedAt[id]) {
        usage.lastUsedAt[newId] = usage.lastUsedAt[id]
        delete usage.lastUsedAt[id]
        this.writeUsage(usage)
      }
    }
    return this.listVoices()
  }

  removeVoice(id: string): Voice[] {
    const file = this.fileForId(id)
    if (file) {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        // ignore
      }
    }
    this.clearCachedAudio(id)
    const usage = this.readUsage()
    if (usage.lastUsedAt[id]) {
      delete usage.lastUsedAt[id]
      this.writeUsage(usage)
    }
    return this.listVoices()
  }

  exportVoice(id: string, targetFile: string): string {
    const file = this.fileForId(id)
    if (!file) throw new Error('音色不存在，可能已经被删除')
    const target = path.extname(targetFile).toLowerCase() === VOICE_EXT ? targetFile : `${targetFile}${VOICE_EXT}`
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (path.resolve(target) === path.resolve(file)) return file
    fs.copyFileSync(file, target)
    return target
  }

  importVoiceFiles(files: string[], folder = ''): VoiceImportResult {
    this.ensureMigrated()
    let imported = 0
    let skipped = 0
    const targetFolder = normalizeFolder(folder)
    for (const file of files) {
      if (path.extname(file).toLowerCase() !== VOICE_EXT || this.isInsideVoices(file)) {
        skipped += 1
        continue
      }
      const parsed = readVoicePackage(file)
      if (!parsed || parsed.audio.length === 0) {
        skipped += 1
        continue
      }
      try {
        const target = this.uniqueFilePath(parsed.manifest.name, null, targetFolder)
        writeVoicePackage(target, parsed.manifest, parsed.audio)
        imported += 1
      } catch {
        skipped += 1
      }
    }
    return { voices: this.listVoices(), imported, skipped }
  }

  private ensureMigrated(): void {
    if (this.migrated) return
    this.migrated = true
    const stored = readJson<StoredVoice[] | null>(this.voicesFile, null)
    if (!Array.isArray(stored)) return
    if (stored.length === 0) {
      this.retireLegacyIndex()
      return
    }
    let allOk = true
    for (const voice of stored) {
      try {
        const audioPath = absolutePath(this.dataRoot, voice.audioRel)
        if (!fs.existsSync(audioPath)) continue
        const already = this.findByName(voice.name)
        const migratedAlready = already && already.manifest.createdAt === voice.createdAt
        if (!migratedAlready) {
          const file = this.uniqueFilePath(voice.name, null)
          const manifest: VoiceManifest = {
            format: VOICE_FORMAT,
            version: VOICE_VERSION,
            name: voice.name,
            transcript: voice.transcript,
            promptLang: normalizeLang(voice.promptLang),
            duration: voice.duration,
            createdAt: voice.createdAt,
            originalName: voice.originalName || path.basename(audioPath),
            audioExt: normalizeExt(path.extname(audioPath))
          }
          writeVoicePackage(file, manifest, fs.readFileSync(audioPath))
        }
        const folder = path.dirname(audioPath)
        if (path.resolve(folder) !== path.resolve(this.voicesDir) && this.isInsideVoices(folder)) {
          try { fs.rmdirSync(folder) } catch {}
        }
      } catch {
        allOk = false
      }
    }
    if (allOk) this.retireLegacyIndex()
  }

  private retireLegacyIndex(): void {
    try {
      if (fs.existsSync(this.voicesFile)) {
        const backup = path.join(this.dataRoot, `voices-legacy-${Date.now()}.json`)
        fs.renameSync(this.voicesFile, backup)
      }
    } catch {
      // ignore
    }
  }

  private packageFiles(): string[] {
    const files: string[] = []
    const walk = (dir: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (entry.isFile() && path.extname(entry.name).toLowerCase() === VOICE_EXT) files.push(full)
        }
      } catch {
        // ignore unreadable folders
      }
    }
    walk(this.voicesDir)
    return files
  }

  private folderPaths(): string[] {
    const folders: string[] = []
    const walk = (dir: string, prefix: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name
          folders.push(rel)
          walk(path.join(dir, entry.name), rel)
        }
      } catch {
        // ignore
      }
    }
    walk(this.voicesDir, '')
    return folders
  }

  private folderOf(file: string): string {
    const rel = path.relative(this.voicesDir, path.dirname(file))
    return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : ''
  }

  private folderAbsolute(folder: string): string {
    const normalized = normalizeFolder(folder)
    const target = normalized ? path.join(this.voicesDir, ...normalized.split('/')) : this.voicesDir
    this.assertFolderInside(target)
    return target
  }

  private assertFolderInside(target: string): void {
    if (!this.isInsideVoices(target)) throw new Error('文件夹路径超出音色库范围')
  }

  private findByName(name: string): { file: string; manifest: VoiceManifest } | null {
    const target = name.trim()
    for (const file of this.packageFiles()) {
      const manifest = readVoiceMeta(file)
      if (manifest && manifest.name === target) return { file, manifest }
    }
    return null
  }

  private uniqueFilePath(name: string, currentFile: string | null, folder = ''): string {
    const base = safeName(name)
    const dir = currentFile ? path.dirname(currentFile) : this.folderAbsolute(folder)
    const currentBase = currentFile ? path.basename(currentFile).toLowerCase() : ''
    const taken = new Set(this.packageFiles().map((file) => path.basename(file).toLowerCase()))
    let candidate = path.join(dir, `${base}${VOICE_EXT}`)
    let index = 1
    while (taken.has(path.basename(candidate).toLowerCase()) && path.basename(candidate).toLowerCase() !== currentBase) {
      candidate = path.join(dir, `${base}（${index++}）${VOICE_EXT}`)
    }
    return candidate
  }

  private fileForId(id: string): string | null {
    return this.packageFiles().find((file) => path.basename(file, path.extname(file)) === id) || null
  }

  private cachedAudioPath(id: string, ext: string): string {
    return path.join(this.voiceCacheDir, `${id}${ext}`)
  }

  private readUsage(): VoiceUsage {
    const raw = readJson<Partial<VoiceUsage>>(this.libraryFile, {})
    return {
      version: 1,
      lastUsedAt: raw.lastUsedAt && typeof raw.lastUsedAt === 'object' ? raw.lastUsedAt : {}
    }
  }

  private writeUsage(usage: VoiceUsage): void {
    writeJson(this.libraryFile, { version: 1, lastUsedAt: usage.lastUsedAt })
  }

  private isInsideVoices(target: string): boolean {
    const rel = path.relative(path.resolve(this.voicesDir), path.resolve(target))
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }

  private ensureCachedAudio(
    id: string,
    packageFile: string,
    parsed: { manifest: VoiceManifest; audio: Buffer }
  ): string {
    const target = this.cachedAudioPath(id, parsed.manifest.audioExt)
    let fresh = false
    try {
      const pkgStat = fs.statSync(packageFile)
      const cacheStat = fs.statSync(target)
      fresh = cacheStat.size === parsed.audio.length && cacheStat.mtimeMs >= pkgStat.mtimeMs
    } catch {
      fresh = false
    }
    if (fresh) return target
    try {
      fs.mkdirSync(this.voiceCacheDir, { recursive: true })
      this.clearCachedAudio(id)
      fs.writeFileSync(target, parsed.audio)
      return target
    } catch {
      return ''
    }
  }

  private clearCachedAudio(id: string): void {
    try {
      for (const name of fs.readdirSync(this.voiceCacheDir)) {
        if (name.startsWith(`${id}.`)) {
          fs.rmSync(path.join(this.voiceCacheDir, name), { force: true })
        }
      }
    } catch {
      // ignore
    }
  }
}
