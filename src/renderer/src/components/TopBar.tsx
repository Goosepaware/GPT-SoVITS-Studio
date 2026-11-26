import { motion } from 'framer-motion'
import { FolderOpen, Power, ShieldCheck } from 'lucide-react'
import type { AppConfig, EngineStatus, GpuInfo } from '@shared/types'
import type { PageKey } from './Sidebar'
import { cn } from '../lib/format'

const META: Record<PageKey, { title: string; subtitle: string }> = {
  tts: { title: '语音合成', subtitle: '用几秒参考声音，生成自然的任意台词' },
  voices: { title: '音色库', subtitle: '文件夹分类、拼音搜索与数百个音色的快速选择' },
  asr: { title: '语音转文字', subtitle: 'SenseVoice 本地快速识别，中 / 英 / 日 / 韩 / 粤' },
  audio: { title: '音频处理', subtitle: '人声 / 背景分离 · UVR MDX-Net，可选下载' },
  models: { title: '模型与显存', subtitle: '看清每一个引擎的状态，用完即释放' },
  settings: { title: '设置', subtitle: '路径、设备与自动化策略' }
}

interface Props {
  page: PageKey
  engines: Record<'tts' | 'asr', EngineStatus>
  gpu: GpuInfo | null
  config: AppConfig
  onUnloadAll: () => void
  onOpenOutput: () => void
}

function statusText(status: EngineStatus): string {
  if (status.state === 'ready') return '就绪'
  if (status.state === 'busy') return '运行中'
  if (status.state === 'loading' || status.state === 'starting') return '加载中'
  if (status.state === 'stopping') return '卸载中'
  if (status.state === 'error') return '异常'
  return '未加载'
}

export function TopBar({ page, engines, gpu, config, onUnloadAll, onOpenOutput }: Props): JSX.Element {
  const meta = META[page]
  const anyRunning = engines.tts.state !== 'stopped' || engines.asr.state !== 'stopped'
  const vramRatio = gpu && gpu.memoryTotalMB ? Math.min(1, gpu.memoryUsedMB / gpu.memoryTotalMB) : 0
  return (
    <header className="topbar">
      <motion.div key={page} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24 }}>
        <h1>{meta.title}</h1>
        <p>{meta.subtitle}</p>
      </motion.div>
      <div className="topbar-right">
        <div className="gpu-pill" title={gpu ? `${gpu.name} · ${gpu.memoryUsedMB}/${gpu.memoryTotalMB} MB` : '未检测到 NVIDIA GPU'}>
          <div className="gpu-pill-head">
            <span className="gpu-name">{gpu ? gpu.name.replace('NVIDIA ', '') : 'GPU 未检测'}</span>
            <span className="gpu-value">{gpu ? `${(gpu.memoryUsedMB / 1024).toFixed(1)} / ${(gpu.memoryTotalMB / 1024).toFixed(1)} GB` : '—'}</span>
          </div>
          <div className="gpu-meter">
            <span style={{ width: `${vramRatio * 100}%` }} className={cn(vramRatio > 0.82 && 'warn')} />
          </div>
        </div>
        <div className="engine-chips">
          {(['tts', 'asr'] as const).map((key) => (
            <span key={key} className={cn('chip engine-chip', engines[key].state)}>
              <span className="status-dot" />
              {key.toUpperCase()} {statusText(engines[key])}
            </span>
          ))}
        </div>
        <button className="icon-btn" title="打开输出文件夹" onClick={onOpenOutput}>
          <FolderOpen size={16} />
        </button>
        <button className="btn danger ghost small" onClick={onUnloadAll} disabled={!anyRunning} title="结束两个推理进程，立即释放显存">
          <Power size={14} />
          全部卸载
        </button>
      </div>
    </header>
  )
}
