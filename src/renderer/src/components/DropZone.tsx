import { useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { FolderOpen, Music4, UploadCloud } from 'lucide-react'
import { cn } from '../lib/format'

interface Props {
  onFiles: (paths: string[]) => void
  onBrowse: () => void
  multiple?: boolean
  compact?: boolean
  title?: string
  subtitle?: string
  accept?: string[]
}

const DEFAULT_ACCEPT = ['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma']

export function DropZone({ onFiles, onBrowse, multiple = false, compact = false, title, subtitle, accept = DEFAULT_ACCEPT }: Props): JSX.Element {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)

  function handleDrop(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    depth.current = 0
    setDragging(false)
    const files = Array.from(event.dataTransfer.files)
    const paths = files
      .filter((file) => accept.some((ext) => file.name.toLowerCase().endsWith(ext)))
      .map((file) => window.api.getPathForFile(file))
      .filter(Boolean)
    if (paths.length) onFiles(multiple ? paths : paths.slice(0, 1))
  }

  return (
    <motion.div
      className={cn('dropzone', compact && 'compact', dragging && 'dragging')}
      onDragEnter={(event) => {
        event.preventDefault()
        depth.current += 1
        setDragging(true)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => {
        depth.current -= 1
        if (depth.current <= 0) setDragging(false)
      }}
      onDrop={handleDrop}
      animate={dragging ? { scale: 1.008 } : { scale: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 28 }}
    >
      <div className="dropzone-glow" />
      <div className="dropzone-icon">
        {dragging ? <UploadCloud size={compact ? 20 : 24} /> : <Music4 size={compact ? 20 : 24} />}
      </div>
      <div className="dropzone-copy">
        <strong>{title || (dragging ? '松手导入音频' : '拖入音频文件')}</strong>
        <span>{subtitle || 'WAV / MP3 / FLAC / M4A，拖进来即可'}</span>
      </div>
      <button className="btn ghost small" onClick={onBrowse} type="button">
        <FolderOpen size={14} />
        浏览
      </button>
    </motion.div>
  )
}
