import { useMemo, useState } from 'react'
import { Film, Loader2, Play, Users } from 'lucide-react'
import type { DiarizeLine, DiarizeResult } from '@shared/types'
import { basename, cn } from '../lib/format'
import { useAudioUrl } from '../lib/useAudioUrl'

const COLORS = ['#8b5cf6', '#22d3ee', '#f472b6', '#f59e0b', '#34d399', '#60a5fa', '#f87171', '#a3e635']
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const t = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

interface Props {
  notify: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void
}

/** Speaker diarization for dubbing: who speaks when, rename/reassign/merge, create voices from speakers. */
export function DiarizePanel({ notify }: Props): JSX.Element {
  const [src, setSrc] = useState('')
  const [num, setNum] = useState(0)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DiarizeResult | null>(null)
  const [lines, setLines] = useState<DiarizeLine[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const audio = useAudioUrl(result?.audioPath || '')

  const speakers = useMemo(() => [...new Set(lines.map((l) => l.speaker))].sort(), [lines])
  const color = (s: string): string => COLORS[(Number(s.replace(/\D/g, '')) - 1) % COLORS.length] || COLORS[0]
  const label = (s: string): string => names[s] || s

  const play = (start: number, end: number): void => {
    if (!audio.url) return
    const a = new Audio(audio.url)
    a.addEventListener('loadedmetadata', () => {
      a.currentTime = start
      void a.play().catch((error) => notify(errText(error), 'error'))
    })
    a.addEventListener('error', () => notify(a.error?.message || '音频播放失败', 'error'))
    a.addEventListener('timeupdate', () => a.currentTime >= end && a.pause())
  }

  const pick = async (): Promise<void> => {
    const p = await window.api.dub.pickMedia()
    if (p) setSrc(p)
  }

  const run = async (): Promise<void> => {
    if (!src) return
    setBusy(true)
    try {
      const r = await window.api.dub.diarize(src, { numSpeakers: num || undefined })
      setResult(r)
      setLines(r.items)
      setNames({})
      notify(`识别出 ${r.numSpeakers} 位说话人，${r.items.length} 句`, 'success')
    } catch (e) {
      notify(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const reassign = (i: number, s: string): void => setLines(lines.map((l, k) => (k === i ? { ...l, speaker: s } : l)))
  const merge = (from: string, to: string): void => setLines(lines.map((l) => (l.speaker === from ? { ...l, speaker: to } : l)))

  const createVoice = async (s: string): Promise<void> => {
    const ref = result?.references[s]?.[0]
    const fallback = lines.filter((l) => l.speaker === s).sort((a, b) => b.end - b.start - (a.end - a.start))[0]
    const span = ref || fallback
    if (!span || !result) return
    const text = ref ? ref.text || lines.find((l) => l.start === ref.start)?.text : fallback?.text
    try {
      const v = await window.api.dub.voiceFromSpan(result.sourcePath || src, span.start, span.end, label(s), text || undefined)
      notify(`已创建音色「${v.name}」`, 'success')
    } catch (e) {
      notify(errText(e), 'error')
    }
  }

  const exportScript = async (): Promise<void> => {
    const data = lines.map((l, i) => ({ id: String(i + 1).padStart(3, '0'), start: l.start, end: l.end, speaker: label(l.speaker), text: l.text || '', lang: l.lang }))
    const file = await window.api.dub.saveScript(src, data)
    if (file) notify(`已导出：${basename(file)}`, 'success')
  }

  return (
    <section className="card panel diar-panel">
      <div className="panel-head">
        <div>
          <span className="eyebrow">DIARIZATION</span>
          <h2>
            <Users size={16} /> 说话人分离（译制）
          </h2>
        </div>
      </div>
      <div className="diar-row">
        <button className="btn small" onClick={() => void pick()}>
          <Film size={14} /> 选择视频 / 音频
        </button>
        <span className="diar-src" title={src}>
          {src ? basename(src) : '未选择'}
        </span>
        <label className="diar-num">
          人数
          <select value={num} onChange={(e) => setNum(Number(e.target.value))}>
            <option value={0}>自动</option>
            {[2, 3, 4, 5, 6, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button className="btn small primary" disabled={!src || busy} onClick={() => void run()}>
          {busy ? <Loader2 size={14} className="spin" /> : null} 开始分离
        </button>
      </div>
      <p className="diar-note">重叠说话会归给其中一人；短于 1 秒的句子、音色相近的人、有背景音乐时容易分错。已知人数时请手动指定。</p>

      {result && (
        <>
          <div className="diar-speakers">
            {speakers.map((s) => (
              <div key={s} className="diar-spk" style={{ borderColor: color(s) }}>
                <i style={{ background: color(s) }} />
                <input value={label(s)} onChange={(e) => setNames({ ...names, [s]: e.target.value })} />
                <span>{lines.filter((l) => l.speaker === s).length} 句</span>
                {result.references[s]?.[0] && (
                  <button className="icon-btn small" title="试听代表片段" onClick={() => play(result.references[s][0].start, result.references[s][0].end)}>
                    <Play size={12} />
                  </button>
                )}
                <button className="btn small ghost" onClick={() => void createVoice(s)}>
                  创建音色
                </button>
                {speakers.length > 1 && (
                  <select value="" onChange={(e) => e.target.value && merge(s, e.target.value)} title="并入其他说话人">
                    <option value="">合并到…</option>
                    {speakers
                      .filter((x) => x !== s)
                      .map((x) => (
                        <option key={x} value={x}>
                          {label(x)}
                        </option>
                      ))}
                  </select>
                )}
              </div>
            ))}
            <span className="spacer" />
            <button className="btn small" onClick={() => void exportScript()}>
              导出逐句稿
            </button>
          </div>
          <div className="diar-lines">
            {lines.map((l, i) => (
              <div key={i} className={cn('diar-line', l.confidence < 0.5 && 'low')}>
                <i style={{ background: color(l.speaker) }} />
                <select value={l.speaker} onChange={(e) => reassign(i, e.target.value)}>
                  {speakers.map((s) => (
                    <option key={s} value={s}>
                      {label(s)}
                    </option>
                  ))}
                </select>
                <span className="diar-time">
                  {t(l.start)}–{t(l.end)}
                </span>
                <span className="diar-text">{l.text || '（未识别）'}</span>
                <button className="icon-btn small" onClick={() => play(l.start, l.end)} title="播放">
                  <Play size={12} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
