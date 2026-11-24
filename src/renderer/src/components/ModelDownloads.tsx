import { useEffect, useState } from 'react'
import { Download, HardDrive, Loader2, Trash2, X } from 'lucide-react'
import type { Bootstrap, ModelPackInfo, ModelPackProgress } from '@shared/types'
import { cn, formatBytes } from '../lib/format'

interface Props {
  notify: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void
  /** Compact mode is used on the first-run screen (no remove buttons, no secondary text). */
  compact?: boolean
  onDone?: () => void
}

export function ModelDownloads({ notify, compact = false, onDone }: Props): JSX.Element {
  const [packs, setPacks] = useState<ModelPackInfo[]>([])
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [prog, setProg] = useState<Record<string, ModelPackProgress>>({})

  async function refresh(): Promise<ModelPackInfo[]> {
    const list = await window.api.packs.list()
    setPacks(list)
    return list
  }

  useEffect(() => {
    void refresh()
    return window.api.packs.onProgress((p) => {
      setProg((prev) => ({ ...prev, [p.id]: p }))
      if (p.done) void refresh().then((l) => onDone?.())
      if (p.error) {
        notify(p.error, 'error')
        setBusy((b) => ({ ...b, [p.id]: false }))
      }
    })
  }, [])

  async function download(id: string): Promise<void> {
    setBusy((b) => ({ ...b, [id]: true }))
    try {
      setPacks(await window.api.packs.download(id))
      notify('模型下载完成', 'success')
      onDone?.()
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy((b) => ({ ...b, [id]: false }))
    }
  }

  async function remove(id: string): Promise<void> {
    setPacks(await window.api.packs.remove(id))
    notify('模型文件已移除，可随时重新下载', 'info')
  }

  const groups: Array<[ModelPackInfo['group'], string]> = [
    ['tts', '语音合成'],
    ['asr', '语音识别']
  ]

  return (
    <div className="pack-groups">
      {groups.map(([group, title]) => {
        const list = packs.filter((p) => p.group === group)
        if (!list.length) return null
        return (
          <div key={group} className="pack-group">
            <div className="pack-group-title">{title}</div>
            {list.map((p) => {
              const live = prog[p.id]
              const running = busy[p.id] || Boolean(p.downloading) || (live && !live.done && !live.error)
              const pct = live?.total ? Math.round((live.received / live.total) * 100) : p.downloading?.total ? Math.round((p.downloading.received / p.downloading.total) * 100) : 0
              return (
                <div key={p.id} className={cn('pack-row', p.installed && 'installed')}>
                  <div className="pack-copy">
                    <strong>
                      {p.label}
                      {p.installed && <span className="pack-tag">已安装</span>}
                      {p.bundled && !compact && <span className="pack-tag muted">随包附带</span>}
                    </strong>
                    {!compact && <span className="muted">{p.note}</span>}
                    <span className="muted">
                      {p.installed ? formatBytes(p.totalBytes) : `缺少 ${formatBytes(p.missingBytes)} / 共 ${formatBytes(p.totalBytes)}`}
                      {running && live?.file ? ` · ${live.file} ${pct}%` : ''}
                    </span>
                    {running && (
                      <div className="mini-vram">
                        <span style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="pack-actions">
                    {running ? (
                      <button className="btn ghost small" onClick={() => void window.api.packs.cancel(p.id)}>
                        <X size={14} /> 取消
                      </button>
                    ) : p.installed ? (
                      !compact && (
                        <button className="btn ghost small" title="移除文件，重新下载" onClick={() => void remove(p.id)}>
                          <Trash2 size={14} />
                        </button>
                      )
                    ) : (
                      <button className="btn small" disabled={Boolean(busy[p.id])} onClick={() => void download(p.id)}>
                        {busy[p.id] ? <Loader2 size={14} className="spin" /> : <Download size={14} />} 下载
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
      {!packs.length && <div className="muted">请先在设置里选择引擎目录</div>}
    </div>
  )
}

/** Full card used on the models page. */
export function ModelDownloadsCard({
  bootstrap,
  notify,
  onBootstrap
}: {
  bootstrap: Bootstrap
  notify: Props['notify']
  onBootstrap: (next: Bootstrap) => void
}): JSX.Element {
  const [missing, setMissing] = useState(0)
  const source = bootstrap.config.hfSource || 'mirror'
  const recount = (): void => {
    void window.api.packs.list().then((l) => setMissing(l.filter((p) => !p.installed).length))
  }
  useEffect(() => {
    recount()
  }, [])
  return (
    <section className="card pack-card">
      <div className="card-head">
        <h2>
          <HardDrive size={16} /> 模型下载
        </h2>
        <div className="row gap">
          <span className="muted">{missing ? `${missing} 个模型包未安装` : '全部已安装'}</span>
          <div className="seg-toggle">
            <button className={cn('btn ghost small', source === 'mirror' && 'active')} onClick={() => void window.api.updateConfig({ hfSource: 'mirror' }).then(onBootstrap)}>
              hf-mirror
            </button>
            <button className={cn('btn ghost small', source === 'official' && 'active')} onClick={() => void window.api.updateConfig({ hfSource: 'official' }).then(onBootstrap)}>
              HuggingFace
            </button>
          </div>
        </div>
      </div>
      <ModelDownloads notify={notify} onDone={recount} />
    </section>
  )
}
