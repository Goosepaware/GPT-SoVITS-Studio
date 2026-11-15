import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Activity, AlertTriangle, CheckCircle2, Cpu, FolderOpen, HardDrive, Loader2, RefreshCw, Square, Terminal, Zap } from 'lucide-react'
import type { Bootstrap, EngineStatus, GpuInfo } from '@shared/types'
import { cn, formatBytes, formatClock } from '../lib/format'

export interface LogLine {
  id: string
  engine: 'tts' | 'asr'
  line: string
  ts: number
}

interface Props {
  bootstrap: Bootstrap
  engines: Record<'tts' | 'asr', EngineStatus>
  gpu: GpuInfo | null
  logs: LogLine[]
  notify: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void
  onBootstrap: (next: Bootstrap) => void
}

function stateText(state: string): string {
  if (state === 'ready') return '已就绪'
  if (state === 'busy') return '处理中'
  if (state === 'loading') return '正在加载'
  if (state === 'starting') return '启动中'
  if (state === 'stopping') return '正在卸载'
  if (state === 'error') return '异常'
  return '未加载'
}

function modelName(path: string | undefined): string {
  if (!path) return '—'
  return path.split(/[\\/]/).pop() || path
}

export function ModelsPage({ bootstrap, engines, gpu, logs, notify, onBootstrap }: Props): JSX.Element {
  const [logFilter, setLogFilter] = useState<'all' | 'tts' | 'asr'>('all')
  const [refreshing, setRefreshing] = useState(false)
  const filteredLogs = useMemo(() => logs.filter((log) => logFilter === 'all' || log.engine === logFilter).slice(-160), [logs, logFilter])
  const vramRatio = gpu && gpu.memoryTotalMB ? Math.min(1, gpu.memoryUsedMB / gpu.memoryTotalMB) : 0

  async function refresh(): Promise<void> {
    setRefreshing(true)
    try {
      const next = await window.api.refreshBootstrap()
      onBootstrap(next)
      notify('模型列表已刷新', 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setRefreshing(false)
    }
  }

  const cards: Array<{ engine: 'tts' | 'asr'; title: string; subtitle: string; rows: Array<[string, string]> }> = [
    {
      engine: 'tts',
      title: '语音合成引擎',
      subtitle: 'GPT-SoVITS v5turbo',
      rows: [
        ['GPT 模型', modelName(engines.tts.models.gpt)],
        ['SoVITS 模型', modelName(engines.tts.models.sovits)],
        ['声码器', engines.tts.models.vocoder || 'v5turbo'],
        ['特征模型', engines.tts.models.bert || 'BERT + HuBERT']
      ]
    },
    {
      engine: 'asr',
      title: '语音识别引擎',
      subtitle: 'SenseVoiceSmall',
      rows: [
        ['ASR 模型', modelName(engines.asr.models.asr)],
        ['VAD 模型', modelName(engines.asr.models.vad)],
        ['设备', bootstrap.config.device.startsWith('cuda') ? 'CUDA' : 'CPU'],
        ['精度', bootstrap.config.half ? 'FP16' : 'FP32']
      ]
    }
  ]

  return (
    <div className="page models-page">
      <div className="models-top-grid">
        {cards.map((card) => {
          const status = engines[card.engine]
          const active = status.state !== 'stopped'
          const uptime = status.startedAt && active ? formatClock(Date.now() - status.startedAt) : null
          return (
            <motion.section className="card engine-card" key={card.engine} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <div className="engine-card-head">
                <div className={cn('engine-orb', card.engine, status.state)}>
                  {status.state === 'loading' || status.state === 'starting' ? <Loader2 size={21} className="spin" /> : card.engine === 'tts' ? <Zap size={21} /> : <Activity size={21} />}
                </div>
                <div className="engine-title">
                  <h2>{card.title}</h2>
                  <span>{card.subtitle}</span>
                </div>
                <span className={cn('chip', 'engine-chip', status.state)}>
                  <span className="status-dot" />
                  {stateText(status.state)}
                </span>
              </div>
              <div className="engine-rows">
                {card.rows.map(([label, value]) => (
                  <div className="engine-row" key={label}>
                    <span>{label}</span>
                    <strong title={value}>{value}</strong>
                  </div>
                ))}
                <div className="engine-row">
                  <span>进程 / torch 显存</span>
                  <strong>{active ? `${status.pid || '—'} · ${status.vram ? `${(status.vram.allocatedMB / 1024).toFixed(2)} GB` : '统计中'}` : '未占用'}</strong>
                </div>
                {uptime && <div className="engine-row"><span>已运行</span><strong className="mono">{uptime}</strong></div>}
              </div>
              {status.message && <div className="engine-message">{status.message}</div>}
              <div className="engine-actions">
                <button className="btn ghost small" disabled={!active} onClick={() => void (card.engine === 'tts' ? window.api.tts.unload() : window.api.asr.unload())}>
                  <Square size={13} fill="currentColor" />
                  卸载并释放显存
                </button>
                <button className="text-btn" onClick={() => void window.api.openPath(bootstrap.config.engineRoot)}>
                  <FolderOpen size={13} /> 打开引擎目录
                </button>
              </div>
            </motion.section>
          )
        })}
      </div>

      <div className="models-mid-grid">
        <section className="card gpu-card">
          <div className="panel-head compact-head">
            <div>
              <span className="eyebrow">GPU</span>
              <h2>显卡状态</h2>
            </div>
            <button className="icon-btn small" title="刷新" onClick={() => void refresh()}><RefreshCw size={14} /></button>
          </div>
          <div className="gpu-hero">
            <div className="gpu-hero-icon"><Cpu size={24} /></div>
            <div>
              <strong>{gpu?.name || '未检测到 NVIDIA GPU'}</strong>
              <span>{gpu ? `显存 ${(gpu.memoryUsedMB / 1024).toFixed(1)} / ${(gpu.memoryTotalMB / 1024).toFixed(1)} GB` : '请确认 nvidia-smi 可用'}</span>
            </div>
            {gpu?.utilization !== null && gpu && <span className="gpu-util">{gpu.utilization}%</span>}
          </div>
          <div className="gpu-big-bar"><span style={{ width: `${vramRatio * 100}%` }} className={cn(vramRatio > 0.82 && 'warn')} /></div>
          <div className="gpu-legend">
            <span><span className="legend-dot used" /> 已用</span>
            <span><span className="legend-dot free" /> 空闲</span>
            <span className="gpu-note">8GB 显卡建议只常驻一个引擎</span>
          </div>
        </section>

        <section className="card policy-card">
          <div className="panel-head compact-head">
            <div>
              <span className="eyebrow">POLICY</span>
              <h2>资源策略</h2>
            </div>
            <HardDrive size={17} className="muted-icon" />
          </div>
          <div className="policy-row">
            <span>切换引擎时自动卸载</span>
            <strong className={bootstrap.config.autoUnloadOnSwitch ? 'ok' : 'warn'}>{bootstrap.config.autoUnloadOnSwitch ? '已开启' : '已关闭'}</strong>
          </div>
          <div className="policy-row">
            <span>空闲自动释放</span>
            <strong>{bootstrap.config.idleUnloadMinutes > 0 ? `${bootstrap.config.idleUnloadMinutes} 分钟` : '关闭'}</strong>
          </div>
          <div className="policy-row">
            <span>退出应用</span>
            <strong className="ok">强制结束 worker</strong>
          </div>
          <div className="policy-note">
            <CheckCircle2 size={15} />
            <span>卸载会直接结束 Python 进程，CUDA 上下文和显存由系统回收；即使窗口崩溃，worker 也会检测父进程退出并自行结束。</span>
          </div>
        </section>
      </div>

      <section className="card log-card">
        <div className="panel-head compact-head">
          <div>
            <span className="eyebrow">LOG</span>
            <h2>运行日志</h2>
          </div>
          <div className="log-tabs">
            {(['all', 'tts', 'asr'] as const).map((tab) => (
              <button key={tab} className={cn('log-tab', logFilter === tab && 'active')} onClick={() => setLogFilter(tab)}>
                {tab === 'all' ? '全部' : tab.toUpperCase()}
              </button>
            ))}
            <button className="text-btn" onClick={() => setLogFilter(logFilter)}><Terminal size={13} /> 实时</button>
          </div>
        </div>
        <div className="log-console">
          {filteredLogs.length === 0 ? (
            <div className="log-empty">加载模型或生成语音后，这里会显示推理进程的输出。</div>
          ) : (
            filteredLogs.map((log) => (
              <div className={cn('log-line', log.engine)} key={log.id}>
                <span className="log-time">{new Date(log.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                <span className="log-engine">{log.engine.toUpperCase()}</span>
                <span className="log-text">{log.line}</span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="card refresh-card">
        <div>
          <h3>模型文件有变化？</h3>
          <p>把训练好的 v5turbo 权重放进 <code>GPT_weights_v5turbo</code> / <code>SoVITS_weights_v5turbo</code>，刷新后即可在合成页选择。</p>
        </div>
        <button className="btn primary" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
          刷新模型列表
        </button>
      </section>
      {engines.tts.state === 'error' && (
        <div className="inline-error"><AlertTriangle size={15} /><span>{engines.tts.message || 'TTS 引擎异常'}</span></div>
      )}
      {engines.asr.state === 'error' && (
        <div className="inline-error"><AlertTriangle size={15} /><span>{engines.asr.message || 'ASR 引擎异常'}</span></div>
      )}
    </div>
  )
}
