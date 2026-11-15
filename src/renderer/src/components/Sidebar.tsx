import { motion } from 'framer-motion'
import { AudioLines, Cpu, Mic2, Settings2, Sparkles } from 'lucide-react'
import type { EngineStatus, GpuInfo } from '@shared/types'
import { cn } from '../lib/format'

export type PageKey = 'tts' | 'asr' | 'models' | 'settings'

const NAV: Array<{ key: PageKey; label: string; hint: string; icon: typeof AudioLines }> = [
  { key: 'tts', label: '语音合成', hint: 'Reference → Voice', icon: AudioLines },
  { key: 'asr', label: '语音转文字', hint: 'Speech → Text', icon: Mic2 },
  { key: 'models', label: '模型与显存', hint: 'Runtime', icon: Cpu },
  { key: 'settings', label: '设置', hint: 'Preferences', icon: Settings2 }
]

interface Props {
  page: PageKey
  onPage: (page: PageKey) => void
  engines: Record<'tts' | 'asr', EngineStatus>
  gpu: GpuInfo | null
}

function stateLabel(state: string): string {
  if (state === 'ready') return '已就绪'
  if (state === 'busy') return '处理中'
  if (state === 'loading' || state === 'starting') return '加载中'
  if (state === 'stopping') return '卸载中'
  if (state === 'error') return '异常'
  return '未加载'
}

export function Sidebar({ page, onPage, engines, gpu }: Props): JSX.Element {
  const used = gpu ? Math.round(gpu.memoryUsedMB / 1024 * 10) / 10 : null
  const total = gpu ? Math.round(gpu.memoryTotalMB / 1024 * 10) / 10 : null
  return (
    <aside className="sidebar">
      <div className="sidebar-section-label">工作台</div>
      <nav className="nav">
        {NAV.map((item) => {
          const Icon = item.icon
          const active = page === item.key
          return (
            <button key={item.key} className={cn('nav-item', active && 'active')} onClick={() => onPage(item.key)}>
              {active && <motion.span layoutId="nav-glow" className="nav-glow" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
              <Icon size={18} strokeWidth={2.1} />
              <span className="nav-copy">
                <span className="nav-label">{item.label}</span>
                <span className="nav-hint">{item.hint}</span>
              </span>
            </button>
          )
        })}
      </nav>

      <div className="sidebar-spacer" />

      <div className="runtime-card">
        <div className="runtime-head">
          <span className="runtime-title">运行状态</span>
          <Sparkles size={14} className="muted-icon" />
        </div>
        {(['tts', 'asr'] as const).map((key) => {
          const status = engines[key]
          return (
            <div className="runtime-row" key={key}>
              <span className={cn('status-dot', status.state)} />
              <span className="runtime-label">{key === 'tts' ? 'TTS 引擎' : 'ASR 引擎'}</span>
              <span className="runtime-value">{stateLabel(status.state)}</span>
            </div>
          )
        })}
        <div className="runtime-divider" />
        <div className="runtime-row">
          <span className="runtime-label">显存</span>
          <span className="runtime-value">
            {used !== null && total !== null ? `${used} / ${total} GB` : '未检测到 GPU'}
          </span>
        </div>
        <div className="mini-vram">
          <span style={{ width: `${gpu && gpu.memoryTotalMB ? Math.min(100, (gpu.memoryUsedMB / gpu.memoryTotalMB) * 100) : 0}%` }} />
        </div>
      </div>

      <div className="sidebar-foot">
        <span className="foot-dot" />
        <span>本地运行 · 数据不离开电脑</span>
      </div>
    </aside>
  )
}
