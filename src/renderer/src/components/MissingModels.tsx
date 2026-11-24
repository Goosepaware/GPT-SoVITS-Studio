import { motion } from 'framer-motion'
import { HardDrive, ArrowRight } from 'lucide-react'
import type { Bootstrap } from '@shared/types'
import { ModelDownloads } from './ModelDownloads'

interface Props {
  bootstrap: Bootstrap
  notify: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void
  onSkip: () => void
  onRefresh: () => void
}

/** Shown when the engine code is present but model files were left out of the package. */
export function MissingModels({ bootstrap, notify, onSkip, onRefresh }: Props): JSX.Element {
  const missing = (bootstrap.validation.modelPacks || []).filter((p) => !p.installed)
  const bytes = missing.reduce((a, p) => a + p.missingBytes, 0)
  return (
    <div className="setup-screen">
      <motion.div
        className="setup-card wide"
        initial={{ opacity: 0, y: 20, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 30 }}
      >
        <div className="setup-mark">
          <HardDrive size={28} />
        </div>
        <span className="eyebrow">MODELS</span>
        <h1>先下载模型</h1>
        <p className="setup-lead">
          这个便携包不含大模型（约 {Math.round(bytes / 1024 / 1024 / 1024) || 0} GB 待下载）。下载源可在「设置 → 下载源」切换 HuggingFace 官方或 hf-mirror 镜像，支持断点续传。
        </p>
        <ModelDownloads notify={notify} compact onDone={onRefresh} />
        <div className="row gap center">
          <button className="btn ghost" onClick={onSkip}>
            稍后再说，先进应用 <ArrowRight size={14} />
          </button>
        </div>
      </motion.div>
    </div>
  )
}
