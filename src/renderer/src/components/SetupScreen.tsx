import { useState } from 'react'
import { motion } from 'framer-motion'
import { AudioWaveform, FolderSearch, Loader2, ShieldAlert } from 'lucide-react'
import type { Bootstrap } from '@shared/types'

interface Props {
  bootstrap: Bootstrap
  onChanged: (next: Bootstrap) => void
}

export function SetupScreen({ bootstrap, onChanged }: Props): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function choose(): Promise<void> {
    const dir = await window.api.chooseDirectory('选择 GPT-SoVITS 整合包目录')
    if (!dir) return
    setBusy(true)
    setError(null)
    try {
      const next = await window.api.updateConfig({ engineRoot: dir })
      if (!next.validation.valid) {
        setError(`目录已保存，但还缺少：${next.validation.missing.join('、')}`)
      }
      onChanged(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="setup-screen">
      <motion.div className="setup-card" initial={{ opacity: 0, y: 20, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 30 }}>
        <div className="setup-orbit" />
        <div className="setup-mark">
          <AudioWaveform size={30} />
        </div>
        <span className="eyebrow">FIRST RUN</span>
        <h1>选择 GPT-SoVITS 整合包</h1>
        <p className="setup-lead">应用需要一个包含 <code>runtime\\python.exe</code> 和 <code>GPT_SoVITS</code> 的整合包目录。原 WebUI 不会被修改。</p>

        <div className="setup-path">
          <span className="setup-path-label">当前目录</span>
          <span className="setup-path-value">{bootstrap.config.engineRoot || '尚未选择'}</span>
        </div>

        {bootstrap.validation.missing.length > 0 && (
          <div className="setup-missing">
            <ShieldAlert size={16} />
            <div>
              <strong>缺少必要文件</strong>
              <span>{bootstrap.validation.missing.join(' · ')}</span>
            </div>
          </div>
        )}
        {error && <div className="setup-error">{error}</div>}

        <button className="btn primary large" onClick={choose} disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : <FolderSearch size={16} />}
          {busy ? '正在检查目录…' : '选择整合包目录'}
        </button>
        <div className="setup-hint">支持 GPT-SoVITS v5 整合包，v5turbo 推理与 SenseVoice 识别。</div>
      </motion.div>
    </div>
  )
}
