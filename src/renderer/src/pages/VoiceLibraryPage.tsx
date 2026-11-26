import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, FolderOpen, FolderPlus, FolderUp, Move, Pencil, Play, RefreshCw, Search, Share2, Trash2, UserRound, Wand2 } from 'lucide-react'
import type { Voice, VoiceFolderInfo, VoiceLibrary } from '@shared/types'
import { AudioPlayer } from '../components/AudioPlayer'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import { VoiceFolderTree, VOICE_ALL, VOICE_UNFILED, type VoiceFolderSelection } from '../components/VoiceFolderTree'
import { basename, cn } from '../lib/format'
import { useAudioUrl } from '../lib/useAudioUrl'
import { folderContains, makeVoiceSearchKey, scoreVoiceMatch } from '../lib/voiceSearch'

interface Props {
  notify: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void
  onUseVoice: (id: string) => void
}

type FolderDialog = { mode: 'create'; parent: string; name: string } | { mode: 'rename'; folder: string; parent: string; name: string } | null

const EMPTY: VoiceLibrary = { voices: [], folders: [] }

export function VoiceLibraryPage({ notify, onUseVoice }: Props): JSX.Element {
  const [library, setLibrary] = useState<VoiceLibrary>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [selectedFolder, setSelectedFolder] = useState<VoiceFolderSelection>(VOICE_ALL)
  const [query, setQuery] = useState('')
  const [searchAll, setSearchAll] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [folderDialog, setFolderDialog] = useState<FolderDialog>(null)
  const [editing, setEditing] = useState<Voice | null>(null)
  const [editName, setEditName] = useState('')
  const [editTranscript, setEditTranscript] = useState('')
  const [editLang, setEditLang] = useState('auto')
  const [moving, setMoving] = useState<string[]>([])
  const [moveTarget, setMoveTarget] = useState('')
  const [previewPath, setPreviewPath] = useState('')
  const [previewName, setPreviewName] = useState('')
  const previewUrl = useAudioUrl(previewPath)
  const dragging = useRef<string[]>([])
  const busy = useRef(false)

  const keys = useMemo(() => new Map(library.voices.map((voice) => [voice.id, makeVoiceSearchKey(voice.name)])), [library.voices])

  async function refresh(): Promise<void> {
    try {
      setLibrary(await window.api.voices.library())
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])
  useEffect(() => window.api.onDataChanged((kind) => kind === 'voices' && void refresh()), [])

  useEffect(() => {
    setSelected((previous) => new Set([...previous].filter((id) => library.voices.some((voice) => voice.id === id))))
  }, [library.voices])

  const filtered = useMemo(() => {
    const folderScoped = searchAll || selectedFolder === VOICE_ALL
      ? library.voices
      : selectedFolder === VOICE_UNFILED
        ? library.voices.filter((voice) => !voice.folder)
        : library.voices.filter((voice) => folderContains(voice.folder, selectedFolder))
    const q = query.trim()
    return folderScoped
      .map((voice) => ({ voice, score: q ? scoreVoiceMatch(keys.get(voice.id) || makeVoiceSearchKey(voice.name), q) : 1 }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.voice.name.localeCompare(b.voice.name, 'zh-CN'))
      .map((item) => item.voice)
  }, [keys, library.voices, query, searchAll, selectedFolder])

  const selectedFolderInfo: VoiceFolderInfo | undefined = library.folders.find((folder) => folder.path === selectedFolder)
  const folderOptions = useMemo(() => [{ value: '', label: '根目录（未分类）' }, ...library.folders.map((folder) => ({ value: folder.path, label: `${'　'.repeat(folder.depth + 1)}${folder.name}` }))], [library.folders])
  const selectedFolderHasChildren = Boolean(selectedFolderInfo && library.folders.some((folder) => folder.parent === selectedFolderInfo.path))
  const selectedFolderCount = selectedFolderInfo ? library.voices.filter((voice) => folderContains(voice.folder, selectedFolderInfo.path)).length : 0

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy.current) return
    busy.current = true
    try { await action() } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    } finally { busy.current = false }
  }

  function toggle(id: string): void {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAll(): void {
    setSelected(new Set(filtered.map((voice) => voice.id)))
  }

  async function saveFolder(): Promise<void> {
    if (!folderDialog || !folderDialog.name.trim()) return
    const dialog = folderDialog
    await run(async () => {
      const next = dialog.mode === 'create'
        ? await window.api.voices.createFolder(dialog.parent, dialog.name)
        : await window.api.voices.renameFolder(dialog.folder, dialog.name)
      setLibrary(next)
      setFolderDialog(null)
      if (dialog.mode === 'rename') {
        const target = dialog.parent ? `${dialog.parent}/${dialog.name.trim()}` : dialog.name.trim()
        setSelectedFolder(target)
      }
      notify(dialog.mode === 'create' ? '文件夹已创建' : '文件夹已重命名', 'success')
    })
  }

  async function removeFolder(): Promise<void> {
    if (!selectedFolderInfo) return
    if (selectedFolderCount > 0 || selectedFolderHasChildren) {
      notify('文件夹不为空，请先移动或删除其中的音色和子文件夹', 'warning')
      return
    }
    if (!window.confirm(`删除空文件夹「${selectedFolderInfo.path.replaceAll('/', ' / ')}」？`)) return
    await run(async () => {
      setLibrary(await window.api.voices.removeFolder(selectedFolderInfo.path))
      setSelectedFolder(VOICE_ALL)
      notify('文件夹已删除', 'success')
    })
  }

  async function moveVoices(ids: string[], folder: string): Promise<void> {
    if (!ids.length) return
    await run(async () => {
      let next = library
      for (const id of ids) next = await window.api.voices.move(id, folder)
      setLibrary(next)
      setSelected(new Set())
      setMoving([])
      notify(`已移动 ${ids.length} 个音色`, 'success')
    })
  }

  async function removeVoices(ids: string[]): Promise<void> {
    if (!ids.length) return
    if (!window.confirm(`永久删除 ${ids.length} 个音色？${ids.length > 1 ? '对应的 .v5t 文件都会被删除。' : '对应的 .v5t 文件会被删除。'}`)) return
    await run(async () => {
      for (const id of ids) await window.api.voices.remove(id)
      setLibrary(await window.api.voices.library())
      setSelected(new Set())
      notify(`已删除 ${ids.length} 个音色`, 'info')
    })
  }

  async function preview(voice: Voice): Promise<void> {
    await run(async () => {
      setPreviewPath(await window.api.voices.audio(voice.id))
      setPreviewName(voice.name)
    })
  }

  async function touch(voice: Voice): Promise<void> {
    await window.api.voices.touch(voice.id)
    setLibrary((current) => ({
      ...current,
      voices: current.voices.map((item) => item.id === voice.id ? { ...item, lastUsedAt: Date.now() } : item)
    }))
  }

  function openEdit(voice: Voice): void {
    setEditing(voice)
    setEditName(voice.name)
    setEditTranscript(voice.transcript)
    setEditLang(voice.promptLang)
  }

  async function saveEdit(): Promise<void> {
    if (!editing) return
    await run(async () => {
      await window.api.voices.update(editing.id, { name: editName, transcript: editTranscript, promptLang: editLang })
      setLibrary(await window.api.voices.library())
      setEditing(null)
      notify('音色信息已保存', 'success')
    })
  }

  function dragIds(id: string): string[] {
    return selected.has(id) ? [...selected] : [id]
  }

  return (
    <div className="page voice-library-page">
      <section className="voice-library-layout">
        <aside className="card voice-library-side">
          <div className="voice-library-side-head">
            <div><span className="eyebrow">FOLDERS</span><h2>文件夹</h2></div>
            <button type="button" className="icon-btn small" title="新建文件夹" onClick={() => setFolderDialog({ mode: 'create', parent: selectedFolderInfo?.path || '', name: '' })}><FolderPlus size={15} /></button>
          </div>
          <VoiceFolderTree
            voices={library.voices}
            folders={library.folders}
            selected={selectedFolder}
            onSelect={(value) => { setSelectedFolder(value); setSearchAll(false) }}
            onDropVoice={(folder) => void moveVoices(dragging.current, folder)}
          />
          <div className="voice-library-side-actions">
            {selectedFolderInfo && (
              <>
                <button type="button" className="text-btn" onClick={() => setFolderDialog({ mode: 'rename', folder: selectedFolderInfo.path, parent: selectedFolderInfo.parent, name: selectedFolderInfo.name })}><Pencil size={13} /> 重命名</button>
                <button type="button" className="text-btn danger-text" onClick={() => void removeFolder()}><Trash2 size={13} /> 删除空文件夹</button>
              </>
            )}
            <button type="button" className="text-btn" onClick={() => void window.api.voices.openFolder(selectedFolderInfo?.path || '')}><FolderOpen size={13} /> 打开磁盘目录</button>
          </div>
        </aside>

        <section className="card voice-library-main">
          <div className="voice-library-head">
            <div>
              <span className="eyebrow">VOICE LIBRARY</span>
              <h2>{selectedFolder === VOICE_ALL ? '全部音色' : selectedFolder === VOICE_UNFILED ? '未分类' : selectedFolder.replaceAll('/', ' / ')}</h2>
              <p>{library.voices.length} 个音色 · {library.folders.length} 个文件夹</p>
            </div>
            <div className="voice-library-head-actions">
              <button type="button" className="btn ghost small" onClick={() => void run(async () => {
                const result = await window.api.voices.importFiles(selectedFolderInfo?.path || '')
                if (!result) return
                setLibrary(await window.api.voices.library())
                notify(`已导入 ${result.imported} 个音色`, result.imported ? 'success' : 'warning')
              })}><Download size={13} /> 导入 .v5t</button>
              <button type="button" className="icon-btn small" title="刷新" onClick={() => void refresh()}><RefreshCw size={14} /></button>
            </div>
          </div>

          <div className="voice-library-toolbar">
            <div className="voice-library-search">
              <Search size={14} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索音色名称或拼音首字母，例如 tb、tbz" />
              <button type="button" className={cn('voice-scope-btn', searchAll && 'active')} onClick={() => { setSearchAll((value) => !value); if (!searchAll) setSelectedFolder(VOICE_ALL) }}>全局</button>
            </div>
            <div className="voice-library-batch">
              <button type="button" className="text-btn" onClick={selectAll}>全选当前 {filtered.length}</button>
              <button type="button" className="text-btn" disabled={!selected.size} onClick={() => { setMoveTarget(selectedFolderInfo?.path || ''); setMoving([...selected]) }}><Move size={13} /> 移动 {selected.size || ''}</button>
              <button type="button" className="text-btn danger-text" disabled={!selected.size} onClick={() => void removeVoices([...selected])}><Trash2 size={13} /> 删除 {selected.size || ''}</button>
            </div>
          </div>

          {previewPath && (
            <div className="voice-library-preview">
              <div><Play size={13} /><strong>{previewName}</strong></div>
              {previewUrl.url ? <AudioPlayer src={previewUrl.url} compact /> : <span className="muted">读取音频…</span>}
              <button type="button" className="icon-btn small" onClick={() => { setPreviewPath(''); setPreviewName('') }}><Trash2 size={13} /></button>
            </div>
          )}

          {loading ? (
            <div className="voice-library-empty"><RefreshCw size={24} className="spin" /><p>正在读取音色库…</p></div>
          ) : filtered.length === 0 ? (
            <div className="voice-library-empty">
              <UserRound size={28} />
              <p>{query ? '没有匹配的音色' : '这个文件夹里还没有音色'}</p>
              <span>可以把音色拖到左侧文件夹，或从语音合成页保存新音色。</span>
            </div>
          ) : (
            <div className="voice-grid">
              {filtered.map((voice) => (
                <article
                  key={voice.id}
                  className={cn('voice-card', selected.has(voice.id) && 'selected')}
                  draggable
                  onDragStart={(event) => { dragging.current = dragIds(voice.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', voice.id) }}
                  onDragEnd={() => { dragging.current = [] }}
                  onDoubleClick={() => { void touch(voice); onUseVoice(voice.id) }}
                >
                  <div className="voice-card-head">
                    <input type="checkbox" checked={selected.has(voice.id)} onChange={() => toggle(voice.id)} aria-label={`选择 ${voice.name}`} />
                    <div className="voice-card-title"><strong>{voice.name}</strong><span>{voice.folder || '未分类'} · {voice.duration.toFixed(1)}s · {voice.promptLang.toUpperCase()}</span></div>
                  </div>
                  <p>{voice.transcript || '（没有参考文本）'}</p>
                  <div className="voice-card-foot">
                    <span>{voice.lastUsedAt ? `最近使用 ${new Date(voice.lastUsedAt).toLocaleDateString()}` : basename(voice.packagePath)}</span>
                    <div>
                      <button type="button" className="icon-btn small" title="试听" onClick={() => void preview(voice)}><Play size={13} /></button>
                      <button type="button" className="icon-btn small" title="用作参考声音" onClick={() => { void touch(voice); onUseVoice(voice.id) }}><Wand2 size={13} /></button>
                      <button type="button" className="icon-btn small" title="编辑" onClick={() => openEdit(voice)}><Pencil size={13} /></button>
                      <button type="button" className="icon-btn small" title="移动" onClick={() => { setMoving([voice.id]); setMoveTarget(voice.folder) }}><FolderUp size={13} /></button>
                      <button type="button" className="icon-btn small" title="导出 .v5t" onClick={() => void window.api.voices.export(voice.id).then((file) => { if (file) { notify(`已导出 ${basename(file)}`, 'success'); void window.api.revealPath(file) } })}><Share2 size={13} /></button>
                      <button type="button" className="icon-btn small danger" title="删除" onClick={() => void removeVoices([voice.id])}><Trash2 size={13} /></button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>

      <Modal open={Boolean(folderDialog)} title={folderDialog?.mode === 'rename' ? '重命名文件夹' : '新建文件夹'} subtitle="文件夹会真实创建在 data/voices 下，支持多级嵌套" onClose={() => setFolderDialog(null)}
        footer={<><button className="btn ghost" onClick={() => setFolderDialog(null)}>取消</button><button className="btn primary" onClick={() => void saveFolder()}>保存</button></>}>
        <label className="field"><span className="field-label">上级文件夹</span>
          <Select value={folderDialog?.parent || ''} onChange={(value) => setFolderDialog((current) => current ? { ...current, parent: value } : current)}>
            {folderOptions.map((option) => <option key={option.value || 'root'} value={option.value}>{option.label}</option>)}
          </Select>
        </label>
        <label className="field"><span className="field-label">文件夹名称</span><input autoFocus value={folderDialog?.name || ''} onChange={(event) => setFolderDialog((current) => current ? { ...current, name: event.target.value } : current)} onKeyDown={(event) => event.key === 'Enter' && void saveFolder()} /></label>
      </Modal>

      <Modal open={Boolean(editing)} title="编辑音色" onClose={() => setEditing(null)}
        footer={<><button className="btn ghost" onClick={() => setEditing(null)}>取消</button><button className="btn primary" onClick={() => void saveEdit()}>保存</button></>}>
        <label className="field"><span className="field-label">名称</span><input value={editName} onChange={(event) => setEditName(event.target.value)} /></label>
        <label className="field"><span className="field-label">参考语言</span><Select value={editLang} onChange={setEditLang}>
          <option value="auto">自动</option><option value="zh">中文</option><option value="ja">日语</option><option value="en">英语</option><option value="yue">粤语</option><option value="ko">韩语</option>
        </Select></label>
        <label className="field"><span className="field-label">参考文本</span><textarea rows={5} value={editTranscript} onChange={(event) => setEditTranscript(event.target.value)} /></label>
      </Modal>

      <Modal open={moving.length > 0} title={`移动 ${moving.length} 个音色`} onClose={() => setMoving([])}
        footer={<><button className="btn ghost" onClick={() => setMoving([])}>取消</button><button className="btn primary" onClick={() => void moveVoices(moving, moveTarget)}>移动</button></>}>
        <label className="field"><span className="field-label">目标文件夹</span><Select value={moveTarget} onChange={setMoveTarget}>
          {folderOptions.map((option) => <option key={option.value || 'root'} value={option.value}>{option.label}</option>)}
        </Select></label>
      </Modal>
    </div>
  )
}
