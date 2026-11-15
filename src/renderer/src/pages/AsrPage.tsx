import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertCircle,
  Check,
  Download,
  FileAudio2,
  FolderOpen,
  Loader2,
  Mic2,
  Plus,
  RefreshCw,
  Send,
  Square,
  Trash2,
  X
} from 'lucide-react'
import type { AsrFileResult, Bootstrap, EngineStatus, WorkerEvent } from '@shared/types'
import { ProgressTimeline, type StageItem } from '../components/ProgressTimeline'
import { DropZone } from '../components/DropZone'
import { Select } from '../components/Select'
import { basename, cn, formatBytes, formatDuration } from '../lib/format'
import { scrollWithinContent } from '../lib/scroll'

interface Props {
  bootstrap: Bootstrap
  engines: Record<'tts' | 'asr', EngineStatus>
  notify: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void
  onSendToReference: (item: AsrFileResult) => void
}

interface Job {
  running: boolean
  progress: number
  startedAt: number
  stages: StageItem[]
  error?: string
}

const LANGS = [
  ['auto', '自动检测'],
  ['zh', '中文'],
  ['en', '英语'],
  ['ja', '日语'],
  ['ko', '韩语'],
  ['yue', '粤语']
] as const

function mergeStage(prev: Job, next: { key: string; label: string; detail?: string }): Job {
  const stages = prev.stages.map((stage) => ({ ...stage }))
  const existing = stages.find((stage) => stage.key === next.key)
  if (existing) {
    existing.label = next.label
    existing.detail = next.detail || existing.detail
    existing.state = 'running'
  } else {
    for (const stage of stages) if (stage.state === 'running') stage.state = 'done'
    stages.push({ key: next.key, label: next.label, detail: next.detail, state: 'running' })
  }
  return { ...prev, stages }
}

function finish(job: Job, state: 'done' | 'error'): Job {
  return {
    ...job,
    running: false,
    progress: state === 'done' ? 100 : job.progress,
    stages: job.stages.map((stage) => (stage.state === 'running' ? { ...stage, state } : stage))
  }
}

export function AsrPage({ bootstrap, engines, notify, onSendToReference }: Props): JSX.Element {
  const [files, setFiles] = useState<string[]>([])
  const [language, setLanguage] = useState('auto')
  const [job, setJob] = useState<Job | null>(null)
  const [results, setResults] = useState<AsrFileResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [resultAnchor, setResultAnchor] = useState<HTMLDivElement | null>(null)

  const sense = bootstrap.models.asr.sensevoice
  const status = engines.asr
  const loadedSame = status.state === 'ready' && Boolean(sense) && status.models.asr === sense?.path
  const isBusy = status.state === 'busy' || Boolean(job?.running)
  const totalDuration = useMemo(() => results.reduce((sum, item) => sum + (item.ok ? item.durationMs / 1000 : 0), 0), [results])

  useEffect(() => {
    const remove = window.api.onEngineEvent((event: WorkerEvent) => {
      if (event.engine !== 'asr') return
      if (event.type === 'stage') {
        setJob((prev) => (prev ? mergeStage(prev, { key: event.stage, label: event.label, detail: event.detail }) : prev))
        if (typeof event.progress === 'number') setJob((prev) => (prev ? { ...prev, progress: Math.max(prev.progress, event.progress || 0) } : prev))
      } else if (event.type === 'progress') {
        setJob((prev) => {
          if (!prev) return prev
          const progress = event.total ? (event.current / event.total) * 92 : prev.progress
          return { ...prev, progress: Math.max(prev.progress, Math.min(96, progress)) }
        })
      } else if (event.type === 'cancelled') {
        setJob((prev) => (prev ? { ...finish(prev, 'done'), error: '已取消识别' } : prev))
      }
    })
    return remove
  }, [])

  useEffect(() => {
    if (!resultAnchor || results.length === 0) return
    const timer = window.setTimeout(() => scrollWithinContent(resultAnchor, 'center'), 140)
    return () => window.clearTimeout(timer)
  }, [resultAnchor, results.length])

  function addFiles(next: string[]): void {
    setFiles((prev) => Array.from(new Set([...prev, ...next])))
  }

  async function browse(): Promise<void> {
    addFiles(await window.api.chooseAudioFiles(true))
  }

  async function addFolder(): Promise<void> {
    const next = await window.api.chooseAsrFolder()
    addFiles(next)
    if (next.length) notify(`已添加 ${next.length} 个音频文件`, 'info')
  }

  async function ensureLoaded(): Promise<void> {
    if (!sense) throw new Error('没有找到 SenseVoice 模型')
    if (loadedSame) return
    setError(null)
    setJob({ running: true, progress: 2, startedAt: Date.now(), stages: [{ key: 'load-model', label: '加载 SenseVoice', state: 'running' }] })
    await window.api.asr.load('sensevoice')
    setJob((prev) => (prev ? finish(prev, 'done') : prev))
    notify('SenseVoice 已加载', 'success')
  }

  async function start(): Promise<void> {
    if (!files.length) {
      notify('先添加要识别的音频', 'warning')
      return
    }
    setError(null)
    setResults([])
    try {
      await ensureLoaded()
      setJob({ running: true, progress: 4, startedAt: Date.now(), stages: [{ key: 'transcribe', label: '开始识别', state: 'running' }] })
      const output = await window.api.asr.transcribe({ files, language })
      setResults(output)
      setJob((prev) => (prev ? finish(prev, 'done') : prev))
      const ok = output.filter((item) => item.ok).length
      notify(`识别完成 · ${ok}/${output.length} 个文件`, ok === output.length ? 'success' : 'warning')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setJob((prev) => (prev ? { ...finish(prev, 'error'), error: message } : prev))
      if (!message.includes('取消')) notify(message, 'error')
    }
  }

  async function exportResults(format: 'list' | 'txt'): Promise<void> {
    if (!results.length) return
    const first = results[0]?.path || 'asr'
    const folder = basename(first.split(/[\\/]/).slice(0, -1).join('/')) || 'asr'
    const saved = await window.api.saveAsrResults({ items: results, format, suggestedName: folder })
    if (saved) {
      notify(`已导出 ${format.toUpperCase()}`, 'success')
      await window.api.revealPath(saved)
    }
  }

  function updateText(index: number, text: string): void {
    setResults((prev) => prev.map((item, i) => (i === index ? { ...item, text } : item)))
  }

  return (
    <div className="page asr-page">
      <section className="card asr-model-strip">
        <div className="asr-model-icon flash"><Mic2 size={19} /></div>
        <div className="asr-model-strip-copy">
          <strong>SenseVoice</strong>
          <span>本地推理 · 中 / 英 / 日 / 韩 / 粤 · 首次识别会预热</span>
        </div>
        <div className="asr-model-strip-meta">
          <span className="soft-badge">{sense ? formatBytes(sense.size) : '未找到模型'}</span>
          <span className="soft-badge">显存约 2.1GB</span>
          <span className="soft-badge">本地推理</span>
        </div>
      </section>

      <section className="card panel asr-input-panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">INPUT</span>
            <h2>待识别音频</h2>
          </div>
          <div className="panel-actions">
            <button className="btn ghost small" onClick={() => void addFolder()}><FolderOpen size={14} /> 添加文件夹</button>
            <button className="btn ghost small" onClick={() => void browse()}><Plus size={14} /> 添加文件</button>
          </div>
        </div>
        <DropZone
          multiple
          compact
          onFiles={(paths) => addFiles(paths)}
          onBrowse={() => void browse()}
          title="拖入多个音频，或添加整个文件夹"
          subtitle="识别结果会按文件列出，支持批量导出 .list / .txt"
        />
        {files.length > 0 && (
          <div className="file-list">
            <div className="file-list-head">
              <span>{files.length} 个文件</span>
              <button className="text-btn" onClick={() => setFiles([])}>清空</button>
            </div>
            <AnimatePresence initial={false}>
              {files.map((file) => (
                <motion.div className="file-row" key={file} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 8 }}>
                  <FileAudio2 size={15} />
                  <span className="file-name" title={file}>{basename(file)}</span>
                  <span className="file-path">{file}</span>
                  <button className="icon-btn small" onClick={() => setFiles((prev) => prev.filter((item) => item !== file))}><X size={13} /></button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
        <div className="asr-controls">
          <div className="field inline-field">
            <span className="field-label">识别语言</span>
            <Select value={language} onChange={setLanguage}>
              {LANGS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          </div>
          <button className="btn primary large" onClick={() => void start()} disabled={!files.length || isBusy || !sense}>
            {isBusy ? <Loader2 size={16} className="spin" /> : <Mic2 size={16} />}
            {job?.running ? '识别中…' : status.state === 'loading' || status.state === 'starting' ? '加载模型中…' : '开始识别'}
          </button>
          {job?.running && (
            <button className="btn ghost large" onClick={() => void window.api.asr.cancel()}><Square size={13} fill="currentColor" /> 停止</button>
          )}
          <span className="asr-hint">SenseVoice 首次识别约 10–20 秒预热，之后通常不到 1 秒；结果可能不带标点。</span>
        </div>
        {error && <div className="inline-error"><AlertCircle size={15} /><span>{error}</span></div>}
        <AnimatePresence>
          {job && (
            <ProgressTimeline
              title={job.stages.some((stage) => stage.key === 'load-model') && results.length === 0 ? '加载识别模型' : '识别进度'}
              stages={job.stages}
              progress={job.progress}
              running={job.running}
              startedAt={job.startedAt}
              tone={job.error ? 'error' : 'default'}
              onCancel={job.stages.some((stage) => stage.key === 'transcribe') ? () => void window.api.asr.cancel() : undefined}
              cancelLabel="停止识别"
            />
          )}
        </AnimatePresence>
      </section>

      <div ref={setResultAnchor} />
      <AnimatePresence>
        {results.length > 0 && (
          <motion.section className="card panel results-panel" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
            <div className="panel-head">
              <div>
                <span className="eyebrow">TRANSCRIPT</span>
                <h2>识别结果</h2>
              </div>
              <div className="panel-actions">
                <span className="soft-badge"><Check size={12} /> {results.filter((item) => item.ok).length}/{results.length}</span>
                <span className="soft-badge">{formatDuration(totalDuration)} 音频</span>
                <button className="btn ghost small" onClick={() => void exportResults('list')}><Download size={14} /> .list</button>
                <button className="btn ghost small" onClick={() => void exportResults('txt')}><Download size={14} /> .txt</button>
              </div>
            </div>
            <div className="result-table">
              <div className="result-table-head">
                <span>文件</span>
                <span>识别文本</span>
                <span>语言</span>
                <span>耗时</span>
                <span>操作</span>
              </div>
              {results.map((item, index) => (
                <div className={cn('result-row', !item.ok && 'failed')} key={item.path}>
                  <div className="result-file">
                    <FileAudio2 size={14} />
                    <span title={item.path}>{item.name}</span>
                  </div>
                  <div className="result-text-cell">
                    {item.ok ? (
                      <textarea value={item.text} rows={2} onChange={(event) => updateText(index, event.target.value)} />
                    ) : (
                      <span className="result-error">{item.error || '识别失败'}</span>
                    )}
                  </div>
                  <span className="result-lang">{item.language.toUpperCase()}</span>
                  <span className="result-time mono">{(item.durationMs / 1000).toFixed(1)}s</span>
                  <button
                    className="btn ghost small send-ref-btn"
                    disabled={!item.ok || !item.text.trim()}
                    onClick={() => onSendToReference(item)}
                    title="发送到语音生成的参考声音"
                  >
                    <Send size={12} /> 发送到生成参考
                  </button>
                </div>
              ))}
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  )
}
