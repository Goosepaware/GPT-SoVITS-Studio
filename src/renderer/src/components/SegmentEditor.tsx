import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Dices, Play, RotateCcw, Undo2, X } from 'lucide-react'
import type { SegEditState, SegParamsT, SegPreviewSession, SegTiming } from '@shared/types'
import { cn } from '../lib/format'
import { useAudioUrl } from '../lib/useAudioUrl'

const FLAG_TEXT: Record<string, string> = {
  silent: '静音',
  too_short: '过短',
  too_long: '过长',
  long_pause: '长停顿',
  clipped: '削波'
}

const PARAM_FIELDS: { key: keyof SegParamsT; label: string; step: number; min: number; max: number }[] = [
  { key: 'speed', label: '语速', step: 0.05, min: 0.5, max: 2 },
  { key: 'temperature', label: '温度', step: 0.05, min: 0.1, max: 2 },
  { key: 'sampleSteps', label: '采样步数', step: 1, min: 1, max: 32 },
  { key: 'topK', label: 'topK', step: 1, min: 1, max: 100 },
  { key: 'topP', label: 'topP', step: 0.05, min: 0.1, max: 1 },
  { key: 'repetitionPenalty', label: '重复惩罚', step: 0.05, min: 1, max: 2 }
]

const fmt = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Plays a [start,end) window of a file through one shared <audio>. */
function useRangePlayer(): { play: (url: string, start?: number, end?: number) => void; stop: () => void } {
  const ref = useRef<HTMLAudioElement | null>(null)
  const stopAt = useRef<number | null>(null)
  useEffect(() => {
    const a = new Audio()
    ref.current = a
    const tick = (): void => {
      if (stopAt.current !== null && a.currentTime >= stopAt.current) a.pause()
    }
    a.addEventListener('timeupdate', tick)
    return () => {
      a.pause()
      a.removeEventListener('timeupdate', tick)
    }
  }, [])
  return {
    play: (url, start = 0, end) => {
      const a = ref.current
      if (!a) return
      stopAt.current = end ?? null
      const go = (): void => {
        a.currentTime = start
        void a.play()
      }
      if (a.src !== url) {
        a.src = url
        a.addEventListener('loadedmetadata', go, { once: true })
      } else go()
    },
    stop: () => ref.current?.pause()
  }
}

function CandidateRow(props: {
  path: string
  label: string
  meta: string
  flags: string[]
  chosen: boolean
  onChoose: () => void
  onPlay: (url: string) => void
  onPlayContext: (url: string) => void
}): JSX.Element {
  const a = useAudioUrl(props.path)
  return (
    <div className={cn('seg-cand', props.chosen && 'chosen')} onClick={props.onChoose}>
      <input type="radio" readOnly checked={props.chosen} />
      <strong>{props.label}</strong>
      <span>{props.meta}</span>
      {props.flags.map((f) => (
        <em key={f} className="seg-flag">
          {FLAG_TEXT[f] || f}
        </em>
      ))}
      <span className="spacer" />
      <button className="icon-btn small" disabled={!a.url} title="播放候选" onClick={(e) => (e.stopPropagation(), a.url && props.onPlay(a.url))}>
        <Play size={13} />
      </button>
      <button className="btn small ghost" disabled={!a.url} title="前一句 → 候选 → 后一句" onClick={(e) => (e.stopPropagation(), a.url && props.onPlayContext(a.url))}>
        带上下文
      </button>
    </div>
  )
}

export function SegmentEditor({ audioPath, onClose }: { audioPath: string; onClose: () => void }): JSX.Element {
  const [timing, setTiming] = useState<SegTiming | null>(null)
  const [state, setState] = useState<SegEditState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [sel, setSel] = useState<number[]>([])
  const [anchor, setAnchor] = useState<number | null>(null)
  const [seed, setSeed] = useState<number>(-1)
  const [params, setParams] = useState<SegParamsT>({})
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [count, setCount] = useState(2)
  const [matchLoudness, setMatchLoudness] = useState(true)
  const [preview, setPreview] = useState<SegPreviewSession | null>(null)
  const [choice, setChoice] = useState<Record<number, number>>({})
  const main = useAudioUrl(audioPath)
  const player = useRangePlayer()

  const reload = async (): Promise<void> => {
    try {
      const r = await window.api.segments.list(audioPath)
      setTiming(r.timing)
      setState(r.state)
      setError('')
    } catch (e) {
      setError(errText(e))
    }
  }
  useEffect(() => {
    void reload()
    return () => {
      player.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioPath])

  const discardPreview = (): void => {
    if (preview) void window.api.segments.discard(preview.editId)
    setPreview(null)
    setChoice({})
  }

  const ordered = useMemo(() => {
    const segs = timing?.segments || []
    return [...segs].sort((a, b) => Number(!!b.flags?.length) - Number(!!a.flags?.length) || a.index - b.index)
  }, [timing])

  const legacy = !!timing && (!timing.source || !timing.source.refAudioPath)
  const baseParams: SegParamsT = { ...(timing?.source?.params || {}) }
  const first = sel.length ? timing?.segments[sel[0]] : undefined
  const effective: SegParamsT = { ...baseParams, ...(first?.params || {}), ...params }

  const clickSeg = (i: number, shift: boolean): void => {
    discardPreview()
    if (shift && anchor !== null) {
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor]
      setSel(Array.from({ length: b - a + 1 }, (_, k) => a + k))
    } else {
      setSel(sel.length === 1 && sel[0] === i ? [] : [i])
      setAnchor(i)
    }
  }

  const runPreview = async (indices: number[]): Promise<void> => {
    if (!indices.length) return
    discardPreview()
    setBusy('生成试听中…首次需要加载模型')
    setError('')
    try {
      const t: Record<string, string> = {}
      for (const i of indices) if (texts[i] !== undefined && texts[i].trim()) t[String(i)] = texts[i].trim()
      const r = await window.api.segments.preview(audioPath, indices, { seed: seed >= 0 ? seed : undefined, params, texts: t }, count)
      setPreview(r)
      const c: Record<number, number> = {}
      for (const s of r.segments) {
        const best = [...s.candidates].sort((a, b) => a.flags.length - b.flags.length)[0]
        if (best) c[s.index] = best.candidate
      }
      setChoice(c)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy('')
    }
  }

  const commit = async (): Promise<void> => {
    if (!preview) return
    const choices = Object.entries(choice).map(([index, candidate]) => ({ index: Number(index), candidate }))
    if (!choices.length) return
    if (!window.confirm(`用选中的候选替换 ${choices.length} 句？替换后这条记录不能再复用参数，但仍可导出字幕，并可撤销。`)) return
    setBusy('替换中…')
    try {
      const t = await window.api.segments.commit(audioPath, preview.editId, choices, matchLoudness)
      setTiming(t)
      setPreview(null)
      setChoice({})
      setTexts({})
      await reload()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy('')
    }
  }

  const revert = async (mode: 'original' | 'last'): Promise<void> => {
    if (!window.confirm(mode === 'original' ? '还原到最初生成的音频？所有替换都会丢失。' : '撤销上一次替换？')) return
    discardPreview()
    try {
      setTiming(await window.api.segments.revert(audioPath, mode))
      await reload()
    } catch (e) {
      setError(errText(e))
    }
  }

  const playContext = (candUrl: string, index: number): void => {
    // Sequential: previous sentence (original) → candidate → next sentence (original).
    if (!timing || !main.url) return
    const segs = timing.segments
    const prev = segs[index - 1]
    const next = segs[index + 1]
    const queue: (() => Promise<void>)[] = []
    const playOnce = (url: string, s: number, e?: number): Promise<void> =>
      new Promise((resolve) => {
        const a = new Audio(url)
        a.addEventListener('loadedmetadata', () => {
          a.currentTime = s
          void a.play()
        })
        a.addEventListener('timeupdate', () => {
          if (e !== undefined && a.currentTime >= e) {
            a.pause()
            resolve()
          }
        })
        a.addEventListener('ended', () => resolve())
      })
    player.stop()
    if (prev) queue.push(() => playOnce(main.url as string, prev.start, segs[index].start))
    queue.push(() => playOnce(candUrl, 0))
    if (next) queue.push(() => playOnce(main.url as string, segs[index].end, next.end))
    void queue.reduce((p, f) => p.then(f), Promise.resolve())
  }

  const flagged = (timing?.segments || []).filter((s) => s.flags?.length).map((s) => s.index)
  const total = timing?.duration || 1

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card seg-editor" onClick={(e) => e.stopPropagation()}>
        <header className="seg-head">
          <h3>分段编辑</h3>
          {state?.edited && <span className="edited-badge">已编辑 {state.editCount} 次</span>}
          <span className="spacer" />
          <button className="btn small ghost" disabled={!state?.hasPrevious || !!busy} onClick={() => void revert('last')}>
            <Undo2 size={13} /> 撤销上一步
          </button>
          <button className="btn small ghost" disabled={!state?.hasOriginal || !!busy} onClick={() => void revert('original')}>
            <RotateCcw size={13} /> 还原原始
          </button>
          <button className="icon-btn small" onClick={onClose} title="关闭">
            <X size={15} />
          </button>
        </header>

        {error && <div className="seg-error">{error}</div>}
        {legacy && <div className="seg-error">这是旧版本生成的时间轴，没有保存音色信息，暂不支持重新生成；仍可导出字幕。</div>}

        {timing && (
          <div className="seg-bar" title="整段时间轴，点击选择句子">
            {timing.segments.map((s) => (
              <div
                key={s.index}
                className={cn('seg-bar-item', sel.includes(s.index) && 'active', Boolean(s.flags?.length) && 'flagged', s.edited && 'edited')}
                style={{ left: `${(s.start / total) * 100}%`, width: `${Math.max(0.3, ((s.end - s.start) / total) * 100)}%` }}
                onClick={(e) => clickSeg(s.index, e.shiftKey)}
              />
            ))}
          </div>
        )}

        <div className="seg-body">
          <div className="seg-list">
            {ordered.map((s) => (
              <div
                key={s.index}
                className={cn('seg-item', sel.includes(s.index) && 'active', Boolean(s.flags?.length) && 'flagged')}
                onClick={(e) => clickSeg(s.index, e.shiftKey)}
              >
                <b>{s.index + 1}</b>
                <span className="seg-text">{s.text}</span>
                <span className="seg-time">
                  {fmt(s.start)} · {(s.end - s.start).toFixed(1)}s
                </span>
                {s.edited && <em className="seg-flag ok">已替换</em>}
                {(s.flags || []).map((f) => (
                  <em key={f} className="seg-flag">
                    {FLAG_TEXT[f] || f}
                  </em>
                ))}
                <button
                  className="icon-btn small"
                  title="播放这一句"
                  disabled={!main.url}
                  onClick={(e) => (e.stopPropagation(), main.url && player.play(main.url, s.start, s.end))}
                >
                  <Play size={12} />
                </button>
              </div>
            ))}
          </div>

          <div className="seg-side">
            {!sel.length ? (
              <div className="seg-hint">
                选择一句，按住 Shift 可连选多句。
                {flagged.length > 0 && !legacy && (
                  <button className="btn small" disabled={!!busy} onClick={() => (setSel(flagged), void runPreview(flagged))}>
                    重生所有异常句（{flagged.length}）
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="seg-sel-title">
                  已选 {sel.length} 句：{sel.map((i) => i + 1).join('、')}
                </div>
                {sel.map((i) => (
                  <textarea
                    key={i}
                    className="seg-textarea"
                    rows={2}
                    value={texts[i] ?? timing?.segments[i]?.text ?? ''}
                    onChange={(e) => setTexts({ ...texts, [i]: e.target.value })}
                    title={`第 ${i + 1} 句文本（可修改，字幕会同步）`}
                  />
                ))}
                <div className="seg-params">
                  <label>
                    种子
                    <div className="row">
                      <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} title="-1 为随机" />
                      <button className="icon-btn small" title="随机" onClick={() => setSeed(Math.floor(Math.random() * 2 ** 31))}>
                        <Dices size={13} />
                      </button>
                    </div>
                  </label>
                  {PARAM_FIELDS.map((f) => (
                    <label key={f.key}>
                      {f.label}
                      <input
                        type="number"
                        step={f.step}
                        min={f.min}
                        max={f.max}
                        value={effective[f.key] ?? ''}
                        onChange={(e) => setParams({ ...params, [f.key]: e.target.value === '' ? undefined : Number(e.target.value) })}
                      />
                    </label>
                  ))}
                  <label>
                    候选数
                    <input type="number" min={1} max={8} value={count} onChange={(e) => setCount(Math.max(1, Math.min(8, Number(e.target.value) || 1)))} />
                  </label>
                </div>
                <div className="row">
                  <button className="btn small ghost" onClick={() => (setParams({}), setSeed(-1))}>
                    沿用原参数
                  </button>
                  <span className="spacer" />
                  <button className="btn small primary" disabled={!!busy || legacy} onClick={() => void runPreview(sel)}>
                    生成试听
                  </button>
                </div>
              </>
            )}

            {busy && <div className="seg-busy">{busy}</div>}

            {preview && (
              <div className="seg-cands">
                {preview.segments.map((s) => (
                  <div key={s.index} className="seg-cand-group">
                    <div className="seg-sel-title">
                      第 {s.index + 1} 句 · {s.text.slice(0, 30)}
                    </div>
                    {s.candidates.map((c) => (
                      <CandidateRow
                        key={c.candidate}
                        path={c.path}
                        label={`候选 ${c.candidate + 1}`}
                        meta={`${c.duration.toFixed(2)}s · 种子 ${c.seed}`}
                        flags={c.flags}
                        chosen={choice[s.index] === c.candidate}
                        onChoose={() => setChoice({ ...choice, [s.index]: c.candidate })}
                        onPlay={(url) => player.play(url)}
                        onPlayContext={(url) => playContext(url, s.index)}
                      />
                    ))}
                  </div>
                ))}
                <label className="seg-check">
                  <input type="checkbox" checked={matchLoudness} onChange={(e) => setMatchLoudness(e.target.checked)} />
                  匹配前后句响度
                </label>
                <div className="row">
                  <button className="btn small ghost" onClick={discardPreview}>
                    放弃
                  </button>
                  <span className="spacer" />
                  <button className="btn small primary" disabled={!!busy || !Object.keys(choice).length} onClick={() => void commit()}>
                    替换进完整音频
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
