import { useState } from 'react'
import { Folder, FolderOpen, Inbox, Library } from 'lucide-react'
import type { Voice, VoiceFolderInfo } from '@shared/types'
import { cn } from '../lib/format'
import { folderContains } from '../lib/voiceSearch'

export const VOICE_ALL = '__all__'
export const VOICE_UNFILED = '__unfiled__'
export type VoiceFolderSelection = typeof VOICE_ALL | typeof VOICE_UNFILED | string

interface Props {
  voices: Voice[]
  folders: VoiceFolderInfo[]
  selected: VoiceFolderSelection
  onSelect: (value: VoiceFolderSelection) => void
  onDropVoice?: (folder: string) => void
  compact?: boolean
}

export function VoiceFolderTree({ voices, folders, selected, onSelect, onDropVoice, compact = false }: Props): JSX.Element {
  const [dragOver, setDragOver] = useState<string | null>(null)
  const countFor = (folder: string): number => voices.filter((voice) => folderContains(voice.folder, folder)).length
  const unfiledCount = voices.filter((voice) => !voice.folder).length

  const row = (value: VoiceFolderSelection, label: string, count: number, depth: number, icon: JSX.Element, folder = ''): JSX.Element => {
    const active = selected === value
    const droppable = Boolean(onDropVoice) && value !== VOICE_ALL
    return (
      <button
        key={value}
        type="button"
        className={cn('voice-folder-row', active && 'active', dragOver === value && 'drag-over', compact && 'compact')}
        style={{ paddingLeft: 9 + depth * 14 }}
        onClick={() => onSelect(value)}
        onDragOver={droppable ? (event) => { event.preventDefault(); setDragOver(value) } : undefined}
        onDragLeave={droppable ? () => setDragOver((current) => (current === value ? null : current)) : undefined}
        onDrop={droppable ? (event) => {
          event.preventDefault()
          setDragOver(null)
          onDropVoice?.(folder)
        } : undefined}
        title={folder || label}
      >
        {icon}
        <span className="voice-folder-name">{label}</span>
        <span className="voice-folder-count">{count}</span>
      </button>
    )
  }

  return (
    <div className={cn('voice-folder-tree', compact && 'compact')}>
      {row(VOICE_ALL, '全部音色', voices.length, 0, <Library size={14} />)}
      {row(VOICE_UNFILED, '未分类', unfiledCount, 0, <Inbox size={14} />)}
      <div className="voice-folder-separator" />
      {folders.map((folder) => row(
        folder.path,
        folder.name,
        countFor(folder.path),
        folder.depth + 1,
        selected === folder.path ? <FolderOpen size={14} /> : <Folder size={14} />,
        folder.path
      ))}
    </div>
  )
}
