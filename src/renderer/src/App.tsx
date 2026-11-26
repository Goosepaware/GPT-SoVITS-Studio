import { useEffect, useRef, useState } from 'react'
import { AudioWaveform, Loader2 } from 'lucide-react'
import type { AsrFileResult, Bootstrap, EngineStatus, GpuInfo, Notice, ReferenceTransfer, WorkerEvent } from '@shared/types'
import { Sidebar, type PageKey } from './components/Sidebar'
import { SetupScreen } from './components/SetupScreen'
import { TitleBar } from './components/TitleBar'
import { ToastStack } from './components/ToastStack'
import { TopBar } from './components/TopBar'
import { AsrPage } from './pages/AsrPage'
import { AudioToolsPage } from './pages/AudioToolsPage'
import { FirstRun } from './components/FirstRun'
import { ModelsPage, type LogLine } from './pages/ModelsPage'
import { SettingsPage } from './pages/SettingsPage'
import { TtsPage } from './pages/TtsPage'
import { VoiceLibraryPage } from './pages/VoiceLibraryPage'
import { applyTheme, watchSystemTheme } from './lib/theme'

const EMPTY_STATUS: Record<'tts' | 'asr', EngineStatus> = {
  tts: { engine: 'tts', state: 'stopped', models: {} },
  asr: { engine: 'asr', state: 'stopped', models: {} }
}

import { CloseDialog } from './components/CloseDialog'

export default function App(): JSX.Element {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [page, setPage] = useState<PageKey>('tts')
  const [engines, setEngines] = useState<Record<'tts' | 'asr', EngineStatus>>(EMPTY_STATUS)
  const [gpu, setGpu] = useState<GpuInfo | null>(null)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [notices, setNotices] = useState<Notice[]>([])
  const [referenceTransfer, setReferenceTransfer] = useState<ReferenceTransfer | null>(null)
  const [voiceTransfer, setVoiceTransfer] = useState<{ id: string; at: number } | null>(null)
  const [packsGateDismissed, setPacksGateDismissed] = useState(false)
  const logSeq = useRef(0)

  function notify(message: string, tone: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setNotices((prev) => [...prev.slice(-3), { id, message, tone }])
    window.setTimeout(() => {
      setNotices((prev) => prev.filter((notice) => notice.id !== id))
    }, tone === 'error' ? 6200 : 4200)
  }

  function dismissNotice(id: string): void {
    setNotices((prev) => prev.filter((notice) => notice.id !== id))
  }

  useEffect(() => {
    window.api
      .bootstrap()
      .then((next) => {
        setBootstrap(next)
        applyTheme(next.config.theme)
      })
      .catch((error: unknown) => setFatal(error instanceof Error ? error.message : String(error)))
  }, [])

  useEffect(() => {
    if (!bootstrap) return
    const theme = bootstrap.config.theme
    applyTheme(theme)
    return watchSystemTheme(theme, () => applyTheme(theme))
  }, [bootstrap])

  useEffect(() => {
    const container = document.querySelector('.content-scroll') as HTMLElement | null
    if (container) container.scrollTo({ top: 0, behavior: 'auto' })
  }, [page])

  useEffect(() => {
    const removeEngine = window.api.onEngineEvent((event: WorkerEvent) => {
      if (event.type === 'status') {
        setEngines((prev) => ({
          ...prev,
          [event.engine]: {
            ...prev[event.engine],
            ...event.status,
            engine: event.engine
          }
        }))
      } else if (event.type === 'log') {
        logSeq.current += 1
        setLogs((prev) => [
          ...prev.slice(-399),
          { id: `${Date.now()}-${logSeq.current}`, engine: event.engine, line: event.line, ts: Date.now() }
        ])
      } else if (event.type === 'notice') {
        notify(event.message, event.tone || 'info')
      } else if (event.type === 'error' && !event.id) {
        notify(event.message, 'error')
      }
    })
    const removeGpu = window.api.onGpu(setGpu)
    return () => {
      removeEngine()
      removeGpu()
    }
  }, [])

  async function unloadAll(): Promise<void> {
    await Promise.allSettled([window.api.tts.unload(), window.api.asr.unload()])
    notify('已结束推理进程，显存正在释放', 'info')
  }

  function sendToReference(item: AsrFileResult): void {
    if (!item.ok || !item.text.trim()) {
      notify('这条记录没有可用文本', 'warning')
      return
    }
    setReferenceTransfer({
      id: Date.now(),
      path: item.path,
      text: item.text,
      language: item.language || 'auto',
      name: item.name
    })
    setPage('tts')
  }

  if (fatal) {
    return (
      <div className="app-shell boot-failed">
        <TitleBar />
        <div className="boot-center">
          <div className="boot-mark"><AudioWaveform size={28} /></div>
          <h1>启动失败</h1>
          <p>{fatal}</p>
          <button className="btn primary" onClick={() => window.location.reload()}>重试</button>
        </div>
      </div>
    )
  }

  if (!bootstrap) {
    return (
      <div className="app-shell boot-loading">
        <TitleBar />
        <div className="boot-center">
          <div className="boot-orbit"><AudioWaveform size={28} /></div>
          <h1>GPT-SoVITS-Studio</h1>
          <p><Loader2 size={14} className="spin" /> 正在读取配置…</p>
        </div>
      </div>
    )
  }

  const packsMissing = (bootstrap.validation.modelPacks || []).filter((p) => !p.installed)
  if (!bootstrap.validation.valid || packsMissing.length > 0) {
    if (!packsGateDismissed) {
      return (
        <div className="app-shell">
          <TitleBar />
          <FirstRun
            bootstrap={bootstrap}
            notify={notify}
            onBootstrap={setBootstrap}
            onSkip={() => setPacksGateDismissed(true)}
          />
          <ToastStack notices={notices} onDismiss={dismissNotice} />
        </div>
      )
    }
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <div className="ambient ambient-c" />
      <TitleBar />
      <CloseDialog />
      <div className="app-body">
        <Sidebar page={page} onPage={setPage} engines={engines} gpu={gpu} />
        <main className="main-area">
          <TopBar
            page={page}
            engines={engines}
            gpu={gpu}
            config={bootstrap.config}
            onUnloadAll={() => void unloadAll()}
            onOpenOutput={() => void window.api.openPath(bootstrap.config.outputDir)}
          />
          <div className="content-scroll">
            <div className={page === 'tts' ? 'page-pane active' : 'page-pane'}>
              <TtsPage bootstrap={bootstrap} engines={engines} onBootstrap={setBootstrap} notify={notify} incomingReference={referenceTransfer} voiceTransfer={voiceTransfer} onManageVoices={() => setPage('voices')} />
            </div>
            <div className={page === 'voices' ? 'page-pane active' : 'page-pane'}>
              <VoiceLibraryPage notify={notify} onUseVoice={(id) => { setVoiceTransfer({ id, at: Date.now() }); setPage('tts') }} />
            </div>
            <div className={page === 'asr' ? 'page-pane active' : 'page-pane'}>
              <AsrPage bootstrap={bootstrap} engines={engines} notify={notify} onSendToReference={sendToReference} />
            </div>
            <div className={page === 'audio' ? 'page-pane active' : 'page-pane'}>
              <AudioToolsPage bootstrap={bootstrap} notify={notify} onBootstrap={setBootstrap} />
            </div>
            <div className={page === 'models' ? 'page-pane active' : 'page-pane'}>
              <ModelsPage bootstrap={bootstrap} engines={engines} gpu={gpu} logs={logs} notify={notify} onBootstrap={setBootstrap} />
            </div>
            <div className={page === 'settings' ? 'page-pane active' : 'page-pane'}>
              <SettingsPage bootstrap={bootstrap} notify={notify} onBootstrap={setBootstrap} />
            </div>
          </div>
        </main>
      </div>
      <ToastStack notices={notices} onDismiss={dismissNotice} />
    </div>
  )
}
