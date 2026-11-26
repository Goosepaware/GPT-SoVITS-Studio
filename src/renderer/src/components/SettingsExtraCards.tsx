import { useEffect, useState } from 'react'
import { Bot, Captions, Check, Copy, Loader2, RotateCw, Wand2 } from 'lucide-react'
import { SUBTITLE_FORMATS, type AppConfig, type McpStatus, type SubtitleConfig, type SubtitleFormat } from '@shared/types'
import { Select } from './Select'
import { cn } from '../lib/format'

type Notify = (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void

function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return (
    <button className={cn('toggle', checked && 'on')} onClick={() => onChange(!checked)} type="button" role="switch" aria-checked={checked}>
      <span />
    </button>
  )
}

export const FORMAT_LABEL: Record<SubtitleFormat, string> = {
  srt: 'SRT',
  ass: 'ASS',
  vtt: 'VTT',
  lrc: 'LRC',
  txt: 'TXT',
  json: '时间轴 JSON'
}

const num = (v: string, fallback: number): number => (v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback)

export function SubtitleSettingsCard({ form, patch }: { form: AppConfig; patch: (p: Partial<AppConfig>) => void }): JSX.Element {
  const s = form.subtitle
  const set = (p: Partial<SubtitleConfig>): void => patch({ subtitle: { ...s, ...p } })
  const toggleFormat = (f: SubtitleFormat): void => {
    const next = s.autoFormats.includes(f) ? s.autoFormats.filter((x) => x !== f) : [...s.autoFormats, f]
    set({ autoFormats: next.length ? next : [f] })
  }
  return (
    <section className="card settings-card">
      <div className="panel-head">
        <div>
          <span className="eyebrow">SUBTITLES</span>
          <h2>字幕</h2>
        </div>
        <Captions size={17} className="muted-icon" />
      </div>
      <div className="setting-row">
        <div><strong>生成时自动输出字幕</strong><span>在音频旁写出所选格式的字幕文件</span></div>
        <Toggle checked={s.autoExport} onChange={(v) => set({ autoExport: v })} />
      </div>
      {s.autoExport && (
        <div className="setting-row">
          <div><strong>自动输出格式</strong><span>可多选</span></div>
          <div className="chip-row">
            {SUBTITLE_FORMATS.map((f) => (
              <button key={f} type="button" className={cn('chip', s.autoFormats.includes(f) && 'active')} onClick={() => toggleFormat(f)}>
                {FORMAT_LABEL[f]}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="setting-row">
        <div><strong>默认导出格式</strong><span>导出按钮与最近生成的字幕按钮使用</span></div>
        <Select value={s.defaultFormat} onChange={(v) => set({ defaultFormat: v as SubtitleFormat })} compact className="tiny">
          {SUBTITLE_FORMATS.map((f) => (
            <option key={f} value={f}>{FORMAT_LABEL[f]}</option>
          ))}
        </Select>
      </div>
      <div className="setting-row">
        <div><strong>每条最多字数</strong><span>超出按标点 / 换气停顿拆分（英文按半字计）</span></div>
        <input className="tiny-input" type="number" min={4} max={60} value={s.maxChars} onChange={(e) => set({ maxChars: num(e.target.value, 18) })} />
      </div>
      <div className="setting-row">
        <div><strong>短句合并</strong><span>少于 N 字或短于 X 秒的相邻句合并</span></div>
        <div className="input-pair">
          <input className="tiny-input" type="number" min={0} max={20} value={s.minChars} onChange={(e) => set({ minChars: num(e.target.value, 4) })} />
          <span>字</span>
          <input className="tiny-input" type="number" min={0} max={5} step={0.1} value={s.minDuration} onChange={(e) => set({ minDuration: num(e.target.value, 0.8) })} />
          <span>秒</span>
        </div>
      </div>
      <div className="setting-row">
        <div><strong>去掉句末标点</strong><span>常见字幕习惯</span></div>
        <Toggle checked={s.stripTrailingPunct} onChange={(v) => set({ stripTrailingPunct: v })} />
      </div>
      <div className="setting-row">
        <div><strong>全局偏移</strong><span>毫秒，正数延后，负数提前</span></div>
        <input className="tiny-input" type="number" step={10} value={s.offsetMs} onChange={(e) => set({ offsetMs: num(e.target.value, 0) })} />
      </div>
      <div className="setting-row">
        <div><strong>ASS 字体 / 字号</strong><span>以 1920×1080 为基准</span></div>
        <div className="input-pair">
          <input className="small-input" value={s.assFont} onChange={(e) => set({ assFont: e.target.value })} />
          <input className="tiny-input" type="number" min={8} max={200} value={s.assFontSize} onChange={(e) => set({ assFontSize: num(e.target.value, 64) })} />
        </div>
      </div>
    </section>
  )
}

export function AiConnectCard({
  form,
  saved,
  patch,
  notify
}: {
  form: AppConfig
  saved: AppConfig
  patch: (p: Partial<AppConfig>) => void
  notify: Notify
}): JSX.Element {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [activity, setActivity] = useState<string[]>([])
  const m = form.mcp

  useEffect(() => {
    void window.api.mcp.status().then(setStatus)
  }, [saved.mcp.enabled, saved.mcp.port, saved.mcp.token])
  useEffect(() => window.api.mcp.onActivity((line) => setActivity((prev) => [line, ...prev].slice(0, 30))), [])

  async function copy(text: string, label: string): Promise<void> {
    await navigator.clipboard.writeText(text)
    notify(`${label}已复制`, 'success')
  }

  async function run(key: string, fn: () => Promise<McpStatus>, ok: string): Promise<void> {
    setBusy(key)
    try {
      setStatus(await fn())
      notify(ok, 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card settings-card ai-card">
      <div className="panel-head">
        <div>
          <span className="eyebrow">AI AGENTS</span>
          <h2>AI 连接（MCP）</h2>
        </div>
        <Bot size={17} className="muted-icon" />
      </div>
      <div className="setting-row">
        <div>
          <strong>启用 MCP 服务</strong>
          <span>
            {status?.running ? `运行中 · ${status.url}` : status?.error ? `未运行：${status.error}` : '未运行'} · 关闭窗口后在托盘继续服务
          </span>
        </div>
        <Toggle checked={m.enabled} onChange={(v) => patch({ mcp: { ...m, enabled: v } })} />
      </div>
      <div className="setting-row">
        <div>
          <strong>允许 Agent 自动启动</strong>
          <span>软件退出后，MCP 客户端可静默拉起后台服务；默认关闭，且不会出现托盘图标</span>
        </div>
        <Toggle checked={m.autoStart} onChange={(v) => patch({ mcp: { ...m, autoStart: v } })} />
      </div>
      <div className="setting-row">
        <div><strong>端口</strong><span>仅监听 127.0.0.1，修改后保存生效</span></div>
        <input className="tiny-input" type="number" min={1025} max={65535} value={m.port} onChange={(e) => patch({ mcp: { ...m, port: Number(e.target.value) || 39281 } })} />
      </div>
      <div className="setting-row">
        <div><strong>访问令牌</strong><span>stdio 方式自动读取；HTTP 方式重新生成后需重新写入客户端</span></div>
        <div className="input-pair">
          <button className="btn ghost small" onClick={() => void copy(saved.mcp.token, '令牌')}><Copy size={13} /> 复制</button>
          <button className="btn ghost small" disabled={busy === 'token'} onClick={() => void run('token', () => window.api.mcp.regenerateToken(), '令牌已重新生成')}>
            <RotateCw size={13} /> 重新生成
          </button>
        </div>
      </div>
      <label className="field">
        <span className="field-label">路径白名单 <em>每行一个目录。留空：可读取任意位置，只能写入输出目录和数据目录；需要写入其他目录时把文件夹加入白名单</em></span>
        <textarea
          rows={2}
          value={m.pathAllowlist.join('\n')}
          onChange={(e) => patch({ mcp: { ...m, pathAllowlist: e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) } })}
        />
      </label>

      <div className="setting-row">
        <div><strong>让 AI 自己接入</strong><span>复制一段提示词粘贴给任意 agent，它会自行写好配置</span></div>
        <button className="btn primary small" onClick={() => void window.api.mcp.agentPrompt().then((t) => copy(t, '接入提示词'))}>
          <Wand2 size={13} /> 复制提示词
        </button>
      </div>

      <div className="mcp-clients">
        {(status?.clients || []).map((c) => (
          <div key={c.id} className={cn('mcp-client', !c.detected && 'dim')} title={c.configPath}>
            <div>
              <strong>{c.label}</strong>
              <span>{c.configured ? '已配置' : c.detected ? '已检测到' : '未检测到'}</span>
            </div>
            <div className="input-pair">
              <button className="btn ghost small" title="复制配置片段" onClick={() => void window.api.mcp.snippet(c.id).then((t) => copy(t, `${c.label} 配置`))}>
                <Copy size={13} />
              </button>
              <button
                className="btn ghost small"
                disabled={busy === c.id}
                onClick={() => void run(c.id, () => window.api.mcp.configureClient(c.id), `已写入 ${c.label} 配置（原文件备份为 .gsv-backup），重启客户端生效`)}
              >
                {busy === c.id ? <Loader2 size={13} className="spin" /> : c.configured ? <Check size={13} /> : null}
                {c.configured ? '重新写入' : '一键连接'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {activity.length > 0 && (
        <div className="mcp-activity">
          {activity.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
      <div className="setting-note">
        agent 任务与界面操作共用同一显卡队列，界面操作优先。agent 调用不弹确认框；删除音色需 agent 显式传 confirm。完整日志：data/logs/mcp.log
      </div>
    </section>
  )
}
