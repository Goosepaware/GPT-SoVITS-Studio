import { useEffect, useState } from 'react'
import { Download, FolderOpen, Loader2, Scissors, Square, Trash2, Wand2, X } from 'lucide-react'
import type { Bootstrap, SepModelInfo, SepResult } from '@shared/types'
import { AudioPlayer } from '../components/AudioPlayer'
import { DropZone } from '../components/DropZone'
import { basename, cn, formatBytes } from '../lib/format'

interface Props {
  bootstrap: Bootstrap
  notify: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void
  onBootstrap: (next: Bootstrap) => void
}

const MEDIA_EXT = /\.(wav|mp3|flac|m4a|aac|ogg|opus|mp4|mkv|mov|webm|avi|flv)$/i

export function AudioToolsPage({ bootstrap, notify, onBootstrap }: Props): JSX.Element {
  const [models, setModels] = useState<SepModelInfo[]>([])
  const [dl, setDl] = useState<Record<string, { received: number; total: number }>>({})
  const [model, setModel] = useState<string>('')
  const [src, setSrc] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ current: number; total: number; label: string } | null>(null)
  const [result, setResult] = useState<SepResult | null>(null)
  const source = bootstrap.config.hfSource || 'mirror'

  async function refresh(): Promise<void> {
    const list = await window.api.sep.models()
    setModels(list)
    setModel((cur) => (cur && list.some((m) => m.id === cur && m.installed) ? cur : list.find((m) => m.installed)?.id || ''))
  }

  useEffect(() => {
    void refresh()
    return window.api.sep.onEvent((e) => {
      if (e.kind === 'download') setDl((p) => ({ ...p, [e.id]: { received: e.received, total: e.total } }))
      else setProgress({ current: e.current, total: e.total, label: e.label })
    })
  }, [])

  async function download(id: string): Promise<void> {
    setDl((p) => ({ ...p, [id]: { received: 0, total: 0 } }))
    try {
      setModels(await window.api.sep.download(id))
      notify('模型下载完成', 'success')
      await refresh()
    } catch (e) {
      notify(`下载失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setDl((p) => {
        const n = { ...p }
        delete n[id]
        return n
      })
    }
  }

  async function remove(id: string): Promise<void> {
    setModels(await window.api.sep.remove(id))
    await refresh()
  }

  async function setSource(next: 'official' | 'mirror'): Promise<void> {
    onBootstrap(await window.api.updateConfig({ hfSource: next }))
  }

  async function pick(): Promise<void> {
    const p = await window.api.dub.pickMedia()
    if (p) {
      setSrc(p)
      setResult(null)
    }
  }

  function onFiles(paths: string[]): void {
    const p = paths.find((x) => MEDIA_EXT.test(x))
    if (!p) return notify('请拖入音频或视频文件', 'warning')
    setSrc(p)
    setResult(null)
  }

  async function start(): Promise<void> {
    if (!src || !model) return
    setRunning(true)
    setProgress(null)
    setResult(null)
    try {
      const r = await window.api.sep.separate(src, model)
      setResult(r)
      notify(r.cached ? '已使用缓存的分离结果' : '分离完成', 'success')
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  async function exportResult(): Promise<void> {
    if (!result) return
    const dir = await window.api.sep.exportTo(result)
    if (dir) notify(`已导出到 ${dir}`, 'success')
  }

  const pct = progress && progress.total ? Math.round((progress.current / progress.total) * 100) : 0

  return (
    <div className="page">
      <section className="card">
        <div className="card-head">
          <h2><Wand2 size={16} /> 人声分离模型</h2>
          <div className="seg-toggle">
            <button className={cn('btn ghost small', source === 'mirror' && 'active')} onClick={() => void setSource('mirror')}>hf-mirror 镜像</button>
            <button className={cn('btn ghost small', source === 'official' && 'active')} onClick={() => void setSource('official')}>HuggingFace 官方</button>
          </div>
        </div>
        <div className="sep-models">
          {models.map((m) => {
            const d = dl[m.id] || m.downloading
            return (
              <div key={m.id} className={cn('sep-model', model === m.id && 'active')} onClick={() => m.installed && setModel(m.id)}>
                <div className="sep-model-copy">
                  <strong>{m.label}</strong>
                  <span className="muted">{m.note} · {formatBytes(m.size)}</span>
                  {d && (
                    <div className="mini-vram"><span style={{ width: `${d.total ? Math.min(100, (d.received / d.total) * 100) : 0}%` }} /></div>
                  )}
                </div>
                {m.installed ? (
                  <button className="btn ghost small" title="删除模型" onClick={(e) => { e.stopPropagation(); void remove(m.id) }}><Trash2 size={14} /></button>
                ) : d ? (
                  <button className="btn ghost small" onClick={(e) => { e.stopPropagation(); void window.api.sep.cancelDownload(m.id) }}><X size={14} /> {d.total ? `${Math.round((d.received / d.total) * 100)}%` : '连接中'}</button>
                ) : (
                  <button className="btn small" onClick={(e) => { e.stopPropagation(); void download(m.id) }}><Download size={14} /> 下载</button>
                )}
              </div>
            )
          })}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2><Scissors size={16} /> 人声 / 背景分离</h2>
        </div>
        <DropZone
          onFiles={onFiles}
          onBrowse={() => void pick()}
          accept={['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.mp4', '.mkv', '.mov', '.webm', '.avi', '.flv']}
          title={src ? basename(src) : '拖入视频或音频'}
          subtitle="视频 / 音频均可，输出 44.1 kHz 立体声人声与背景"
        />
        <div className="row gap">
          {running ? (
            <button className="btn" onClick={() => void window.api.sep.cancel()}><Square size={14} /> 取消</button>
          ) : (
            <button className="btn primary" disabled={!src || !model} onClick={() => void start()}>
              <Wand2 size={14} /> 开始分离
            </button>
          )}
          {!model && <span className="muted">请先下载一个分离模型</span>}
          {running && (
            <span className="muted"><Loader2 size={14} className="spin" /> {progress ? `${progress.label} ${pct}%` : '准备中…'}</span>
          )}
        </div>
        {running && progress && <div className="mini-vram"><span style={{ width: `${pct}%` }} /></div>}

        {result && (
          <div className="sep-results">
            <div className="sep-track">
              <span className="sep-track-label">人声</span>
              <AudioPlayer src={result.vocals} />
            </div>
            <div className="sep-track">
              <span className="sep-track-label">背景</span>
              <AudioPlayer src={result.instrumental} />
            </div>
            <div className="row gap">
              <button className="btn" onClick={() => void exportResult()}><Download size={14} /> 导出 WAV</button>
              <button className="btn ghost" onClick={() => void window.api.revealPath(result.vocals)}><FolderOpen size={14} /> 打开缓存目录</button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
