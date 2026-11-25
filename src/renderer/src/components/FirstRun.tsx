import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, Download, FolderSearch, HardDrive, Loader2, X } from 'lucide-react'
import type { Bootstrap, EngineInstallProgress } from '@shared/types'
import { ModelDownloads } from './ModelDownloads'
import { cn, formatBytes } from '../lib/format'

interface Props {
  bootstrap: Bootstrap
  notify: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void
  onBootstrap: (next: Bootstrap) => void
  onSkip: () => void
}

/**
 * First-run gate: install the runtime (UI-only builds ship without it) and then the model packs.
 * The user can also point at an existing GPT-SoVITS folder instead of downloading.
 */
export function FirstRun({ bootstrap, notify, onBootstrap, onSkip }: Props): JSX.Element {
  const [ready, setReady] = useState(bootstrap.validation.valid)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<EngineInstallProgress | null>(null)
  const [choosing, setChoosing] = useState(false)
  const missing = (bootstrap.validation.modelPacks || []).filter((p) => !p.installed)
  const bytes = missing.reduce((a, p) => a + p.missingBytes, 0)

  useEffect(() => {
    void window.api.engine.status().then((s) => {
      setReady(s.ready)
      if (s.installing) {
        setInstalling(true)
        setProgress({ phase: s.installing.phase as EngineInstallProgress['phase'], received: s.installing.received, total: s.installing.total, file: s.installing.file })
      }
    })
    return window.api.engine.onProgress((p) => {
      setProgress(p)
      if (p.file === '完成') setInstalling(false)
    })
  }, [])

  async function installEngine(): Promise<void> {
    setInstalling(true)
    setProgress(null)
    try {
      const r = await window.api.engine.install()
      setReady(r.ready)
      notify('运行环境已就绪', 'success')
      onBootstrap(await window.api.refreshBootstrap())
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setInstalling(false)
      setProgress(null)
    }
  }

  async function chooseFolder(): Promise<void> {
    const dir = await window.api.chooseDirectory('选择 GPT-SoVITS 整合包目录')
    if (!dir) return
    setChoosing(true)
    try {
      const next = await window.api.updateConfig({ engineRoot: dir })
      onBootstrap(next)
      setReady(next.validation.valid)
      if (!next.validation.valid) notify(`该目录缺少：${next.validation.missing.join('、')}`, 'warning')
    } finally {
      setChoosing(false)
    }
  }

  const pct = progress && progress.total ? Math.round((progress.received / progress.total) * 100) : 0

  return (
    <div className="setup-screen">
      <motion.div
        className="setup-card wide"
        initial={{ opacity: 0, y: 20, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 30 }}
      >
        <div className="setup-mark">
          {ready ? <HardDrive size={28} /> : <Download size={28} />}
        </div>
        <span className="eyebrow">{ready ? 'MODELS' : 'FIRST RUN'}</span>
        <h1>{ready ? '下载模型' : '准备运行环境'}</h1>

        {!ready && (
          <>
            <p className="setup-lead">
              这个便携包只带界面，不含 Python 运行环境。点下面的按钮自动下载并解压（约 2.5 GB，支持断点续传，可用 hf-mirror 加速）。
              如果你已经有 GPT-SoVITS 整合包，也可以直接选择它的目录。
            </p>
            {installing ? (
              <div className="engine-install">
                <div className="row gap">
                  <Loader2 size={16} className="spin" />
                  <span>{progress?.phase === 'extract' ? '正在解压…' : progress ? `下载中 ${pct}%` : '准备中…'}</span>
                  <button className="btn ghost small" onClick={() => void window.api.engine.cancel()}>
                    <X size={14} /> 取消
                  </button>
                </div>
                <div className="mini-vram">
                  <span style={{ width: `${progress?.phase === 'extract' ? 100 : pct}%` }} />
                </div>
                {progress && progress.phase === 'download' && (
                  <span className="muted">
                    {formatBytes(progress.received)} / {formatBytes(progress.total)}
                  </span>
                )}
              </div>
            ) : (
              <div className="row gap center">
                <button className="btn primary large" onClick={() => void installEngine()}>
                  <Download size={16} /> 下载运行环境
                </button>
                <button className="btn ghost large" onClick={() => void chooseFolder()} disabled={choosing}>
                  {choosing ? <Loader2 size={16} className="spin" /> : <FolderSearch size={16} />} 选择已有整合包
                </button>
              </div>
            )}
          </>
        )}

        {ready && (
          <>
            <p className="setup-lead">
              运行环境已就绪，还差 {missing.length} 个模型包（约 {Math.round(bytes / 1024 / 1024 / 1024) || 0} GB）。下载源可在「设置 → 下载源」切换 HuggingFace 官方或 hf-mirror 镜像，支持断点续传。
            </p>
            <ModelDownloads notify={notify} compact onDone={() => onBootstrap({ ...bootstrap })} />
            <div className="row gap center">
              <button className={cn('btn ghost')} onClick={onSkip}>
                稍后再说，先进应用 <ArrowRight size={14} />
              </button>
            </div>
          </>
        )}
      </motion.div>
    </div>
  )
}
