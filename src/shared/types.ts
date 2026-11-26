export type ThemeMode = 'dark' | 'light' | 'mono-dark' | 'mono-light' | 'color-system' | 'mono-system'

export type EngineName = 'tts' | 'asr'
export type EngineState = 'stopped' | 'starting' | 'loading' | 'ready' | 'busy' | 'stopping' | 'error'

export interface AppConfig {
  engineRoot: string
  outputDir: string
  theme: ThemeMode
  autoUnloadOnSwitch: boolean
  idleUnloadMinutes: number
  device: string
  half: boolean
  /** Default diffusion sampling steps for the TTS page and MCP agents (4 / 8 / 16 / 32). */
  defaultSampleSteps: number
  subtitle: SubtitleConfig
  mcp: McpConfig
  /** What the window close button does: ask each time, hide to tray, or quit. */
  closeAction: CloseAction
  /** HuggingFace download source for optional models. */
  hfSource?: 'official' | 'mirror'
}

export type CloseAction = 'ask' | 'tray' | 'quit'

export interface SepModelInfo {
  id: string
  label: string
  note: string
  size: number
  installed: boolean
  path: string
  downloading: { received: number; total: number } | null
}

export interface ModelPackInfo {
  id: string
  label: string
  note: string
  group: 'tts' | 'asr'
  /** Shipped with the app; downloading only repairs a deleted folder. */
  bundled: boolean
  installed: boolean
  totalBytes: number
  missingBytes: number
  downloading: { received: number; total: number; file: string } | null
}

export interface ModelPackProgress {
  id: string
  file: string
  received: number
  total: number
  done?: boolean
  error?: string
}

export interface EngineInstallProgress {
  phase: 'download' | 'extract'
  received: number
  total: number
  file: string
}

export interface SepResult {
  vocals: string
  instrumental: string
  model: string
  sourcePath: string
  cached: boolean
}

export type SepEvent =
  | { kind: 'download'; id: string; received: number; total: number }
  | { kind: 'separate'; current: number; total: number; label: string }

export type AsrModelId = 'sensevoice'

export interface ModelOption {
  id: string
  path: string
  label: string
  size: number
  kind: 'gpt' | 'sovits' | 'asr' | 'vad'
  base?: boolean
}

export interface ModelCatalog {
  tts: {
    gpt: ModelOption[]
    sovits: ModelOption[]
  }
  asr: {
    sensevoice: ModelOption | null
    vad: ModelOption | null
    /** CAM++ speaker embedding model (diarization) */
    spk?: ModelOption | null
  }
}

export interface EngineValidation {
  root: string
  valid: boolean
  missing: string[]
  runtime: string
  /** Model packs that are not installed yet (downloadable). */
  modelPacks: ModelPackInfo[]
}

export interface VramInfo {
  allocatedMB: number
  reservedMB: number
  freeMB: number
  totalMB: number
}

export interface EngineStatus {
  engine: EngineName
  state: EngineState
  pid?: number
  label?: string
  models: Record<string, string>
  vram?: VramInfo
  startedAt?: number
  message?: string
}

export interface GpuInfo {
  name: string
  memoryTotalMB: number
  memoryUsedMB: number
  utilization: number | null
  updatedAt: number
}

export interface Bootstrap {
  config: AppConfig
  validation: EngineValidation
  models: ModelCatalog
  version: string
  appRoot: string
  dataRoot: string
}

export interface TtsLoadOptions {
  gptPath: string
  sovitsPath: string
}

export interface TtsSynthesizeOptions {
  text: string
  textLang: string
  promptText: string
  promptLang: string
  refAudioPath: string
  speed: number
  splitMethod: string
  topK: number
  topP: number
  temperature: number
  repetitionPenalty: number
  seed: number
  batchSize: number
  sampleSteps: number
  fragmentInterval: number
  parallelInfer: boolean
  outputPath: string
  voiceId?: string
}

export interface AsrTranscribeOptions {
  files: string[]
  language: string
}

export interface AsrFileResult {
  path: string
  name: string
  text: string
  language: string
  ok: boolean
  error?: string
  durationMs: number
}

export interface ReferenceTransfer {
  id: number
  path: string
  text: string
  language: string
  name: string
}

export interface TtsResult {
  filePath: string
  duration: number
  sampleRate: number
  segments: number
  elapsed: number
  seed?: number
  historyId?: string
  timingPath?: string
  warnings?: string[]
}

export type SubtitleFormat = 'srt' | 'ass' | 'vtt' | 'lrc' | 'txt' | 'json'

export const SUBTITLE_FORMATS: SubtitleFormat[] = ['srt', 'ass', 'vtt', 'lrc', 'txt', 'json']

export interface SubtitleConfig {
  autoExport: boolean
  autoFormats: SubtitleFormat[]
  defaultFormat: SubtitleFormat
  maxChars: number
  minChars: number
  minDuration: number
  stripTrailingPunct: boolean
  offsetMs: number
  assFont: string
  assFontSize: number
}

export interface McpConfig {
  enabled: boolean
  /** Allow an MCP client to launch a silent background service when the app is closed. */
  autoStart: boolean
  port: number
  token: string
  pathAllowlist: string[]
}

export interface McpClientInfo {
  id: string
  label: string
  detected: boolean
  configured: boolean
  configPath: string
}

export interface McpStatus {
  running: boolean
  port: number
  url: string
  error?: string
  bridgePath: string
  clients: McpClientInfo[]
}

export interface HistoryEntry {
  id: string
  filePath: string
  text: string
  voiceName?: string
  models?: string
  duration: number
  createdAt: number
  seed?: number
  params?: Record<string, unknown>
  /** Segments were replaced: params can no longer reproduce the audio, subtitles still work. */
  edited?: boolean
}

export interface DiarizeLine {
  start: number
  end: number
  speaker: string
  text?: string
  lang?: string
  confidence: number
}

export interface DiarizeResult {
  items: DiarizeLine[]
  numSpeakers: number
  references: Record<string, { start: number; end: number; text: string; score: number }[]>
  duration: number
  /** 16 kHz wav actually analysed */
  audioPath?: string
  sourcePath?: string
}

export interface SegParamsT {
  speed?: number
  topK?: number
  topP?: number
  temperature?: number
  sampleSteps?: number
  repetitionPenalty?: number
}

export interface SegItem {
  index: number
  text: string
  start: number
  end: number
  voicedStart: number
  voicedEnd: number
  seed?: number
  flags?: string[]
  params?: SegParamsT | null
  edited?: boolean
}

export interface SegTiming {
  version: number
  sampleRate: number
  duration: number
  seed?: number
  gap?: number
  source?: { voiceId?: string; refAudioPath?: string; promptText?: string; params?: SegParamsT }
  edited?: boolean
  editCount?: number
  segments: SegItem[]
}

export interface SegEditState {
  edited: boolean
  editCount: number
  hasOriginal: boolean
  hasPrevious: boolean
}

export interface SegCandidate {
  candidate: number
  path: string
  duration: number
  seed: number
  flags: string[]
}

export interface SegPreviewSession {
  editId: string
  audioPath: string
  segments: { index: number; text: string; params: SegParamsT; candidates: SegCandidate[] }[]
}

export interface Voice {
  id: string
  name: string
  audioPath: string
  packagePath: string
  transcript: string
  promptLang: string
  duration: number
  createdAt: number
  originalName?: string
  /** Folder path relative to data/voices, using forward slashes. Empty = root. */
  folder: string
  /** Last time the voice was selected/used, for the recent-voice menu. */
  lastUsedAt?: number
}

export interface VoiceFolderInfo {
  /** Folder path relative to data/voices, using forward slashes. Empty is the root and is not listed. */
  path: string
  name: string
  parent: string
  depth: number
  /** Voices directly inside this folder. */
  voiceCount: number
}

export interface VoiceLibrary {
  voices: Voice[]
  folders: VoiceFolderInfo[]
}

export interface VoiceImportResult {
  voices: Voice[]
  imported: number
  skipped: number
}

export type WorkerEvent =
  | { type: 'worker-ready'; engine: EngineName; pid: number }
  | { type: 'status'; engine: EngineName; status: Partial<EngineStatus> }
  | {
      type: 'stage'
      engine: EngineName
      id?: string
      stage: string
      label: string
      progress?: number
      detail?: string
    }
  | {
      type: 'progress'
      engine: EngineName
      id?: string
      current: number
      total: number
      label?: string
      detail?: string
    }
  | { type: 'result'; engine: EngineName; id?: string; data: unknown }
  | { type: 'error'; engine: EngineName; id?: string; message: string; traceback?: string }
  | { type: 'cancelled'; engine: EngineName; id?: string }
  | { type: 'log'; engine: EngineName; line: string }
  | { type: 'notice'; engine: EngineName; message: string; tone?: 'info' | 'success' | 'warning' | 'error' }

export interface Notice {
  id: string
  message: string
  tone: 'info' | 'success' | 'warning' | 'error'
}

export interface AppApi {
  bootstrap: () => Promise<Bootstrap>
  refreshBootstrap: () => Promise<Bootstrap>
  updateConfig: (patch: Partial<AppConfig>) => Promise<Bootstrap>
  getPathForFile: (file: File) => string
  chooseDirectory: (title?: string) => Promise<string | null>
  chooseAudioFiles: (multiple?: boolean) => Promise<string[]>
  chooseAsrFolder: () => Promise<string[]>
  prepareReference: (path: string) => Promise<{ path: string; duration: number; name: string }>
  readAudio: (path: string) => Promise<{ data: Uint8Array; mime: string }>
  openPath: (path: string) => Promise<void>
  revealPath: (path: string) => Promise<void>
  exportMp3: (sourcePath: string) => Promise<string | null>
  exportSubtitle: (sourcePath: string, format?: SubtitleFormat) => Promise<string | null>
  exportSubtitlesMany: (
    sourcePaths: string[],
    formats: SubtitleFormat[]
  ) => Promise<{ dir: string; written: number; skipped: number } | null>
  mcp: {
    status: () => Promise<McpStatus>
    restart: () => Promise<McpStatus>
    regenerateToken: () => Promise<McpStatus>
    configureClient: (id: string) => Promise<McpStatus>
    snippet: (id: string) => Promise<string>
    agentPrompt: () => Promise<string>
    onActivity: (cb: (line: string) => void) => () => void
  }
  onDataChanged: (cb: (kind: 'history' | 'voices') => void) => () => void
  saveAsrResults: (payload: {
    items: AsrFileResult[]
    format: 'list' | 'txt'
    suggestedName: string
  }) => Promise<string | null>
  tts: {
    load: (options: TtsLoadOptions) => Promise<EngineStatus>
    unload: () => Promise<void>
    synthesize: (options: TtsSynthesizeOptions) => Promise<TtsResult>
    cancel: () => Promise<void>
    status: () => Promise<EngineStatus>
  }
  asr: {
    load: (model: AsrModelId) => Promise<EngineStatus>
    unload: () => Promise<void>
    transcribe: (options: AsrTranscribeOptions) => Promise<AsrFileResult[]>
    cancel: () => Promise<void>
    status: () => Promise<EngineStatus>
  }
  history: {
    list: () => Promise<HistoryEntry[]>
    remove: (id: string) => Promise<HistoryEntry[]>
    removeMany: (ids: string[]) => Promise<HistoryEntry[]>
    export: (ids: string[]) => Promise<string | null>
    clear: () => Promise<void>
  }
  dub: {
    pickMedia: () => Promise<string | null>
    diarize: (src: string, opts?: { numSpeakers?: number; language?: string; threshold?: number }) => Promise<DiarizeResult>
    voiceFromSpan: (src: string, start: number, end: number, name: string, transcript?: string, lang?: string) => Promise<Voice>
    saveScript: (src: string, lines: unknown[]) => Promise<string | null>
  }
  packs: {
    list: () => Promise<ModelPackInfo[]>
    download: (id: string) => Promise<ModelPackInfo[]>
    cancel: (id: string) => Promise<void>
    remove: (id: string) => Promise<ModelPackInfo[]>
    onProgress: (cb: (p: ModelPackProgress) => void) => () => void
  }
  engine: {
    /** Runtime + code folder present (UI-only builds start without it). */
    status: () => Promise<{ ready: boolean; installing: EngineInstallProgress | null }>
    install: () => Promise<{ ready: boolean }>
    cancel: () => Promise<void>
    onProgress: (cb: (p: EngineInstallProgress) => void) => () => void
  }
  sep: {
    models: () => Promise<SepModelInfo[]>
    download: (id: string) => Promise<SepModelInfo[]>
    cancelDownload: (id: string) => Promise<void>
    remove: (id: string) => Promise<SepModelInfo[]>
    separate: (src: string, model?: string) => Promise<SepResult>
    cancel: () => Promise<void>
    exportTo: (result: SepResult) => Promise<string | null>
    onEvent: (cb: (e: SepEvent) => void) => () => void
  }
  segments: {
    list: (audioPath: string) => Promise<{ timing: SegTiming; state: SegEditState }>
    preview: (
      audioPath: string,
      indices: number[],
      overrides?: { seed?: number; params?: SegParamsT; texts?: Record<string, string> },
      count?: number,
      source?: Record<string, unknown>
    ) => Promise<SegPreviewSession>
    commit: (audioPath: string, editId: string, choices: { index: number; candidate: number }[], matchLoudness?: boolean) => Promise<SegTiming>
    discard: (editId: string) => Promise<void>
    revert: (audioPath: string, mode: 'original' | 'last') => Promise<SegTiming>
  }
  voices: {
    list: () => Promise<Voice[]>
    library: () => Promise<VoiceLibrary>
    import: (payload: {
      sourcePath: string
      name: string
      transcript: string
      promptLang: string
      folder?: string
    }) => Promise<Voice[]>
    update: (id: string, patch: Partial<Pick<Voice, 'name' | 'transcript' | 'promptLang'>>) => Promise<Voice[]>
    remove: (id: string) => Promise<Voice[]>
    openFolder: (folder?: string) => Promise<void>
    importFiles: (folder?: string) => Promise<VoiceImportResult | null>
    export: (id: string) => Promise<string | null>
    createFolder: (parent: string, name: string) => Promise<VoiceLibrary>
    renameFolder: (folder: string, name: string) => Promise<VoiceLibrary>
    removeFolder: (folder: string) => Promise<VoiceLibrary>
    move: (id: string, folder: string) => Promise<VoiceLibrary>
    touch: (id: string) => Promise<void>
    audio: (id: string) => Promise<string>
  }
  window: {
    minimize: () => void
    toggleMaximize: () => void
    close: () => void
    /** Answer to the in-app close prompt; remember stores it as config.closeAction. */
    closeChoice: (choice: 'tray' | 'quit' | 'cancel', remember: boolean) => void
    /** Fired when the main process wants the close prompt shown. */
    onCloseRequest: (cb: () => void) => () => void
    onMaximized: (cb: (maximized: boolean) => void) => () => void
  }
  onEngineEvent: (cb: (event: WorkerEvent) => void) => () => void
  onGpu: (cb: (gpu: GpuInfo | null) => void) => () => void
}
