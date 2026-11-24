import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, dialog, ipcMain, shell, type BrowserWindowConstructorOptions } from 'electron'
import type {
  AppConfig,
  AsrFileResult,
  Bootstrap,
  EngineName,
  EngineStatus,
  GpuInfo,
  HistoryEntry,
  SubtitleFormat,
  TtsResult,
  Voice,
  WorkerEvent
} from '@shared/types'
import { loadConfig, saveConfig } from './config'
import { exportMp3, formatAsrFile, getDuration, mimeForFile, prepareReference } from './media'
import { scanModels } from './models'
import { getAppPaths, engineMissing, isEngineRoot, type AppPaths } from './paths'
import { PythonWorker } from './pythonWorker'
import { Storage } from './storage'
import { McpServer } from './mcp/server'
import { McpTools, type ToolHost } from './mcp/tools'
import { agentSetupPrompt, clientSnippet, configureClient, ensureBridge, listClients, type BridgeInfo } from './mcp/clients'
import { randomToken } from './config'
import { Menu, Tray, nativeImage } from 'electron'
import type { McpStatus } from '@shared/types'
import { SUBTITLE_EXT, hasTiming, subtitleFileName, writeSubtitle, writeSubtitles } from './subtitles'

const execFileAsync = promisify(execFile)

app.setName('GPT-SoVITS-Studio')
if (process.platform === 'win32') app.setAppUserModelId('local.gptsovits.studio')

// On some Windows machines (system ACLs altered by cleanup tools, or AV/optimizer
// DLL injection) the sandboxed GPU child process fails with STATUS_DLL_NOT_FOUND
// (0xC0000135) and Electron exits silently. Run GPU in the browser process; the
// renderer sandbox stays enabled. Set GSV_SEPARATE_GPU=1 to restore the default.
if (process.platform === 'win32' && !process.env.GSV_SEPARATE_GPU) {
  app.commandLine.appendSwitch('in-process-gpu')
}

let paths: AppPaths
let config: AppConfig
let storage: Storage
let mainWindow: BrowserWindow | null = null
let ttsWorker: PythonWorker | null = null
let asrWorker: PythonWorker | null = null
let quitting = false
let gpuInfo: GpuInfo | null = null
let gpuTimer: NodeJS.Timeout | null = null
let idleTimer: NodeJS.Timeout | null = null
const lastActivity: Record<EngineName, number> = { tts: Date.now(), asr: Date.now() }

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma'])

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function notice(engine: EngineName, message: string, tone: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
  send('engine:event', { type: 'notice', engine, message, tone } satisfies WorkerEvent)
}

function makeBootstrap(): Bootstrap {
  const missing = engineMissing(config.engineRoot)
  return {
    config,
    validation: {
      root: config.engineRoot,
      valid: Boolean(config.engineRoot) && missing.length === 0 && isEngineRoot(config.engineRoot),
      missing,
      runtime: config.engineRoot ? path.join(config.engineRoot, 'runtime', 'python.exe') : ''
    },
    models: config.engineRoot ? scanModels(config.engineRoot) : { tts: { gpt: [], sovits: [] }, asr: { sensevoice: null, vad: null } },
    version: app.getVersion(),
    appRoot: paths.appRoot,
    dataRoot: paths.dataRoot
  }
}

function attachWorker(worker: PythonWorker): void {
  worker.on('event', (event: WorkerEvent) => {
    if (event.type === 'status') {
      const status = event.status || {}
      if (status.state === 'ready' || status.state === 'busy') lastActivity[worker.engine] = Date.now()
      if (status.state === 'stopped') lastActivity[worker.engine] = Date.now()
    }
    if (event.type === 'stage' || event.type === 'progress') {
      lastActivity[worker.engine] = Date.now()
    }
    send('engine:event', event)
  })
}

function ensureTtsWorker(): PythonWorker {
  if (!config.engineRoot || !isEngineRoot(config.engineRoot)) {
    throw new Error('引擎目录无效，请先在设置中选择 GPT-SoVITS 整合包目录')
  }
  if (!ttsWorker) {
    ttsWorker = new PythonWorker({
      engine: 'tts',
      engineRoot: config.engineRoot,
      pythonDir: paths.pythonDir,
      dataDir: path.join(paths.dataRoot, 'tts'),
      logsDir: paths.logsDir,
      script: 'tts_worker.py'
    })
    attachWorker(ttsWorker)
  }
  return ttsWorker
}

function ensureAsrWorker(): PythonWorker {
  if (!config.engineRoot || !isEngineRoot(config.engineRoot)) {
    throw new Error('引擎目录无效，请先在设置中选择 GPT-SoVITS 整合包目录')
  }
  if (!asrWorker) {
    asrWorker = new PythonWorker({
      engine: 'asr',
      engineRoot: config.engineRoot,
      pythonDir: paths.pythonDir,
      dataDir: path.join(paths.dataRoot, 'asr'),
      logsDir: paths.logsDir,
      script: 'asr_worker.py'
    })
    attachWorker(asrWorker)
  }
  return asrWorker
}

async function unloadOther(target: EngineName, reason: string): Promise<void> {
  if (!config.autoUnloadOnSwitch) return
  if (target === 'tts') {
    if (asrWorker && asrWorker.status.state !== 'stopped') {
      await asrWorker.unload('为 TTS 释放显存')
      notice('asr', `${reason}：已卸载 ASR，释放语音识别占用的显存`, 'info')
    }
  } else if (ttsWorker && ttsWorker.status.state !== 'stopped') {
    await ttsWorker.unload('为 ASR 释放显存')
    notice('tts', `${reason}：已卸载 TTS，释放语音合成占用的显存`, 'info')
  }
}

function audioFilesInFolder(folder: string): string[] {
  const result: string[] = []
  const walk = (dir: string): void => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) result.push(full)
      }
    } catch {
      // ignore
    }
  }
  walk(folder)
  return result.sort()
}

function sanitizeFileName(text: string): string {
  const cleaned = text
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[.。！？!?，,、；;：:\s]+$/g, '')
    .trim()
  if (!cleaned) return '语音'
  const chars = Array.from(cleaned)
  const clipped = chars.length > 15 ? `${chars.slice(0, 15).join('')}…` : cleaned
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clipped) ? `_${clipped}` : clipped
}

function outputFile(text: string): string {
  fs.mkdirSync(config.outputDir, { recursive: true })
  const base = sanitizeFileName(text)
  let candidate = path.join(config.outputDir, `${base}.wav`)
  let index = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(config.outputDir, `${base}（${index++}）.wav`)
  }
  return candidate
}

async function pollGpu(): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'],
      { windowsHide: true, maxBuffer: 1024 * 1024 }
    )
    const line = stdout.split(/\r?\n/).find((item) => item.trim())
    if (!line) throw new Error('no gpu')
    const [name, total, used, util] = line.split(',').map((item) => item.trim())
    gpuInfo = {
      name,
      memoryTotalMB: Number(total) || 0,
      memoryUsedMB: Number(used) || 0,
      utilization: Number.isFinite(Number(util)) ? Number(util) : null,
      updatedAt: Date.now()
    }
    send('gpu:update', gpuInfo)
  } catch {
    gpuInfo = null
    send('gpu:update', null)
  }
}

function startGpuMonitor(): void {
  if (gpuTimer) clearInterval(gpuTimer)
  void pollGpu()
  gpuTimer = setInterval(() => void pollGpu(), 3000)
}

function startIdleMonitor(): void {
  if (idleTimer) clearInterval(idleTimer)
  idleTimer = setInterval(async () => {
    const minutes = Number(config.idleUnloadMinutes) || 0
    if (minutes <= 0) return
    const now = Date.now()
    if (ttsWorker && ttsWorker.status.state === 'ready' && now - lastActivity.tts > minutes * 60_000) {
      await ttsWorker.unload(`空闲 ${minutes} 分钟，自动释放显存`)
      notice('tts', `TTS 空闲 ${minutes} 分钟，已自动卸载并释放显存`, 'info')
    }
    if (asrWorker && asrWorker.status.state === 'ready' && now - lastActivity.asr > minutes * 60_000) {
      await asrWorker.unload(`空闲 ${minutes} 分钟，自动释放显存`)
      notice('asr', `ASR 空闲 ${minutes} 分钟，已自动卸载并释放显存`, 'info')
    }
  }, 30_000)
}

function registerIpc(): void {
  ipcMain.handle('app:bootstrap', () => makeBootstrap())
  ipcMain.handle('app:refresh-bootstrap', () => makeBootstrap())
  ipcMain.handle('app:update-config', (_event, patch: Partial<AppConfig>) => {
    const previousRoot = config.engineRoot
    const next: AppConfig = { ...config, ...patch }
    if (next.engineRoot) {
      next.engineRoot = path.resolve(next.engineRoot)
    }
    if (!next.outputDir) next.outputDir = paths.outputDir
    config = next
    saveConfig(config)
    fs.mkdirSync(config.outputDir, { recursive: true })
    void applyMcp()
    if (previousRoot !== config.engineRoot) {
      void ttsWorker?.unload('切换引擎目录')
      void asrWorker?.unload('切换引擎目录')
      ttsWorker = null
      asrWorker = null
    }
    return makeBootstrap()
  })

  ipcMain.handle('dialog:directory', async (_event, title?: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: title || '选择目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:audio', async (_event, multiple = true) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择音频',
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: '音频', extensions: ['wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus'] }]
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dialog:asr-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择音频文件夹',
      properties: ['openDirectory']
    })
    return result.canceled ? [] : audioFilesInFolder(result.filePaths[0])
  })

  ipcMain.handle('audio:prepare-reference', async (_event, sourcePath: string) => {
    return prepareReference(config.engineRoot, sourcePath, paths.tempDir)
  })

  ipcMain.handle('audio:read', async (_event, filePath: string) => {
    if (!fs.existsSync(filePath)) throw new Error('音频文件不存在')
    const data = fs.readFileSync(filePath)
    return { data: new Uint8Array(data), mime: mimeForFile(filePath) }
  })

  ipcMain.handle('audio:export-mp3', async (_event, sourcePath: string) => exportMp3(config.engineRoot, sourcePath))

  ipcMain.handle('subtitle:export', async (_event, sourcePath: string, format?: SubtitleFormat) => {
    if (!hasTiming(sourcePath)) throw new Error('这条记录没有时间轴（旧版本生成），请重新生成后再导出字幕')
    const fmt = format || config.subtitle.defaultFormat
    const ext = SUBTITLE_EXT[fmt]
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '导出字幕',
      defaultPath: path.join(path.dirname(sourcePath), subtitleFileName(sourcePath, fmt)),
      filters: [{ name: fmt.toUpperCase(), extensions: [ext.split('.').pop() as string] }]
    })
    if (result.canceled || !result.filePath) return null
    return writeSubtitle(sourcePath, result.filePath, fmt, config.subtitle)
  })

  ipcMain.handle('subtitle:export-many', async (_event, sourcePaths: string[], formats?: SubtitleFormat[]) => {
    const fmts = formats && formats.length ? formats : [config.subtitle.defaultFormat]
    const result = await dialog.showOpenDialog(mainWindow!, { title: '选择字幕导出文件夹', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    const dir = result.filePaths[0]
    let written = 0
    let skipped = 0
    for (const src of sourcePaths) {
      if (!hasTiming(src)) {
        skipped++
        continue
      }
      writeSubtitles(src, fmts, config.subtitle, dir)
      written++
    }
    return { dir, written, skipped }
  })

  ipcMain.handle('asr:save-results', async (_event, payload: { items: AsrFileResult[]; format: 'list' | 'txt'; suggestedName: string }) => {
    const ext = payload.format
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '导出识别结果',
      defaultPath: path.join(config.outputDir, `${payload.suggestedName}.${ext}`),
      filters: [{ name: ext === 'list' ? '标注文件' : '文本文件', extensions: [ext] }]
    })
    if (result.canceled || !result.filePath) return null
    fs.writeFileSync(result.filePath, formatAsrFile(payload.items, payload.format), 'utf-8')
    return result.filePath
  })

  ipcMain.handle('shell:open', async (_event, target: string) => {
    if (fs.existsSync(target)) {
      await shell.openPath(target)
    }
  })

  ipcMain.handle('shell:reveal', (_event, target: string) => {
    if (fs.existsSync(target)) shell.showItemInFolder(target)
  })

  ipcMain.handle('tts:load', async (_event, options: { gptPath: string; sovitsPath: string }) => {
    await unloadOther('tts', '开始语音合成')
    const worker = ensureTtsWorker()
    if (worker.status.state === 'busy') throw new Error('正在生成语音，请稍候')
    const same =
      worker.status.state === 'ready' &&
      worker.status.models.gpt === options.gptPath &&
      worker.status.models.sovits === options.sovitsPath
    if (same) return worker.status
    lastActivity.tts = Date.now()
    return worker.request<EngineStatus>(
      'load',
      {
        gptPath: options.gptPath,
        sovitsPath: options.sovitsPath,
        device: config.device,
        half: config.half
      },
      10 * 60 * 1000
    )
  })

  ipcMain.handle('tts:unload', async () => {
    if (ttsWorker) await ttsWorker.unload('手动卸载 TTS')
  })

  ipcMain.handle('tts:synthesize', (_event, options: Record<string, unknown>) => {
    const worker = ensureTtsWorker()
    if (worker.status.state !== 'ready' && worker.status.state !== 'busy') {
      throw new Error('TTS 模型尚未加载，请先点击“加载模型”')
    }
    // UI jobs jump ahead of queued agent jobs.
    return gpuQueue(() => doSynthesize(options), true)
  })

  registerMcpIpc()

  ipcMain.handle('tts:cancel', () => {
    ttsWorker?.send('cancel')
  })

  ipcMain.handle('tts:status', () => ttsWorker?.getStatus() || { engine: 'tts', state: 'stopped', models: {} })

  ipcMain.handle('asr:load', async () => {
    const catalog = scanModels(config.engineRoot)
    const selected = catalog.asr.sensevoice
    const vad = catalog.asr.vad
    if (!selected) throw new Error('SenseVoice 模型未找到')
    if (!vad) throw new Error('FSMN-VAD 模型未找到')
    await unloadOther('asr', '开始语音识别')
    const worker = ensureAsrWorker()
    if (worker.status.state === 'busy') throw new Error('正在识别，请稍候')
    const same = worker.status.state === 'ready' && worker.status.models.asr === selected.path
    if (same) return worker.status
    lastActivity.asr = Date.now()
    return worker.request<EngineStatus>(
      'load',
      {
        model: 'sensevoice',
        modelPath: selected.path,
        vadPath: vad.path,
        device: config.device.startsWith('cuda') ? 'cuda' : 'cpu'
      },
      10 * 60 * 1000
    )
  })

  ipcMain.handle('asr:unload', async () => {
    if (asrWorker) await asrWorker.unload('手动卸载 ASR')
  })

  ipcMain.handle('asr:transcribe', async (_event, options: { files: string[]; language: string }) => {
    const worker = ensureAsrWorker()
    if (worker.status.state !== 'ready') throw new Error('ASR 模型尚未加载')
    await unloadOther('asr', '开始识别')
    lastActivity.asr = Date.now()
    return worker.request<AsrFileResult[]>('transcribe', options, 60 * 60 * 1000)
  })

  ipcMain.handle('asr:cancel', () => {
    asrWorker?.send('cancel')
  })

  ipcMain.handle('asr:status', () => asrWorker?.getStatus() || { engine: 'asr', state: 'stopped', models: {} })

  ipcMain.handle('history:list', () => storage.listHistory())
  ipcMain.handle('history:remove', (_event, id: string) => storage.removeHistory(id))
  ipcMain.handle('history:remove-many', (_event, ids: string[]) => storage.removeHistoryMany(ids))
  ipcMain.handle('history:export', async (_event, ids: string[]) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择导出文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const copied = storage.exportHistory(ids, result.filePaths[0])
    return copied.length ? result.filePaths[0] : null
  })
  ipcMain.handle('history:clear', () => storage.clearHistory())

  ipcMain.handle('voices:list', () => storage.listVoices())
  ipcMain.handle('voices:import', async (_event, payload: { sourcePath: string; name: string; transcript: string; promptLang: string }) => {
    const duration = await getDuration(config.engineRoot, payload.sourcePath)
    return storage.importVoice({
      ...payload,
      duration,
      originalName: path.basename(payload.sourcePath)
    })
  })
  ipcMain.handle('voices:update', (_event, id: string, patch: Partial<Pick<Voice, 'name' | 'transcript' | 'promptLang' | 'duration'>>) =>
    storage.updateVoice(id, patch)
  )
  ipcMain.handle('voices:remove', (_event, id: string) => storage.removeVoice(id))
  ipcMain.handle('voices:open-folder', async () => {
    fs.mkdirSync(paths.voicesDir, { recursive: true })
    await shell.openPath(paths.voicesDir)
  })
  ipcMain.handle('voices:import-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择 .v5t 音色文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'GPT-SoVITS 音色包', extensions: ['v5t'] }]
    })
    if (result.canceled || !result.filePaths.length) return null
    const imported = storage.importVoiceFiles(result.filePaths)
    for (const voice of imported.voices) {
      if (voice.duration > 0) continue
      try {
        const duration = await getDuration(config.engineRoot, voice.audioPath)
        if (duration > 0) storage.updateVoice(voice.id, { duration })
      } catch {
        // Duration is optional for imported packages.
      }
    }
    return { ...imported, voices: storage.listVoices() }
  })
  ipcMain.handle('voices:export', async (_event, id: string) => {
    const voice = storage.listVoices().find((item) => item.id === id)
    if (!voice) throw new Error('音色不存在，可能已经被删除')
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '导出 .v5t 音色包',
      defaultPath: path.basename(voice.packagePath),
      filters: [{ name: 'GPT-SoVITS 音色包', extensions: ['v5t'] }]
    })
    if (result.canceled || !result.filePath) return null
    return storage.exportVoice(id, result.filePath)
  })

  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow?.close())
}

async function createWindow(): Promise<void> {
  const iconPath = app.isPackaged ? path.join(process.resourcesPath, 'icon.ico') : path.join(paths.appRoot, 'resources', 'icon.ico')
  const windowOptions: BrowserWindowConstructorOptions = {
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    frame: false,
    backgroundColor: '#08090d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  }
  if (fs.existsSync(iconPath)) windowOptions.icon = iconPath
  mainWindow = new BrowserWindow(windowOptions)

  mainWindow.on('maximize', () => send('window:maximized', true))
  mainWindow.on('unmaximize', () => send('window:maximized', false))
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// ---------------------------------------------------------------- GPU queue

const queue: Array<{ run: () => Promise<void>; priority: boolean }> = []
let queueBusy = false

/** Serializes every GPU job (UI + agent). Priority jobs go before queued non-priority ones. */
function gpuQueue<T>(task: () => Promise<T>, priority = false): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const item = { run: () => task().then(resolve, reject), priority }
    const idx = priority ? queue.findIndex((q) => !q.priority) : -1
    if (idx < 0) queue.push(item)
    else queue.splice(idx, 0, item)
    void pumpQueue()
  })
}

async function pumpQueue(): Promise<void> {
  if (queueBusy) return
  queueBusy = true
  try {
    while (queue.length) await queue.shift()!.run().catch(() => undefined)
  } finally {
    queueBusy = false
  }
}

// ------------------------------------------------------------- synthesis core

async function ensureTtsLoaded(gptPath?: string, sovitsPath?: string): Promise<PythonWorker> {
  const worker = ensureTtsWorker()
  const catalog = scanModels(config.engineRoot)
  const gpt = gptPath || worker.status.models.gpt || catalog.tts.gpt.find((m) => m.base)?.path || catalog.tts.gpt[0]?.path
  const sovits = sovitsPath || worker.status.models.sovits || catalog.tts.sovits.find((m) => m.base)?.path || catalog.tts.sovits[0]?.path
  if (!gpt || !sovits) throw new Error('未找到 v5turbo 模型')
  await unloadOther('tts', 'agent 合成')
  if (worker.status.state === 'ready' && worker.status.models.gpt === gpt && worker.status.models.sovits === sovits) return worker
  await worker.request<EngineStatus>('load', { gptPath: gpt, sovitsPath: sovits, device: config.device, half: config.half }, 10 * 60 * 1000)
  return worker
}

async function ensureAsrLoaded(): Promise<PythonWorker> {
  const catalog = scanModels(config.engineRoot)
  const selected = catalog.asr.sensevoice
  const vad = catalog.asr.vad
  if (!selected || !vad) throw new Error('SenseVoice / VAD 模型未找到')
  await unloadOther('asr', 'agent 识别')
  const worker = ensureAsrWorker()
  if (worker.status.state === 'ready' && worker.status.models.asr === selected.path) return worker
  await worker.request<EngineStatus>(
    'load',
    { model: 'sensevoice', modelPath: selected.path, vadPath: vad.path, device: config.device.startsWith('cuda') ? 'cuda' : 'cpu' },
    10 * 60 * 1000
  )
  return worker
}

async function doSynthesize(options: Record<string, unknown>, outputOverride?: string, viaAgent = false): Promise<TtsResult> {
  const worker = viaAgent
    ? await ensureTtsLoaded(options.gptPath as string | undefined, options.sovitsPath as string | undefined)
    : ensureTtsWorker()
  if (worker.status.state !== 'ready') throw new Error('TTS 模型尚未加载，请先点击“加载模型”')
  if (!viaAgent) await unloadOther('tts', '开始生成')
  lastActivity.tts = Date.now()
  const outputPath = outputOverride || outputFile(String(options.text || ''))
  const result = await worker.request<TtsResult>('synthesize', { ...options, outputPath }, 60 * 60 * 1000)
  const voiceId = String(options.voiceId || '')
  const voice = voiceId ? storage.listVoices().find((item) => item.id === voiceId) : undefined
  const historyEntry: HistoryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    filePath: result.filePath,
    text: String(options.text || ''),
    voiceName: (voice?.name || '临时参考音频') + (viaAgent ? ' · agent' : ''),
    models: path.basename(String(options.sovitsPath || worker.status.models.sovits || 'v5turbo')),
    duration: result.duration,
    createdAt: Date.now(),
    seed: result.seed,
    params: { speed: options.speed, sampleSteps: options.sampleSteps, textLang: options.textLang, promptLang: options.promptLang, seed: result.seed }
  }
  storage.addHistory(historyEntry)
  result.historyId = historyEntry.id
  if (config.subtitle.autoExport && result.timingPath) {
    try {
      writeSubtitles(result.filePath, config.subtitle.autoFormats, config.subtitle)
    } catch (error) {
      result.warnings = [...(result.warnings || []), `自动输出字幕失败：${error instanceof Error ? error.message : String(error)}`]
    }
  }
  if (viaAgent) send('history:changed', null)
  return result
}

// ------------------------------------------------------------------------ MCP

let mcpServer: McpServer | null = null
let bridge: BridgeInfo | null = null
let tray: Tray | null = null
const headless = process.argv.includes('--headless')

function mcpUrl(): string {
  return `http://127.0.0.1:${config.mcp.port}/mcp`
}

/** In dev the exe is electron.exe, so the bridge also needs the app path to relaunch headless. */
function ensureBridgeInfo(): BridgeInfo {
  return ensureBridge(paths.dataRoot, app.getPath('exe'), paths.configFile, app.isPackaged ? undefined : app.getAppPath())
}

function mcpActivity(line: string): void {
  try {
    fs.mkdirSync(paths.logsDir, { recursive: true })
    fs.appendFileSync(path.join(paths.logsDir, 'mcp.log'), `${new Date().toISOString()} ${line}\n`, 'utf-8')
  } catch {
    // logging is best-effort
  }
  send('mcp:activity', line)
}

function buildToolHost(): ToolHost {
  return {
    version: app.getVersion(),
    config: () => config,
    status: () => ({
      tts: ttsWorker?.getStatus() || { state: 'stopped' },
      asr: asrWorker?.getStatus() || { state: 'stopped' },
      gpu: gpuInfo,
      queueLength: queue.length + (queueBusy ? 1 : 0),
      outputDir: config.outputDir,
      voices: storage.listVoices().length
    }),
    models: () => scanModels(config.engineRoot),
    voices: () => storage.listVoices(),
    createVoice: async ({ sourcePath, name, transcript, lang }) => {
      if (!fs.existsSync(sourcePath)) throw new Error(`文件不存在：${sourcePath}`)
      const prepared = await prepareReference(config.engineRoot, sourcePath, paths.tempDir)
      let text = transcript
      let language = lang || 'auto'
      if (!text) {
        const [r] = await gpuQueue(async () => {
          const w = await ensureAsrLoaded()
          lastActivity.asr = Date.now()
          return w.request<AsrFileResult[]>('transcribe', { files: [prepared.path], language: language }, 10 * 60 * 1000)
        })
        if (!r?.ok || !r.text.trim()) throw new Error(`识别参考文本失败：${r?.error || '空结果'}`)
        text = r.text.trim()
        if (language === 'auto' && r.language) language = r.language
      }
      const list = storage.importVoice({
        sourcePath: prepared.path,
        name,
        transcript: text,
        promptLang: language,
        duration: prepared.duration,
        originalName: path.basename(sourcePath)
      })
      send('voices:changed', null)
      const v = list.find((x) => x.name === name.trim())
      if (!v) throw new Error('音色保存失败')
      return v
    },
    removeVoice: (id) => {
      storage.removeVoice(id)
      send('voices:changed', null)
    },
    history: () => storage.listHistory(),
    synthesize: (options, outputPath) => gpuQueue(() => doSynthesize(options, outputPath, true)),
    transcribe: (files, language) =>
      gpuQueue(async () => {
        const w = await ensureAsrLoaded()
        lastActivity.asr = Date.now()
        return w.request<AsrFileResult[]>('transcribe', { files, language }, 60 * 60 * 1000)
      }),
    cancelTts: () => ttsWorker?.send('cancel'),
    audioFilesInFolder,
    activity: mcpActivity
  }
}

function mcpStatus(): McpStatus {
  return {
    running: Boolean(mcpServer?.running),
    port: config.mcp.port,
    url: mcpUrl(),
    error: mcpServer?.error,
    bridgePath: bridge?.script || '',
    clients: listClients()
  }
}

async function applyMcp(): Promise<void> {
  bridge = ensureBridgeInfo()
  if (!mcpServer) mcpServer = new McpServer(new McpTools(buildToolHost()), () => config.mcp.token, app.getVersion())
  // Headless launch from the bridge always serves, even if the toggle is off.
  if (config.mcp.enabled || headless) {
    if (!mcpServer.running || mcpServer.port !== config.mcp.port) await mcpServer.start(config.mcp.port)
  } else {
    await mcpServer.stop()
  }
}

function registerMcpIpc(): void {
  ipcMain.handle('mcp:status', () => mcpStatus())
  ipcMain.handle('mcp:restart', async () => {
    await mcpServer?.stop()
    await applyMcp()
    return mcpStatus()
  })
  ipcMain.handle('mcp:regenerate-token', async () => {
    config = { ...config, mcp: { ...config.mcp, token: randomToken() } }
    saveConfig(config)
    return mcpStatus()
  })
  ipcMain.handle('mcp:configure-client', (_event, id: string) => {
    if (!bridge) bridge = ensureBridgeInfo()
    configureClient(id, bridge, mcpUrl(), config.mcp.token)
    return mcpStatus()
  })
  ipcMain.handle('mcp:snippet', (_event, id: string) => {
    if (!bridge) bridge = ensureBridgeInfo()
    return clientSnippet(id, bridge, mcpUrl(), config.mcp.token)
  })
  ipcMain.handle('mcp:agent-prompt', () => {
    if (!bridge) bridge = ensureBridgeInfo()
    return agentSetupPrompt(bridge, mcpUrl(), config.mcp.token)
  })
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  if (tray) return
  const iconPath = app.isPackaged ? path.join(process.resourcesPath, 'icon.ico') : path.join(paths.appRoot, 'resources', 'icon.ico')
  tray = new Tray(fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty())
  tray.setToolTip('GPT-SoVITS-Studio · MCP 服务运行中')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主界面', click: showWindow },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  )
  tray.on('click', showWindow)
}

async function boot(): Promise<void> {
  paths = getAppPaths()
  config = loadConfig()
  storage = new Storage(paths.dataRoot, paths.historyFile, paths.voicesFile, paths.voicesDir)
  if (config.outputDir && !fs.existsSync(config.outputDir)) fs.mkdirSync(config.outputDir, { recursive: true })
  registerIpc()
  await applyMcp()
  if (headless) createTray()
  else await createWindow()
  startGpuMonitor()
  startIdleMonitor()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // A headless launch from the MCP bridge must not pop the window.
    if (argv.includes('--headless')) return
    showWindow()
  })

  app.whenReady().then(boot).catch((error) => {
    dialog.showErrorBox('GPT-SoVITS-Studio 启动失败', String(error))
    app.quit()
  })

  app.on('window-all-closed', () => {
    // Keep serving agents in the tray when MCP is running.
    if (mcpServer?.running) {
      mainWindow = null
      createTray()
      return
    }
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    if (gpuTimer) clearInterval(gpuTimer)
    if (idleTimer) clearInterval(idleTimer)
    Promise.allSettled([ttsWorker?.unload('退出应用') || Promise.resolve(), asrWorker?.unload('退出应用') || Promise.resolve()]).finally(() => {
      app.quit()
    })
  })
}
