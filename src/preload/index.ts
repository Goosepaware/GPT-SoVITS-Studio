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
