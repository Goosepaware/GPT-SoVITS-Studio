import fs from 'node:fs'
import path from 'node:path'
import type { HistoryEntry, Voice } from '@shared/types'
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

export class Storage {
  private voiceCacheDir: string
  private migrated = false

  constructor(
    private dataRoot: string,
    private historyFile: string,
    private voicesFile: string,
    private voicesDir: string
  ) {
    this.voiceCacheDir = path.join(dataRoot, 'cache', 'voices')
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
    const voices: Voice[] = []
    for (const file of this.packageFiles()) {
      const parsed = readVoicePackage(file)
      if (!parsed || parsed.audio.length === 0) continue
      const id = path.basename(file, path.extname(file))
      const audioPath = this.ensureCachedAudio(id, file, parsed)
      if (!audioPath) continue
      voices.push({
        id,
        name: parsed.manifest.name,
        audioPath,
        packagePath: file,
        transcript: parsed.manifest.transcript,
        promptLang: parsed.manifest.promptLang,
        duration: parsed.manifest.duration,
        createdAt: parsed.manifest.createdAt,
        originalName: parsed.manifest.originalName
      })
    }
    return voices.sort((a, b) => b.createdAt - a.createdAt)
  }

  importVoice(payload: {
    sourcePath: string
    name: string
    transcript: string
    promptLang: string
    duration: number
    originalName?: string
  }): Voice[] {
    this.ensureMigrated()
    const audio = fs.readFileSync(payload.sourcePath)
    const name = payload.name.trim() || '未命名音色'
    const existing = this.findByName(name)
    const file = existing ? existing.file : this.uniqueFilePath(name, null)
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

  importVoiceFiles(files: string[]): VoiceImportResult {
    this.ensureMigrated()
    let imported = 0
    let skipped = 0
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
        const target = this.uniqueFilePath(parsed.manifest.name, null)
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
          fs.rmSync(folder, { recursive: true, force: true })
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
    try {
      return fs
        .readdirSync(this.voicesDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === VOICE_EXT)
        .map((entry) => path.join(this.voicesDir, entry.name))
    } catch {
      return []
    }
  }

  private findByName(name: string): { file: string; manifest: VoiceManifest } | null {
    const target = name.trim()
    for (const file of this.packageFiles()) {
      const parsed = readVoicePackage(file)
      if (parsed && parsed.manifest.name === target) return { file, manifest: parsed.manifest }
    }
    return null
  }

  private uniqueFilePath(name: string, currentFile: string | null): string {
    const base = safeName(name)
    const current = currentFile ? path.resolve(currentFile) : ''
    let candidate = path.join(this.voicesDir, `${base}${VOICE_EXT}`)
    let index = 1
    while (fs.existsSync(candidate) && path.resolve(candidate) !== current) {
      candidate = path.join(this.voicesDir, `${base}（${index++}）${VOICE_EXT}`)
    }
    return candidate
  }

  private fileForId(id: string): string | null {
    const candidate = path.join(this.voicesDir, `${id}${VOICE_EXT}`)
    if (fs.existsSync(candidate)) return candidate
    const match = this.packageFiles().find((file) => path.basename(file, path.extname(file)) === id)
    return match || null
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
    const target = path.join(this.voiceCacheDir, `${id}${parsed.manifest.audioExt}`)
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
