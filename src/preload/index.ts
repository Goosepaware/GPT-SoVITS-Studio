import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppApi,
  AppConfig,
  AsrFileResult,
  AsrModelId,
  AsrTranscribeOptions,
  GpuInfo,
  TtsLoadOptions,
  TtsSynthesizeOptions,
  WorkerEvent
} from '@shared/types'

const api: AppApi = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  refreshBootstrap: () => ipcRenderer.invoke('app:refresh-bootstrap'),
  updateConfig: (patch: Partial<AppConfig>) => ipcRenderer.invoke('app:update-config', patch),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  chooseDirectory: (title?: string) => ipcRenderer.invoke('dialog:directory', title),
  chooseAudioFiles: (multiple = true) => ipcRenderer.invoke('dialog:audio', multiple),
  chooseAsrFolder: () => ipcRenderer.invoke('dialog:asr-folder'),
  prepareReference: (sourcePath: string) => ipcRenderer.invoke('audio:prepare-reference', sourcePath),
  readAudio: (filePath: string) => ipcRenderer.invoke('audio:read', filePath),
  openPath: (target: string) => ipcRenderer.invoke('shell:open', target),
  revealPath: (target: string) => ipcRenderer.invoke('shell:reveal', target),
  exportMp3: (sourcePath: string) => ipcRenderer.invoke('audio:export-mp3', sourcePath),
  exportSubtitle: (sourcePath, format) => ipcRenderer.invoke('subtitle:export', sourcePath, format),
  exportSubtitlesMany: (sourcePaths, formats) => ipcRenderer.invoke('subtitle:export-many', sourcePaths, formats),
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
    restart: () => ipcRenderer.invoke('mcp:restart'),
    regenerateToken: () => ipcRenderer.invoke('mcp:regenerate-token'),
    configureClient: (id: string) => ipcRenderer.invoke('mcp:configure-client', id),
    snippet: (id: string) => ipcRenderer.invoke('mcp:snippet', id),
    agentPrompt: () => ipcRenderer.invoke('mcp:agent-prompt'),
    onActivity: (cb: (line: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, line: string): void => cb(line)
      ipcRenderer.on('mcp:activity', listener)
      return () => ipcRenderer.removeListener('mcp:activity', listener)
    }
  },
  onDataChanged: (cb: (kind: 'history' | 'voices') => void) => {
    const h = (): void => cb('history')
    const v = (): void => cb('voices')
    ipcRenderer.on('history:changed', h)
    ipcRenderer.on('voices:changed', v)
    return () => {
      ipcRenderer.removeListener('history:changed', h)
      ipcRenderer.removeListener('voices:changed', v)
    }
  },
  saveAsrResults: (payload: { items: AsrFileResult[]; format: 'list' | 'txt'; suggestedName: string }) =>
    ipcRenderer.invoke('asr:save-results', payload),
  tts: {
    load: (options: TtsLoadOptions) => ipcRenderer.invoke('tts:load', options),
    unload: () => ipcRenderer.invoke('tts:unload'),
    synthesize: (options: TtsSynthesizeOptions) => ipcRenderer.invoke('tts:synthesize', options),
    cancel: () => ipcRenderer.invoke('tts:cancel'),
    status: () => ipcRenderer.invoke('tts:status')
  },
  asr: {
    load: (model: AsrModelId) => ipcRenderer.invoke('asr:load', model),
    unload: () => ipcRenderer.invoke('asr:unload'),
    transcribe: (options: AsrTranscribeOptions) => ipcRenderer.invoke('asr:transcribe', options),
    cancel: () => ipcRenderer.invoke('asr:cancel'),
    status: () => ipcRenderer.invoke('asr:status')
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    remove: (id: string) => ipcRenderer.invoke('history:remove', id),
    removeMany: (ids: string[]) => ipcRenderer.invoke('history:remove-many', ids),
    export: (ids: string[]) => ipcRenderer.invoke('history:export', ids),
    clear: () => ipcRenderer.invoke('history:clear')
  },
  dub: {
    pickMedia: () => ipcRenderer.invoke('dub:pick-media'),
    diarize: (src: string, opts?: unknown) => ipcRenderer.invoke('dub:diarize', src, opts),
    voiceFromSpan: (src: string, start: number, end: number, name: string, transcript?: string, lang?: string) =>
      ipcRenderer.invoke('dub:voice-from-span', src, start, end, name, transcript, lang),
    saveScript: (src: string, lines: unknown[]) => ipcRenderer.invoke('dub:save-script', src, lines)
  },
  packs: {
    list: () => ipcRenderer.invoke('packs:list'),
    download: (id: string) => ipcRenderer.invoke('packs:download', id),
    cancel: (id: string) => ipcRenderer.invoke('packs:cancel', id),
    remove: (id: string) => ipcRenderer.invoke('packs:remove', id),
    onProgress: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, p: Parameters<typeof cb>[0]): void => cb(p)
      ipcRenderer.on('packs:progress', listener)
      return () => ipcRenderer.removeListener('packs:progress', listener)
    }
  },
  sep: {
    models: () => ipcRenderer.invoke('sep:models'),    download: (id: string) => ipcRenderer.invoke('sep:download', id),
    cancelDownload: (id: string) => ipcRenderer.invoke('sep:cancel-download', id),
    remove: (id: string) => ipcRenderer.invoke('sep:remove', id),
    separate: (src: string, model?: string) => ipcRenderer.invoke('sep:separate', src, model),
    cancel: () => ipcRenderer.invoke('sep:cancel'),
    exportTo: (result) => ipcRenderer.invoke('sep:export', result),
    onEvent: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof cb>[0]): void => cb(payload)
      ipcRenderer.on('sep:event', listener)
      return () => ipcRenderer.removeListener('sep:event', listener)
    }
  },
  segments: {
    list: (audioPath: string) => ipcRenderer.invoke('segments:list', audioPath),
    preview: (audioPath: string, indices: number[], overrides?: unknown, count?: number, source?: unknown) =>
      ipcRenderer.invoke('segments:preview', audioPath, indices, overrides, count, source),
    commit: (audioPath: string, editId: string, choices: { index: number; candidate: number }[], matchLoudness?: boolean) =>
      ipcRenderer.invoke('segments:commit', audioPath, editId, choices, matchLoudness),
    discard: (editId: string) => ipcRenderer.invoke('segments:discard', editId),
    revert: (audioPath: string, mode: 'original' | 'last') => ipcRenderer.invoke('segments:revert', audioPath, mode)
  },
  voices: {
    list: () => ipcRenderer.invoke('voices:list'),
    import: (payload) => ipcRenderer.invoke('voices:import', payload),
    update: (id: string, patch) => ipcRenderer.invoke('voices:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('voices:remove', id),
    openFolder: () => ipcRenderer.invoke('voices:open-folder'),
    importFiles: () => ipcRenderer.invoke('voices:import-files'),
    export: (id: string) => ipcRenderer.invoke('voices:export', id)
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    /** Answer to the close prompt. remember = save as config.closeAction. */
    closeChoice: (choice: 'tray' | 'quit' | 'cancel', remember: boolean) => ipcRenderer.send('window:close-choice', choice, remember),
    onCloseRequest: (cb: () => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('window:close-request', listener)
      return () => ipcRenderer.removeListener('window:close-request', listener)
    },
    onMaximized: (cb: (maximized: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, maximized: boolean): void => cb(maximized)
      ipcRenderer.on('window:maximized', listener)
      return () => ipcRenderer.removeListener('window:maximized', listener)
    }
  },
  onEngineEvent: (cb: (event: WorkerEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: WorkerEvent): void => cb(payload)
    ipcRenderer.on('engine:event', listener)
    return () => ipcRenderer.removeListener('engine:event', listener)
  },
  onGpu: (cb: (gpu: GpuInfo | null) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: GpuInfo | null): void => cb(payload)
    ipcRenderer.on('gpu:update', listener)
    return () => ipcRenderer.removeListener('gpu:update', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
