import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, Check, Circle, Loader2, Square } from 'lucide-react'
import { cn, formatClock } from '../lib/format'

export type StageState = 'pending' | 'running' | 'done' | 'error' | 'skip'

export interface StageItem {
  key: string
  label: string
  state: StageState
  detail?: string
}

interface Props {
  title?: string
  stages: StageItem[]
  progress: number
  running: boolean
  startedAt?: number
  onCancel?: () => void
  cancelLabel?: string
  tone?: 'default' | 'error'
}

export function ProgressTimeline({ title = '任务进度', stages, progress, running, startedAt, onCancel, cancelLabel = '停止任务', tone = 'default' }: Props): JSX.Element {
  const elapsed = startedAt ? formatClock(Date.now() - startedAt) : null
  return (
    <motion.section
      className={cn('progress-card', tone === 'error' && 'has-error')}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.22 }}
    >
      <div className="progress-head">
        <div>
          <span className="eyebrow">{running ? 'IN PROGRESS' : tone === 'error' ? 'FAILED' : 'COMPLETED'}</span>
          <h3>{title}</h3>
        </div>
        <div className="progress-meta">
          {elapsed && <span className="mono">{elapsed}</span>}
          <span className="progress-percent">{Math.round(progress)}%</span>
          {running && onCancel && (
            <button className="btn ghost small" onClick={onCancel}>
              <Square size={12} fill="currentColor" />
              {cancelLabel}
            </button>
          )}
        </div>
      </div>
      <div className="progress-track">
        <motion.span
          className={cn('progress-fill', running && 'animated')}
          initial={false}
          animate={{ width: `${Math.max(2, Math.min(100, progress))}%` }}
          transition={{ type: 'spring', stiffness: 160, damping: 26 }}
        />
      </div>
      <div className="stage-list">
        <AnimatePresence initial={false}>
          {stages.map((stage) => (
            <motion.div
              key={stage.key}
              className={cn('stage-item', stage.state)}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 6 }}
              transition={{ duration: 0.18 }}
            >
              <span className="stage-icon">
                {stage.state === 'running' ? (
                  <Loader2 size={14} className="spin" />
                ) : stage.state === 'done' ? (
                  <Check size={14} />
                ) : stage.state === 'error' ? (
                  <AlertCircle size={14} />
                ) : (
                  <Circle size={10} />
                )}
              </span>
              <span className="stage-label">{stage.label}</span>
              {stage.detail && <span className="stage-detail">{stage.detail}</span>}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.section>
  )
}
