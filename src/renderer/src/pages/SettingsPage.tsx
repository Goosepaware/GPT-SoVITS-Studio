import { useEffect, useMemo, useState } from 'react'
import { Check, Contrast, FolderOpen, HardDrive, Loader2, Monitor, Moon, Palette, RotateCw, Save, ShieldCheck, Sun, Trash2 } from 'lucide-react'
import type { AppConfig, Bootstrap } from '@shared/types'
import { Select } from '../components/Select'
import { cn } from '../lib/format'
import { applyTheme as applyDocumentTheme, watchSystemTheme } from '../lib/theme'

interface Props {
  bootstrap: Bootstrap
  notify: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void
  onBootstrap: (next: Bootstrap) => void
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return (
    <button className={cn('toggle', checked && 'on')} onClick={() => onChange(!checked)} type="button" role="switch" aria-checked={checked}>
      <span />
    </button>
  )
}

export function SettingsPage({ bootstrap, notify, onBootstrap }: Props): JSX.Element {
  const [form, setForm] = useState<AppConfig>(bootstrap.config)
  const [saving, setSaving] = useState(false)
  const [scanning, setScanning] = useState(false)
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(bootstrap.config), [form, bootstrap.config])
  const themeFamily = form.theme.startsWith('mono') ? 'mono' : 'color'
  const themeVariant: 'dark' | 'light' | 'system' = form.theme.endsWith('-system') ? 'system' : form.theme.endsWith('light') ? 'light' : 'dark'

  useEffect(() => {
    setForm(bootstrap.config)
  }, [bootstrap.config])

  useEffect(() => watchSystemTheme(form.theme, () => applyDocumentTheme(form.theme)), [form.theme])

  function patch(patchValue: Partial<AppConfig>): void {
    setForm((prev) => ({ ...prev, ...patchValue }))
  }

  function applyThemeChoice(family: 'color' | 'mono', variant: 'dark' | 'light' | 'system'): void {
    const theme =
      family === 'mono'
        ? variant === 'system'
          ? 'mono-system'
          : variant === 'light'
            ? 'mono-light'
            : 'mono-dark'
        : variant === 'system'
          ? 'color-system'
          : variant === 'light'
            ? 'light'
            : 'dark'
    patch({ theme })
    applyDocumentTheme(theme)
  }

  async function chooseEngine(): Promise<void> {
    const dir = await window.api.chooseDirectory('选择 GPT-SoVITS 整合包目录')
    if (dir) patch({ engineRoot: dir })
  }

  async function chooseOutput(): Promise<void> {
    const dir = await window.api.chooseDirectory('选择输出目录')
    if (dir) patch({ outputDir: dir })
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const next = await window.api.updateConfig(form)
      onBootstrap(next)
      applyDocumentTheme(next.config.theme)
      notify('设置已保存', 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function rescan(): Promise<void> {
    setScanning(true)
    try {
      const next = await window.api.refreshBootstrap()
      onBootstrap(next)
      notify('模型列表已刷新', 'success')
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="page settings-page">
      <div className="settings-grid">
        <section className="card settings-card">
          <div className="panel-head">
            <div>
              <span className="eyebrow">PATHS</span>
              <h2>路径</h2>
            </div>
            <FolderOpen size={17} className="muted-icon" />
          </div>
          <label className="field">
            <span className="field-label">GPT-SoVITS 整合包目录 <em>包含 runtime 与 GPT_SoVITS</em></span>
            <div className="input-action">
              <input value={form.engineRoot} onChange={(event) => patch({ engineRoot: event.target.value })} />
              <button className="btn ghost small" onClick={() => void chooseEngine()}>选择</button>
            </div>
          </label>
          <div className={cn('validation-line', bootstrap.validation.valid ? 'ok' : 'bad')}>
            {bootstrap.validation.valid ? <ShieldCheck size={14} /> : <HardDrive size={14} />}
            <span>{bootstrap.validation.valid ? '引擎目录有效' : `缺少：${bootstrap.validation.missing.join('、') || '必要文件'}`}</span>
          </div>
          <label className="field">
            <span className="field-label">语音输出目录</span>
            <div className="input-action">
              <input value={form.outputDir} onChange={(event) => patch({ outputDir: event.target.value })} />
              <button className="btn ghost small" onClick={() => void chooseOutput()}>选择</button>
            </div>
          </label>
          <div className="settings-actions">
            <button className="btn ghost small" onClick={() => void window.api.openPath(bootstrap.config.engineRoot)}><FolderOpen size={14} /> 打开引擎目录</button>
            <button className="btn ghost small" onClick={() => void window.api.openPath(bootstrap.dataRoot)}><HardDrive size={14} /> 打开数据目录</button>
            <button className="btn ghost small" onClick={() => void rescan()} disabled={scanning}>
              {scanning ? <Loader2 size={14} className="spin" /> : <RotateCw size={14} />}
              重新扫描模型
            </button>
          </div>
        </section>

        <section className="card settings-card">
          <div className="panel-head">
            <div>
              <span className="eyebrow">ENGINE</span>
              <h2>推理与显存</h2>
            </div>
            <Monitor size={17} className="muted-icon" />
          </div>
          <div className="setting-row">
            <div><strong>切换引擎时自动卸载</strong><span>8GB 显卡建议开启，避免 TTS + ASR 同时占用</span></div>
            <Toggle checked={form.autoUnloadOnSwitch} onChange={(value) => patch({ autoUnloadOnSwitch: value })} />
          </div>
          <div className="setting-row">
            <div><strong>空闲自动释放显存</strong><span>引擎就绪但长时间不用时自动结束进程</span></div>
            <Select value={String(form.idleUnloadMinutes)} onChange={(value) => patch({ idleUnloadMinutes: Number(value) })} compact className="tiny">
              <option value="0">关闭</option>
              <option value="5">5 分钟</option>
              <option value="10">10 分钟</option>
              <option value="15">15 分钟</option>
              <option value="30">30 分钟</option>
            </Select>
          </div>
          <div className="setting-row">
            <div><strong>半精度 FP16</strong><span>降低显存占用，50 系显卡建议开启</span></div>
            <Toggle checked={form.half} onChange={(value) => patch({ half: value })} />
          </div>
          <div className="setting-row">
            <div><strong>推理设备</strong><span>当前仅支持单卡</span></div>
            <Select value={form.device} onChange={(value) => patch({ device: value })} compact className="tiny">
              <option value="cuda:0">CUDA 0</option>
              <option value="cpu">CPU</option>
            </Select>
          </div>
        </section>

        <section className="card settings-card">
          <div className="panel-head">
            <div>
              <span className="eyebrow">APPEARANCE</span>
              <h2>外观</h2>
            </div>
            <Sun size={17} className="muted-icon" />
          </div>
          <div className="theme-picker">
            <div className="theme-family-grid">
              <button className={cn('theme-family', themeFamily === 'color' && 'active')} onClick={() => applyThemeChoice('color', themeVariant)}>
                <Palette size={18} />
                <span>彩色</span>
                <em>紫青渐变 · 原风格</em>
              </button>
              <button className={cn('theme-family', themeFamily === 'mono' && 'active')} onClick={() => applyThemeChoice('mono', themeVariant)}>
                <Contrast size={18} />
                <span>黑白</span>
                <em>去色 · 直角线条</em>
              </button>
            </div>
            <div className="theme-mode-row">
              <span className="theme-mode-label">明暗</span>
              <div className="theme-mode-seg">
                <button className={cn(themeVariant === 'dark' && 'active')} onClick={() => applyThemeChoice(themeFamily, 'dark')}>
                  <Moon size={14} /> 深色
                </button>
                <button className={cn(themeVariant === 'light' && 'active')} onClick={() => applyThemeChoice(themeFamily, 'light')}>
                  <Sun size={14} /> 浅色
                </button>
                <button className={cn(themeVariant === 'system' && 'active')} onClick={() => applyThemeChoice(themeFamily, 'system')}>
                  <Monitor size={14} /> 跟随系统
                </button>
              </div>
            </div>
          </div>
          <div className="setting-note">
            默认主题为黑白，明暗跟随系统；彩色 / 黑白都支持深色、浅色和跟随系统。主题会立即预览，点击保存后持久化。
          </div>
        </section>

        <section className="card settings-card about-card">
          <div className="panel-head">
            <div>
              <span className="eyebrow">ABOUT</span>
              <h2>关于</h2>
            </div>
            <ShieldCheck size={17} className="muted-icon" />
          </div>
          <div className="about-rows">
            <div><span>应用</span><strong>GPT-SoVITS-Studio {bootstrap.version}</strong></div>
            <div><span>推理</span><strong>v5turbo · GPT-SoVITS</strong></div>
            <div><span>识别</span><strong>SenseVoice</strong></div>
            <div><span>数据</span><strong>{bootstrap.dataRoot}</strong></div>
          </div>
          <div className="about-note">所有模型与音频都在本机处理，不经过任何云端服务。</div>
        </section>
      </div>

      <div className="settings-savebar">
        <div>
          {dirty ? <span className="dirty-dot"><span />有未保存的更改</span> : <span className="saved-note"><Check size={13} /> 设置已同步</span>}
        </div>
        <div className="settings-save-actions">
          {dirty && <button className="btn ghost" onClick={() => setForm(bootstrap.config)}>撤销</button>}
          <button className="btn primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <Loader2 size={15} className="spin" /> : <Save size={15} />}
            保存设置
          </button>
        </div>
      </div>
    </div>
  )
}
