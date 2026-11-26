import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, ChevronDown, Clock3, FolderOpen, Library, Search, Settings2, UserRound } from 'lucide-react'
import type { Voice, VoiceFolderInfo } from '@shared/types'
import { cn } from '../lib/format'
import { folderContains, makeVoiceSearchKey, scoreVoiceMatch } from '../lib/voiceSearch'
import { VoiceFolderTree, VOICE_ALL, type VoiceFolderSelection } from './VoiceFolderTree'

interface Props {
  voices: Voice[]
  folders: VoiceFolderInfo[]
  value: string
  onChange: (id: string) => void | Promise<void>
  onManage?: () => void
  className?: string
}

interface Position {
  left: number
  top: number
  width: number
  maxHeight: number
}

const RECENT_COUNT = 6

export function VoicePicker({ voices, folders, value, onChange, onManage, className }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'recent' | 'all'>('recent')
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState<VoiceFolderSelection>(VOICE_ALL)
  const [searchAll, setSearchAll] = useState(false)
  const [position, setPosition] = useState<Position | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const popover = useRef<HTMLDivElement | null>(null)
  const searchInput = useRef<HTMLInputElement | null>(null)
  const selected = voices.find((voice) => voice.id === value)

  const keys = useMemo(() => new Map(voices.map((voice) => [voice.id, makeVoiceSearchKey(voice.name)])), [voices])
  const recents = useMemo(
    () => voices
      .filter((voice) => voice.id !== value)
      .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || b.createdAt - a.createdAt)
      .slice(0, RECENT_COUNT),
    [voices, value]
  )

  const results = useMemo(() => {
    const scoped = searchAll || folder === VOICE_ALL
      ? voices
      : folder === '__unfiled__'
        ? voices.filter((voice) => !voice.folder)
        : voices.filter((voice) => folderContains(voice.folder, folder))
    const q = query.trim()
    return scoped
      .map((voice) => ({ voice, score: q ? scoreVoiceMatch(keys.get(voice.id) || makeVoiceSearchKey(voice.name), q) : 1 }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.voice.name.localeCompare(b.voice.name, 'zh-CN'))
  }, [folder, keys, query, searchAll, voices])

  function updatePosition(): void {
    const element = trigger.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const width = Math.min(window.innerWidth - 16, view === 'all' ? 620 : 380)
    const below = window.innerHeight - rect.bottom - 13
    const above = rect.top - 13
    const placeTop = below < 340 && above > below
    const maxHeight = Math.max(240, Math.min(560, placeTop ? above : below))
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))
    setPosition({
      left,
      top: placeTop ? Math.max(8, rect.top - 5 - maxHeight) : rect.bottom + 5,
      width,
      maxHeight
    })
  }

  useEffect(() => {
    if (!open) return
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, view])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (trigger.current?.contains(target) || popover.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (view === 'all') {
        setView('recent')
        setQuery('')
        setSearchAll(false)
      } else setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, view])

  useEffect(() => {
    if (open && view === 'all') window.setTimeout(() => searchInput.current?.focus(), 30)
  }, [open, view])

  function openPicker(): void {
    setView('recent')
    setQuery('')
    setSearchAll(false)
    setFolder(VOICE_ALL)
    setOpen(true)
  }

  function choose(id: string): void {
    void onChange(id)
    setOpen(false)
  }

  function voiceRow(voice: Voice): JSX.Element {
    return (
      <button key={voice.id} type="button" className={cn('voice-pick-row', voice.id === value && 'selected')} onClick={() => choose(voice.id)}>
        <span className="voice-pick-icon"><UserRound size={14} /></span>
        <span className="voice-pick-copy">
          <strong>{voice.name}</strong>
          <em>{voice.folder || '未分类'}{voice.duration ? ` · ${voice.duration.toFixed(1)}s` : ''}</em>
        </span>
        {voice.lastUsedAt ? <span className="voice-pick-recent">最近</span> : null}
      </button>
    )
  }

  return (
    <div className={cn('voice-picker', className)}>
      <button ref={trigger} type="button" className="custom-select-trigger voice-picker-trigger" onClick={() => (open ? setOpen(false) : openPicker())} aria-haspopup="listbox" aria-expanded={open}>
        <span className="custom-select-value">
          {selected ? selected.name : '临时参考音频'}
          {selected?.folder ? <em>{selected.folder}</em> : null}
        </span>
        <ChevronDown size={14} className={cn('custom-select-caret', open && 'rotated')} />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && position && (
            <motion.div
              ref={popover}
              className={cn('voice-picker-popover', view === 'all' && 'wide')}
              initial={{ opacity: 0, y: -4, scale: 0.99 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.99 }}
              transition={{ duration: 0.13 }}
              style={{ position: 'fixed', left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
            >
              {view === 'recent' ? (
                <>
                  <div className="voice-picker-head">
                    <span>选择音色</span>
                    <small>{voices.length} 个</small>
                  </div>
                  <div className="voice-picker-scroll">
                    <button type="button" className={cn('voice-pick-row', !value && 'selected')} onClick={() => choose('')}>
                      <span className="voice-pick-icon"><Clock3 size={14} /></span>
                      <span className="voice-pick-copy"><strong>临时参考音频</strong><em>使用当前导入的声音</em></span>
                    </button>
                    {selected && (
                      <>
                        <div className="voice-picker-label">当前音色</div>
                        {voiceRow(selected)}
                      </>
                    )}
                    {recents.length > 0 && <div className="voice-picker-label">最近使用</div>}
                    {recents.map(voiceRow)}
                    {!recents.length && !selected && <div className="voice-picker-empty">还没有保存过音色</div>}
                  </div>
                  <div className="voice-picker-actions">
                    <button type="button" className="voice-picker-more" onClick={() => setView('all')}>
                      <Library size={14} /> 浏览全部音色 <ChevronDown size={13} className="point-right" />
                    </button>
                    {onManage && (
                      <button type="button" className="voice-picker-manage" onClick={() => { setOpen(false); onManage() }}>
                        <Settings2 size={13} /> 管理音色库
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="voice-picker-all-head">
                    <button type="button" className="icon-btn small" onClick={() => { setView('recent'); setQuery(''); setSearchAll(false) }} title="返回最近使用"><ArrowLeft size={14} /></button>
                    <strong>全部音色</strong>
                    <span>{results.length} / {voices.length}</span>
                    {onManage && <button type="button" className="icon-btn small" onClick={() => { setOpen(false); onManage() }} title="管理音色库"><Settings2 size={14} /></button>}
                  </div>
                  <div className="voice-picker-search">
                    <Search size={14} />
                    <input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称 / 拼音首字母，例如 tb、tbz" />
                    <button type="button" className={cn('voice-scope-btn', searchAll && 'active')} onClick={() => { setSearchAll((value) => !value); if (!searchAll) setFolder(VOICE_ALL) }} title="在全部音色中搜索">
                      全局
                    </button>
                  </div>
                  <div className="voice-picker-all-body">
                    <div className="voice-picker-folders">
                      <VoiceFolderTree
                        voices={voices}
                        folders={folders}
                        selected={searchAll ? VOICE_ALL : folder}
                        onSelect={(next) => { setFolder(next); setSearchAll(false) }}
                        compact
                      />
                    </div>
                    <div className="voice-picker-results">
                      {results.length ? results.map((item) => voiceRow(item.voice)) : <div className="voice-picker-empty">没有匹配的音色</div>}
                    </div>
                  </div>
                  <div className="voice-picker-foot">
                    <span>{searchAll ? '搜索结果来自全部文件夹' : folder === VOICE_ALL ? '当前：全部音色' : `当前：${folder === '__unfiled__' ? '未分类' : folder.replaceAll('/', ' / ')}`}</span>
                    <span><FolderOpen size={12} /> 支持拼音首字母</span>
                  </div>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  )
}
