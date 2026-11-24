import { motion } from 'framer-motion'
import { Captions, Dices, FolderOpen, Trash2 } from 'lucide-react'
import type { HistoryEntry } from '@shared/types'
import { AudioPlayer } from './AudioPlayer'
import { basename, cn, formatRelative } from '../lib/format'
import { useAudioUrl } from '../lib/useAudioUrl'

interface Props {
  entry: HistoryEntry
  selected: boolean
  selectMode: boolean
  onToggle: (id: string) => void
  onDelete: (entry: HistoryEntry) => void
  onReuseSeed: (seed: number) => void
}

export function HistoryRow({ entry, selected, selectMode, onToggle, onDelete, onReuseSeed }: Props): JSX.Element {
  const audio = useAudioUrl(entry.filePath)
  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 10 }}
      className={cn('history-row', selected && 'selected', selectMode && 'selectable')}
      onClick={() => selectMode && onToggle(entry.id)}
    >
      {selectMode && (
        <input
          type="checkbox"
          className="history-check"
          checked={selected}
          onChange={() => onToggle(entry.id)}
          onClick={(event) => event.stopPropagation()}
          aria-label="选择这条生成记录"
        />
      )}
      <div className="history-text" title={entry.text}>
        <strong>{entry.text || '（无文本）'}</strong>
        <span>
          {entry.voiceName || '临时音色'} · {entry.duration.toFixed(1)}s · {formatRelative(entry.createdAt)}
          {typeof entry.seed === 'number' ? ` · 种子 ${entry.seed}` : ''}
        </span>
        <em>{basename(entry.filePath)}</em>
      </div>
      <div className="history-wave" onClick={(event) => event.stopPropagation()}>
        {audio.url ? (
          <AudioPlayer src={audio.url} compact durationHint={entry.duration} />
        ) : (
          <div className="wave-skeleton">{audio.error ? '音频不可用' : '读取波形…'}</div>
        )}
      </div>
      <div className="history-row-actions" onClick={(event) => event.stopPropagation()}>
        {typeof entry.seed === 'number' && (
          <button className="icon-btn small seed-btn" title={`复用种子 ${entry.seed}`} onClick={() => onReuseSeed(entry.seed as number)}>
            <Dices size={14} />
          </button>
        )}
        <button
          className="icon-btn small"
          title="导出字幕 (SRT)"
          onClick={() =>
            void window.api
              .exportSubtitle(entry.filePath, 'srt')
              .then((file) => {
                if (file) void window.api.revealPath(file)
              })
              .catch((error) => window.alert(error instanceof Error ? error.message : String(error)))
          }
        >
          <Captions size={14} />
        </button>
        <button className="icon-btn small" title="打开位置" onClick={() => void window.api.revealPath(entry.filePath)}>
          <FolderOpen size={14} />
        </button>
        <button className="icon-btn small danger" title="删除" onClick={() => onDelete(entry)}>
          <Trash2 size={14} />
        </button>
      </div>
    </motion.div>
  )
}
