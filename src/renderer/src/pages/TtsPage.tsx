import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertCircle,
  AudioWaveform,
  Captions,
  Check,
  ChevronDown,
  Clock3,
  Dices,
  Download,
  FolderDown,
  FolderOpen,
  Loader2,
  Mic,
  RefreshCw,
  RotateCcw,
  Save,
  Share2,
  Sparkles,
  Square,
  Trash2,
  Wand2,
  X
} from 'lucide-react'
import { SUBTITLE_FORMATS, type Bootstrap, type EngineStatus, type HistoryEntry, type ReferenceTransfer, type SubtitleFormat, type TtsResult, type Voice, type WorkerEvent } from '@shared/types'
import { FORMAT_LABEL } from '../components/SettingsExtraCards'
import { AudioPlayer } from '../components/AudioPlayer'
import { DropZone } from '../components/DropZone'
import { HistoryRow } from '../components/HistoryRow'
import { Modal } from '../components/Modal'
import { ProgressTimeline, type StageItem } from '../components/ProgressTimeline'
import { Select } from '../components/Select'
import { basename, cn, formatBytes, formatClock } from '../lib/format'
import { scrollWithinContent } from '../lib/scroll'
import { useAudioUrl } from '../lib/useAudioUrl'

interface Props {
  bootstrap: Bootstrap
  engines: Record<'tts' | 'asr', EngineStatus>
  onBootstrap: (next: Bootstrap) => void
  notify: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void
  incomingReference?: ReferenceTransfer | null
}

type JobKind = 'load' | 'synth'
interface Job {
  kind: JobKind
  running: boolean
  progress: number
  startedAt: number
  stages: StageItem[]
  error?: string
}

const TEXT_LANGS = [
  ['auto', '自动'],
  ['zh', '中文'],
  ['ja', '日语'],
  ['en', '英语'],
  ['yue', '粤语'],
  ['ko', '韩语']
] as const

const SPLIT_METHODS = [
  ['cut5', '按标点切分（推荐）'],
  ['cut1', '按换行切分'],
  ['cut2', '按句号切分'],
  ['cut3', '按问号切分'],
  ['cut4', '按逗号切分']
] as const

const STEP_OPTIONS = [4, 8, 16, 32] as const

const DEFAULT_PARAMS = {
  speed: 1,
  splitMethod: 'cut5',
  topK: 15,
  topP: 1,
  temperature: 1,
  repetitionPenalty: 1.35,
  seed: -1,
  batchSize: 1,
  sampleSteps: 4
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="field">
      <span className="field-label">
        {label}
        {hint && <em>{hint}</em>}
      </span>
      {children}
    </div>
  )
}

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; format?: (value: number) => string }): JSX.Element {
  return (
    <div className="slider-field">
      <div className="slider-head">
        <span>{label}</span>
        <span className="mono">{format ? format(value) : value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  )
}

function Elapsed({ since }: { since: number }): JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return <span className="elapsed-inline">{formatClock(now - since)}</span>
}

function mergeStage(prev: Job, next: { key: string; label: string; detail?: string }): Job {
  const stages = prev.stages.map((stage) => ({ ...stage }))
  const existing = stages.find((stage) => stage.key === next.key)
  if (existing) {
    existing.label = next.label
    existing.detail = next.detail || existing.detail
    existing.state = 'running'
  } else {
    for (const stage of stages) {
      if (stage.state === 'running') stage.state = 'done'
    }
    stages.push({ key: next.key, label: next.label, detail: next.detail, state: 'running' })
  }
  return { ...prev, stages }
}

function finishStages(job: Job, state: 'done' | 'error'): Job {
  return {
    ...job,
    running: false,
    progress: state === 'done' ? 100 : job.progress,
    stages: job.stages.map((stage) => (stage.state === 'running' ? { ...stage, state } : stage))
  }
}

export function TtsPage({ bootstrap, engines, onBootstrap, notify, incomingReference }: Props): JSX.Element {
  const [gptId, setGptId] = useState('')
  const [sovitsId, setSovitsId] = useState('')
  const [ref, setRef] = useState<{ path: string; duration: number; name: string } | null>(null)
  const [refText, setRefText] = useState('')
  const [refLang, setRefLang] = useState('auto')
  const [textLang, setTextLang] = useState('auto')
  const [targetText, setTargetText] = useState('')
  const [speed, setSpeed] = useState(DEFAULT_PARAMS.speed)
  const [splitMethod, setSplitMethod] = useState(DEFAULT_PARAMS.splitMethod)
  const [advanced, setAdvanced] = useState(false)
  const [topK, setTopK] = useState(DEFAULT_PARAMS.topK)
  const [topP, setTopP] = useState(DEFAULT_PARAMS.topP)
  const [temperature, setTemperature] = useState(DEFAULT_PARAMS.temperature)
  const [repetitionPenalty, setRepetitionPenalty] = useState(DEFAULT_PARAMS.repetitionPenalty)
  const [seed, setSeed] = useState(DEFAULT_PARAMS.seed)
  const [batchSize, setBatchSize] = useState(DEFAULT_PARAMS.batchSize)
  const [sampleSteps, setSampleSteps] = useState(DEFAULT_PARAMS.sampleSteps)
  const [job, setJob] = useState<Job | null>(null)
  const [result, setResult] = useState<TtsResult | null>(null)
  const [resultText, setResultText] = useState('')
  const [synthError, setSynthError] = useState<string | null>(null)
  const [asrInline, setAsrInline] = useState<{ running: boolean; label: string; startedAt?: number }>({ running: false, label: '' })
  const [voices, setVoices] = useState<Voice[]>([])
  const [voiceId, setVoiceId] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [subtitleFormat, setSubtitleFormat] = useState<SubtitleFormat>(bootstrap.config.subtitle.defaultFormat)
  const [batchFormats, setBatchFormats] = useState<SubtitleFormat[]>([bootstrap.config.subtitle.defaultFormat])
  useEffect(() => setSubtitleFormat(bootstrap.config.subtitle.defaultFormat), [bootstrap.config.subtitle.defaultFormat])
  // Agent (MCP) generations land in history while this page is open.
  useEffect(() => window.api.onDataChanged((kind) => kind === 'history' && void window.api.history.list().then(setHistory)), [])
  const [historySelectMode, setHistorySelectMode] = useState(false)
  const [selectedHistory, setSelectedHistory] = useState<Set<string>>(new Set())
  const [confirmDelete, setConfirmDelete] = useState<{ ids: string[]; title: string; message: string } | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [voiceName, setVoiceName] = useState('')
  const targetRef = useRef<HTMLTextAreaElement | null>(null)
  const progressAnchor = useRef<HTMLDivElement | null>(null)
  const resultAnchor = useRef<HTMLDivElement | null>(null)
  const advancedAnchor = useRef<HTMLDivElement | null>(null)
  const lastTransferId = useRef(0)

  const gpt = bootstrap.models.tts.gpt.find((item) => item.id === gptId) || bootstrap.models.tts.gpt[0]
  const sovits = bootstrap.models.tts.sovits.find((item) => item.id === sovitsId) || bootstrap.models.tts.sovits[0]
  const refUrl = useAudioUrl(ref?.path)
  const resultUrl = useAudioUrl(result?.filePath)
  const selectedVoice = voices.find((voice) => voice.id === voiceId)
  const ttsStatus = engines.tts
  const visibleHistory = history.slice(0, 20)

  useEffect(() => {
    if (!bootstrap.models.tts.gpt.find((item) => item.id === gptId)) setGptId(bootstrap.models.tts.gpt[0]?.id || '')
    if (!bootstrap.models.tts.sovits.find((item) => item.id === sovitsId)) setSovitsId(bootstrap.models.tts.sovits[0]?.id || '')
  }, [bootstrap.models, gptId, sovitsId])

  useEffect(() => {
    void window.api.voices.list().then(setVoices)
    void window.api.history.list().then(setHistory)
  }, [])

  useEffect(() => {
    if (!incomingReference || incomingReference.id === lastTransferId.current) return
    let cancelled = false
    void (async () => {
      try {
        const prepared = await window.api.prepareReference(incomingReference.path)
        if (cancelled) return
        lastTransferId.current = incomingReference.id
        setRef({ path: prepared.path, duration: prepared.duration, name: incomingReference.name || prepared.name })
        setRefText(incomingReference.text)
        setRefLang(TEXT_LANGS.some(([value]) => value === incomingReference.language) ? incomingReference.language : 'auto')
        setVoiceId('')
        setResult(null)
        setSynthError(null)
        notify('已从语音转文字发送到参考声音，可以直接生成', 'success')
      } catch (error) {
        if (!cancelled) notify(error instanceof Error ? error.message : String(error), 'error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [incomingReference])

  useEffect(() => {
    const remove = window.api.onEngineEvent((event: WorkerEvent) => {
      if (event.engine !== 'tts') return
      if (event.type === 'stage') {
        setJob((prev) => {
          if (!prev) return prev
          return mergeStage(prev, { key: event.stage, label: event.label, detail: event.detail })
        })
        if (typeof event.progress === 'number') {
          setJob((prev) => (prev ? { ...prev, progress: Math.max(prev.progress, event.progress || 0) } : prev))
        }
      } else if (event.type === 'progress') {
        setJob((prev) => {
          if (!prev) return prev
          const progress = event.total ? (event.current / event.total) * 92 : prev.progress
          const stages = prev.stages.map((stage) =>
            stage.key === 'synthesize'
              ? { ...stage, state: 'running' as const, label: `合成中 · ${event.current}/${event.total} 段`, detail: event.detail }
              : stage
          )
          return { ...prev, progress: Math.max(prev.progress, Math.min(96, progress)), stages }
        })
      } else if (event.type === 'cancelled') {
        setJob((prev) => (prev ? { ...finishStages(prev, 'done'), error: '已取消生成' } : prev))
      }
    })
    return remove
  }, [])

  const isReady = ttsStatus.state === 'ready'
  const isBusy = ttsStatus.state === 'busy' || job?.running
  const loadedSame = isReady && gpt && sovits && ttsStatus.models.gpt === gpt.path && ttsStatus.models.sovits === sovits.path
  const selectedSize = (gpt?.size || 0) + (sovits?.size || 0)

  useEffect(() => {
    if (!job?.running) return
    const timer = window.setTimeout(() => scrollWithinContent(progressAnchor.current, 'center'), 120)
    return () => window.clearTimeout(timer)
  }, [job?.running, job?.kind])

  useEffect(() => {
    if (!result) return
    const timer = window.setTimeout(() => scrollWithinContent(resultAnchor.current, 'center'), 160)
    return () => window.clearTimeout(timer)
  }, [result])

  async function prepareFile(path: string): Promise<void> {
    try {
      const prepared = await window.api.prepareReference(path)
      setRef({ path: prepared.path, duration: prepared.duration, name: prepared.name })
      setRefText('')
      setVoiceId('')
      setResult(null)
      setSynthError(null)
      if (prepared.duration < 3 || prepared.duration > 10) {
        notify(`参考音频 ${prepared.duration.toFixed(1)} 秒，建议控制在 3–10 秒`, 'warning')
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function chooseAudio(): Promise<void> {
    const [path] = await window.api.chooseAudioFiles(false)
    if (path) await prepareFile(path)
  }

  async function selectVoice(id: string): Promise<void> {
    setVoiceId(id)
    const voice = voices.find((item) => item.id === id)
    if (!voice) return
    setRef({ path: voice.audioPath, duration: voice.duration, name: voice.name })
    setRefText(voice.transcript)
    setRefLang(voice.promptLang)
    setResult(null)
  }

  async function ensureTtsLoaded(): Promise<void> {
    if (!gpt || !sovits) throw new Error('没有可用的 GPT / SoVITS 模型，请检查整合包')
    if (loadedSame) return
    setSynthError(null)
    setJob({
      kind: 'load',
      running: true,
      progress: 2,
      startedAt: Date.now(),
      stages: [{ key: 'load', label: '启动推理进程', detail: '首次启动需要加载运行时，可能需要 1–3 分钟', state: 'running' }]
    })
    try {
      await window.api.tts.load({ gptPath: gpt.path, sovitsPath: sovits.path })
      setJob((prev) => (prev ? finishStages(prev, 'done') : prev))
      notify('v5turbo 模型已加载', 'success')
    } catch (error) {
      setJob((prev) => (prev ? { ...finishStages(prev, 'error'), error: error instanceof Error ? error.message : String(error) } : prev))
      throw error
    } finally {
    }
  }

  async function loadModels(): Promise<void> {
    try {
      await ensureTtsLoaded()
      setTimeout(() => setJob((prev) => (prev?.kind === 'load' ? null : prev)), 500)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  function resetAdvanced(): void {
    setSpeed(DEFAULT_PARAMS.speed)
    setSplitMethod(DEFAULT_PARAMS.splitMethod)
    setTopK(DEFAULT_PARAMS.topK)
    setTopP(DEFAULT_PARAMS.topP)
    setTemperature(DEFAULT_PARAMS.temperature)
    setRepetitionPenalty(DEFAULT_PARAMS.repetitionPenalty)
    setSeed(DEFAULT_PARAMS.seed)
    setBatchSize(DEFAULT_PARAMS.batchSize)
    setSampleSteps(DEFAULT_PARAMS.sampleSteps)
  }

  function reuseSeed(value: number): void {
    setSeed(value)
    setAdvanced(true)
    notify(`已填入随机种子 ${value}，下一次生成会复现这条语音`, 'info')
    window.setTimeout(() => scrollWithinContent(advancedAnchor.current, 'center'), 120)
  }

  async function generate(): Promise<void> {
    if (!ref) {
      notify('先导入一段参考音频', 'warning')
      return
    }
    if (!refText.trim()) {
      notify('参考文本不能为空，可以用“识别文字”自动填入', 'warning')
      return
    }
    if (!targetText.trim()) {
      notify('请输入要合成的台词', 'warning')
      return
    }
    setResult(null)
    setSynthError(null)
    setResultText(targetText)
    try {
      await ensureTtsLoaded()
      setJob({
        kind: 'synth',
        running: true,
        progress: 4,
        startedAt: Date.now(),
        stages: [{ key: 'prepare', label: '准备合成', state: 'running' }]
      })
      const res = await window.api.tts.synthesize({
        text: targetText,
        textLang,
        promptText: refText,
        promptLang: refLang,
        refAudioPath: ref.path,
        speed,
        splitMethod,
        topK,
        topP,
        temperature,
        repetitionPenalty,
        seed,
        batchSize,
        sampleSteps,
        fragmentInterval: 0.3,
        parallelInfer: true,
        outputPath: '',
        voiceId: voiceId || undefined
      })
      setResult(res)
      setJob((prev) => (prev ? finishStages(prev, 'done') : prev))
      void window.api.history.list().then(setHistory)
      notify(`生成完成 · ${res.duration.toFixed(1)} 秒 · ${res.elapsed.toFixed(1)} 秒耗时`, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSynthError(message)
      setJob((prev) => (prev ? { ...finishStages(prev, 'error'), error: message } : prev))
      if (!message.includes('取消')) notify(message, 'error')
    } finally {
    }
  }

  async function transcribeReference(): Promise<void> {
    if (!ref) {
      notify('先导入参考音频', 'warning')
      return
    }
    setAsrInline({ running: true, label: '加载识别模型…', startedAt: Date.now() })
    try {
      await window.api.asr.load('sensevoice')
      setAsrInline((prev) => ({ ...prev, label: '识别参考音频…' }))
      const results = await window.api.asr.transcribe({
        files: [ref.path],
        language: refLang === 'auto' ? 'auto' : refLang
      })
      const text = results[0]?.text?.trim()
      if (!text) throw new Error('没有识别出文字，请换一段更清晰的音频')
      setRefText(text)
      notify('参考文本已填入，可继续修改', 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setAsrInline({ running: false, label: '' })
    }
  }

  async function saveVoice(): Promise<void> {
    if (!ref) return
    try {
      const next = await window.api.voices.import({
        sourcePath: ref.path,
        name: voiceName || ref.name,
        transcript: refText,
        promptLang: refLang
      })
      setVoices(next)
      setSaveOpen(false)
      const created = next.find((voice) => voice.name === (voiceName || ref.name))
      if (created) setVoiceId(created.id)
      notify('已保存到音色库', 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function importVoices(): Promise<void> {
    try {
      const result = await window.api.voices.importFiles()
      if (!result) return
      setVoices(result.voices)
      if (result.imported === 0) {
        notify('没有找到可导入的音色包，请选择 .v5t 文件', 'warning')
        return
      }
      notify(`已导入 ${result.imported} 个音色${result.skipped ? `，跳过 ${result.skipped} 个` : ''}`, 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function exportVoice(voice: Voice): Promise<void> {
    try {
      const file = await window.api.voices.export(voice.id)
      if (!file) return
      notify(`音色包已导出：${basename(file)}`, 'success')
      await window.api.revealPath(file)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function openVoiceFolder(): Promise<void> {
    try {
      await window.api.voices.openFolder()
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function exportMp3(): Promise<void> {
    if (!result) return
    try {
      const file = await window.api.exportMp3(result.filePath)
      if (file) {
        notify('MP3 已导出', 'success')
        await window.api.revealPath(file)
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function exportSelectedSubtitles(): Promise<void> {
    if (selectedHistory.size === 0) {
      notify('先勾选要导出的记录', 'warning')
      return
    }
    try {
      const paths = history.filter((entry) => selectedHistory.has(entry.id)).map((entry) => entry.filePath)
      const result = await window.api.exportSubtitlesMany(paths, batchFormats)
      if (result) {
        const extra = result.skipped ? `，${result.skipped} 条没有时间轴已跳过` : ''
        notify(`已导出 ${result.written} 份字幕${extra}`, result.skipped ? 'warning' : 'success')
        await window.api.revealPath(result.dir)
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function exportSubtitle(filePath: string, format: SubtitleFormat = subtitleFormat): Promise<void> {
    try {
      const file = await window.api.exportSubtitle(filePath, format)
      if (file) {
        notify('字幕已导出', 'success')
        await window.api.revealPath(file)
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  function toggleHistorySelection(id: string): void {
    setSelectedHistory((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function askDelete(ids: string[], title = '删除生成记录'): void {
    if (!ids.length) return
    setConfirmDelete({
      ids,
      title,
      message: ids.length === 1 ? '这条生成记录和对应的 WAV 文件会被永久删除。' : `选中的 ${ids.length} 条生成记录和对应 WAV 文件会被永久删除。`
    })
  }

  async function confirmDeleteRecords(): Promise<void> {
    if (!confirmDelete) return
    const ids = confirmDelete.ids
    try {
      const next = await window.api.history.removeMany(ids)
      setHistory(next)
      setSelectedHistory((prev) => new Set([...prev].filter((id) => next.some((entry) => entry.id === id))))
      const resultId = result?.historyId || history.find((entry) => entry.filePath === result?.filePath)?.id
      if (resultId && ids.includes(resultId)) setResult(null)
      setConfirmDelete(null)
      notify(ids.length === 1 ? '已删除生成记录' : `已删除 ${ids.length} 条生成记录`, 'info')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function discardResult(): Promise<void> {
    if (!result) return
    const resultId = result.historyId || history.find((entry) => entry.filePath === result.filePath)?.id
    try {
      if (resultId) {
        const next = await window.api.history.removeMany([resultId])
        setHistory(next)
        setSelectedHistory((prev) => {
          const nextSet = new Set(prev)
          nextSet.delete(resultId)
          return nextSet
        })
      }
      setResult(null)
      notify('已放弃本次生成', 'info')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function discardAndRetry(): Promise<void> {
    if (!result) return
    const resultId = result.historyId || history.find((entry) => entry.filePath === result.filePath)?.id
    try {
      if (resultId) {
        const next = await window.api.history.removeMany([resultId])
        setHistory(next)
      }
    } catch {
      // Even if cleanup fails, still retry with a fresh generation.
    }
    setResult(null)
    await generate()
  }

  async function exportSelectedHistory(): Promise<void> {
    if (selectedHistory.size === 0) {
      notify('先勾选要导出的记录', 'warning')
      return
    }
    try {
      const folder = await window.api.history.export([...selectedHistory])
      if (folder) {
        notify(`已导出 ${selectedHistory.size} 条记录`, 'success')
        await window.api.revealPath(folder)
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const canGenerate = Boolean(ref && refText.trim() && targetText.trim() && !isBusy && gpt && sovits)
  const stepIndex = Math.max(0, STEP_OPTIONS.findIndex((value) => value === sampleSteps))

  return (
    <div className="page tts-page">
      <section className="card model-strip">
        <div className="model-strip-main">
          <div className="model-strip-title">
            <div className="mini-mark"><AudioWaveform size={16} /></div>
            <div>
              <strong>v5turbo 模型</strong>
              <span>{loadedSame ? '已加载 · 可以直接生成' : isReady ? '已加载其他模型 · 生成时会重新加载' : '未加载 · 生成前自动加载'}</span>
            </div>
          </div>
          <div className="model-selects">
            <Field label="GPT 语义模型">
              <Select value={gptId} onChange={setGptId}>
                {bootstrap.models.tts.gpt.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </Select>
            </Field>
            <Field label="SoVITS 音色模型">
              <Select value={sovitsId} onChange={setSovitsId}>
                {bootstrap.models.tts.sovits.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="model-strip-actions">
            <span className="model-size">{formatBytes(selectedSize)}</span>
            <button className="btn ghost small" onClick={loadModels} disabled={isBusy || !gpt || !sovits}>
              {ttsStatus.state === 'loading' || ttsStatus.state === 'starting' ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
              {loadedSame ? '重新加载' : '加载模型'}
            </button>
            {ttsStatus.state !== 'stopped' && (
              <button className="icon-btn small" title="卸载 TTS 并释放显存" onClick={() => void window.api.tts.unload()}>
                <Square size={13} />
              </button>
            )}
          </div>
        </div>
        {!bootstrap.models.tts.gpt.length && (
          <div className="inline-warning">没有找到 v5turbo 模型文件，请检查整合包或到「模型与显存」页刷新。</div>
        )}
      </section>

      <div className="tts-grid">
        <section className="card panel ref-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">REFERENCE</span>
              <h2>参考声音</h2>
            </div>
            <span className="soft-badge">3–10 秒最佳</span>
          </div>

          {!ref ? (
            <DropZone onFiles={(paths) => void prepareFile(paths[0])} onBrowse={() => void chooseAudio()} title="拖入你的参考声音" subtitle="一段干净的人声，3–10 秒即可" />
          ) : (
            <motion.div className="ref-loaded" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
              <div className="ref-file">
                <div className="ref-file-icon"><AudioWaveform size={18} /></div>
                <div className="ref-file-copy">
                  <strong>{ref.name}</strong>
                  <span>{ref.path.includes('ref-') ? '已标准化为 48kHz 单声道 WAV' : ref.path}</span>
                </div>
                <span className="duration-chip">{ref.duration.toFixed(1)}s</span>
                <button className="icon-btn small" title="移除参考音频" onClick={() => { setRef(null); setVoiceId('') }}>
                  <X size={14} />
                </button>
              </div>
              <AudioPlayer src={refUrl.url} durationHint={ref.duration} />
              <div className="ref-actions">
                <button className="btn ghost small" onClick={() => void chooseAudio()}>更换音频</button>
                <button className="btn ghost small" onClick={() => void window.api.revealPath(ref.path)}>
                  <FolderOpen size={13} /> 定位文件
                </button>
              </div>
            </motion.div>
          )}

          <div className="form-row two">
            <Field label="参考语言">
              <Select value={refLang} onChange={setRefLang}>
                {TEXT_LANGS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
            </Field>
            <Field label="音色库">
              <Select value={voiceId} onChange={(id) => void selectVoice(id)} className="voice-select">
                <option value="">临时参考音频</option>
                {voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
              </Select>
            </Field>
          </div>

          <div className="voice-tools">
            <button className="text-btn" onClick={() => void openVoiceFolder()}>
              <FolderOpen size={13} /> 打开音色库文件夹
            </button>
            <button className="text-btn" onClick={() => void importVoices()}>
              <FolderDown size={13} /> 导入 .v5t
            </button>
            {selectedVoice && (
              <button className="text-btn" onClick={() => void exportVoice(selectedVoice)}>
                <Share2 size={13} /> 导出 .v5t
              </button>
            )}
            <span className="voice-count">{voices.length} 个 .v5t</span>
          </div>

          <Field label="参考文本" hint="v5turbo 必填，可与音频不完全一致">
            <div className="textarea-wrap">
              <textarea
                value={refText}
                onChange={(event) => setRefText(event.target.value)}
                placeholder="这段音频里说了什么？点下面的按钮自动识别。"
                rows={4}
              />
              <div className="textarea-foot">
                <button className="btn ghost small" onClick={() => void transcribeReference()} disabled={!ref || asrInline.running}>
                  {asrInline.running ? <Loader2 size={13} className="spin" /> : <Mic size={13} />}
                  {asrInline.running ? <>{asrInline.label} <Elapsed since={asrInline.startedAt || Date.now()} /></> : '识别参考音频'}
                </button>
                <span>{refText.length} 字</span>
              </div>
            </div>
          </Field>

          <div className="ref-foot">
            <button className="btn ghost small" onClick={() => { setVoiceName(selectedVoice?.name || ref?.name || '我的音色'); setSaveOpen(true) }} disabled={!ref || !refText.trim()}>
              <Save size={14} /> 保存到音色库
            </button>
            {selectedVoice && (
              <button className="text-btn danger-text" onClick={async () => {
                const next = await window.api.voices.remove(selectedVoice.id)
                setVoices(next)
                setVoiceId('')
                notify('已删除音色', 'info')
              }}>
                删除当前音色
              </button>
            )}
          </div>
        </section>

        <section className="card panel synth-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">TARGET</span>
              <h2>合成台词</h2>
            </div>
            <span className="soft-badge">{targetText.length} 字</span>
          </div>

          <textarea
            ref={targetRef}
            className="target-text"
            value={targetText}
            onChange={(event) => setTargetText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                if (canGenerate) void generate()
              }
            }}
            placeholder="输入要合成的台词。可以是一段对白、旁白，或一整篇文章。"
            rows={10}
          />

          <div className="form-row two">
            <Field label="目标语言">
              <Select value={textLang} onChange={setTextLang}>
                {TEXT_LANGS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
            </Field>
            <Field label="文本切分">
              <Select value={splitMethod} onChange={setSplitMethod}>
                {SPLIT_METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
            </Field>
          </div>

          <div className="speed-row">
            <Slider label="语速" value={speed} min={0.6} max={1.6} step={0.05} onChange={setSpeed} format={(value) => `${value.toFixed(2)}×`} />
          </div>

          <div className="advanced-head" ref={advancedAnchor}>
            <button className="advanced-toggle" onClick={() => setAdvanced((value) => !value)}>
              <span>高级参数</span>
              <ChevronDown size={15} className={cn(advanced && 'rotated')} />
            </button>
            <button className="text-btn" onClick={resetAdvanced}>恢复默认</button>
          </div>
          <AnimatePresence initial={false}>
            {advanced && (
              <motion.div className="advanced-grid" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }}>
                <Field label="top_k"><input type="number" value={topK} onChange={(event) => setTopK(Number(event.target.value))} min={1} max={100} /></Field>
                <Field label="top_p"><input type="number" step={0.05} value={topP} onChange={(event) => setTopP(Number(event.target.value))} min={0.1} max={1} /></Field>
                <Field label="temperature"><input type="number" step={0.05} value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} min={0.1} max={2} /></Field>
                <Field label="重复惩罚"><input type="number" step={0.05} value={repetitionPenalty} onChange={(event) => setRepetitionPenalty(Number(event.target.value))} min={1} max={2} /></Field>
                <Field label="随机种子">
                  <div className="input-with-btn">
                    <input type="number" value={seed} onChange={(event) => setSeed(Number(event.target.value))} />
                    <button
                      type="button"
                      className={cn('icon-btn', 'small', seed === -1 && 'active')}
                      title="设为随机（-1），生成时自动记录实际种子"
                      aria-label="设为随机种子"
                      onClick={() => setSeed(-1)}
                    >
                      <Dices size={13} />
                    </button>
                  </div>
                </Field>
                <Field label="并行段数"><input type="number" value={batchSize} onChange={(event) => setBatchSize(Math.max(1, Number(event.target.value)))} min={1} max={4} /></Field>
                <div className="field step-field">
                  <span className="field-label">采样步数</span>
                  <div className="step-slider">
                    <input
                      type="range"
                      min={0}
                      max={STEP_OPTIONS.length - 1}
                      step={1}
                      value={stepIndex}
                      onChange={(event) => setSampleSteps(STEP_OPTIONS[Number(event.target.value)])}
                    />
                    <div className="step-ticks">
                      {STEP_OPTIONS.map((value) => (
                        <button type="button" key={value} className={cn(sampleSteps === value && 'active')} onClick={() => setSampleSteps(value)}>{value}</button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="advanced-note">v5turbo 官方默认：top_k 15 · top_p 1 · temperature 1 · 重复惩罚 1.35 · 采样步数 4 · 种子 -1 为随机</div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="generate-row">
            <button className="btn primary xlarge generate-btn" onClick={() => void generate()} disabled={!canGenerate}>
              {isBusy ? <Loader2 size={18} className="spin" /> : <Wand2 size={18} />}
              {job?.kind === 'synth' && job.running ? '正在生成…' : ttsStatus.state === 'loading' || ttsStatus.state === 'starting' ? '加载模型中…' : '生成语音'}
              <span className="kbd">Ctrl ↵</span>
            </button>
            {job?.running && (
              <button className="btn ghost large" onClick={() => void window.api.tts.cancel()}>
                <Square size={14} fill="currentColor" /> 停止
              </button>
            )}
          </div>

          {synthError && (
            <div className="inline-error">
              <AlertCircle size={15} />
              <span>{synthError}</span>
            </div>
          )}

          <div ref={progressAnchor} />
          <AnimatePresence>
            {job && (
              <ProgressTimeline
                title={job.kind === 'load' ? '加载 v5turbo 模型' : '生成语音'}
                stages={job.stages}
                progress={job.progress}
                running={job.running}
                startedAt={job.startedAt}
                tone={job.error ? 'error' : 'default'}
                onCancel={job.kind === 'synth' ? () => void window.api.tts.cancel() : undefined}
                cancelLabel="停止生成"
              />
            )}
          </AnimatePresence>
        </section>
      </div>

      <div ref={resultAnchor} />
      <AnimatePresence>
        {result && (
          <motion.section className="card result-card" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
            <div className="result-main">
              <div className="result-head">
                <div className="result-icon"><Check size={18} /></div>
                <div>
                  <span className="eyebrow">RESULT</span>
                  <h2>生成完成</h2>
                  <p>{result.duration.toFixed(2)} 秒 · {result.segments} 段 · 耗时 {result.elapsed.toFixed(1)} 秒</p>
                </div>
              </div>
              <AudioPlayer src={resultUrl.url} durationHint={result.duration} />
              {typeof result.seed === 'number' && (
                <div className="seed-row">
                  <span>随机种子 <code>{result.seed}</code></span>
                  <button className="btn ghost small" onClick={() => reuseSeed(result.seed as number)}>
                    <Dices size={14} /> 复用种子
                  </button>
                </div>
              )}
              {result.warnings && result.warnings.length > 0 && (
                <div className="seed-row" role="alert">
                  <span>⚠ {result.warnings.join('；')}</span>
                </div>
              )}
              <div className="result-actions">
                <button className="btn ghost small" onClick={() => void window.api.revealPath(result.filePath)}><FolderOpen size={14} /> 打开文件夹</button>
                <button className="btn ghost small" onClick={() => void exportMp3()}><Download size={14} /> 导出 MP3</button>
                <span className="split-btn">
                  <button className="btn ghost small" onClick={() => void exportSubtitle(result.filePath)} disabled={!result.timingPath}>
                    <Captions size={14} /> 导出字幕
                  </button>
                  <select
                    className="split-select"
                    value={subtitleFormat}
                    onChange={(event) => setSubtitleFormat(event.target.value as SubtitleFormat)}
                    disabled={!result.timingPath}
                    aria-label="字幕格式"
                  >
                    {SUBTITLE_FORMATS.map((f) => (
                      <option key={f} value={f}>{FORMAT_LABEL[f]}</option>
                    ))}
                  </select>
                </span>
                <button className="btn ghost small danger-text" onClick={() => void discardResult()}><Trash2 size={14} /> 放弃</button>
                <button className="btn ghost small" onClick={() => void discardAndRetry()} disabled={!canGenerate}><RotateCcw size={14} /> 放弃并重试</button>
              </div>
            </div>
            <div className="result-text">
              <span className="eyebrow">TEXT</span>
              <p>{resultText || targetText}</p>
              <span className="result-path" title={result.filePath}>{basename(result.filePath)}</span>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      <section className="history-section">
        <div className="section-head">
          <div>
            <span className="eyebrow">LIBRARY</span>
            <h2>最近生成</h2>
          </div>
          <div className="history-toolbar">
            <button
              className="text-btn"
              onClick={() => {
                setHistorySelectMode((value) => !value)
                setSelectedHistory(new Set())
              }}
            >
              {historySelectMode ? '完成' : '批量管理'}
            </button>
            {historySelectMode && (
              <>
                <button className="text-btn" onClick={() => setSelectedHistory(new Set(visibleHistory.map((entry) => entry.id)))}>
                  全选
                </button>
                <button className="text-btn" onClick={() => void exportSelectedHistory()} disabled={selectedHistory.size === 0}>
                  <Download size={13} /> 导出选中{selectedHistory.size ? `（${selectedHistory.size}）` : ''}
                </button>
                <span className="batch-formats">
                  {SUBTITLE_FORMATS.map((f) => (
                    <button
                      key={f}
                      type="button"
                      className={cn('chip', batchFormats.includes(f) && 'active')}
                      onClick={() =>
                        setBatchFormats((prev) => {
                          const next = prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]
                          return next.length ? next : [f]
                        })
                      }
                    >
                      {FORMAT_LABEL[f]}
                    </button>
                  ))}
                </span>
                <button className="text-btn" onClick={() => void exportSelectedSubtitles()} disabled={selectedHistory.size === 0}>
                  <Captions size={13} /> 导出字幕{selectedHistory.size ? `（${selectedHistory.size}）` : ''}
                </button>
                <button className="text-btn danger-text" onClick={() => askDelete([...selectedHistory], '删除选中的生成记录')} disabled={selectedHistory.size === 0}>
                  <Trash2 size={13} /> 删除选中{selectedHistory.size ? `（${selectedHistory.size}）` : ''}
                </button>
              </>
            )}
            <button className="text-btn" onClick={() => void window.api.history.list().then(setHistory)}>
              <RefreshCw size={13} /> 刷新
            </button>
          </div>
        </div>
        {history.length === 0 ? (
          <div className="empty-strip"><Clock3 size={18} /><span>还没有生成记录。第一次生成后会出现在这里。</span></div>
        ) : (
          <div className="history-list">
            {visibleHistory.map((entry) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                selected={selectedHistory.has(entry.id)}
                selectMode={historySelectMode}
                onToggle={toggleHistorySelection}
                onDelete={(item) => askDelete([item.id])}
                onReuseSeed={reuseSeed}
              />
            ))}
          </div>
        )}
        {history.length > visibleHistory.length && (
          <div className="history-more">仅显示最近 {visibleHistory.length} 条，共 {history.length} 条。批量删除/导出会作用于勾选项。</div>
        )}
      </section>

      <Modal
        open={saveOpen}
        title="保存到音色库"
        subtitle="保存为单个 .v5t 文件（参考音频 + 文本 + 语言），可直接分享、导入。"
        onClose={() => setSaveOpen(false)}
        footer={
          <>
            <button className="btn ghost" onClick={() => setSaveOpen(false)}>取消</button>
            <button className="btn primary" onClick={() => void saveVoice()}>保存音色</button>
          </>
        }
      >
        <Field label="音色名称">
          <input value={voiceName} onChange={(event) => setVoiceName(event.target.value)} placeholder="例如：旁白 · 温柔女声" autoFocus />
        </Field>
        <div className="modal-note">参考文本：{refText.slice(0, 80) || '（空）'}</div>
      </Modal>

      <Modal
        open={Boolean(confirmDelete)}
        title={confirmDelete?.title || '删除生成记录'}
        subtitle="删除后无法恢复。"
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <button className="btn ghost" onClick={() => setConfirmDelete(null)}>取消</button>
            <button className="btn danger" onClick={() => void confirmDeleteRecords()}>确认删除</button>
          </>
        }
      >
        <p className="confirm-message">{confirmDelete?.message}</p>
      </Modal>
    </div>
  )
}
