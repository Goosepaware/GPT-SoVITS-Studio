import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { SUBTITLE_FORMATS, type AppConfig, type McpConfig, type SubtitleConfig, type ThemeMode } from '@shared/types'
import { defaultSubtitleConfig } from './subtitles'
import { detectEngineRoot, getAppPaths, isEngineRoot } from './paths'

export { defaultSubtitleConfig }

const CONFIG_VERSION = 6
const SAMPLE_STEPS = [4, 8, 16, 32]

interface StoredConfig extends AppConfig {
  version: number
}

export function randomToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

export function defaultConfig(engineRoot: string, dataRoot: string): AppConfig {
  return {
    engineRoot,
    outputDir: path.join(dataRoot, 'outputs'),
    theme: 'mono-system',
    autoUnloadOnSwitch: true,
    idleUnloadMinutes: 15,
    device: 'cuda:0',
    half: true,
    defaultSampleSteps: 8,
    subtitle: defaultSubtitleConfig(),
    mcp: { enabled: false, autoStart: false, port: 39281, token: randomToken(), pathAllowlist: [] },
    closeAction: 'ask',
    hfSource: 'mirror'
  }
}

const num = (v: unknown, fallback: number): number => (Number.isFinite(Number(v)) ? Number(v) : fallback)

export function normalizeSampleSteps(value: unknown, fallback = 8): number {
  const steps = Number(value)
  return SAMPLE_STEPS.includes(steps) ? steps : fallback
}

export function mergeSubtitle(raw: Partial<SubtitleConfig> | undefined): SubtitleConfig {
  const d = defaultSubtitleConfig()
  const r = raw || {}
  const fmts = Array.isArray(r.autoFormats) ? r.autoFormats.filter((f) => SUBTITLE_FORMATS.includes(f)) : d.autoFormats
  return {
    autoExport: r.autoExport === true,
    autoFormats: fmts.length ? [...new Set(fmts)] : d.autoFormats,
    defaultFormat: r.defaultFormat && SUBTITLE_FORMATS.includes(r.defaultFormat) ? r.defaultFormat : d.defaultFormat,
    maxChars: Math.max(4, num(r.maxChars, d.maxChars)),
    minChars: Math.max(0, num(r.minChars, d.minChars)),
    minDuration: Math.max(0, num(r.minDuration, d.minDuration)),
    stripTrailingPunct: r.stripTrailingPunct !== false,
    offsetMs: num(r.offsetMs, d.offsetMs),
    assFont: (typeof r.assFont === 'string' && r.assFont.trim()) || d.assFont,
    assFontSize: Math.max(8, num(r.assFontSize, d.assFontSize))
  }
}

export function mergeMcp(raw: Partial<McpConfig> | undefined, fallback: McpConfig): McpConfig {
  const r = raw || {}
  const port = Number(r.port)
  return {
    enabled: r.enabled === true,
    autoStart: r.autoStart === true,
    port: Number.isInteger(port) && port > 1024 && port < 65536 ? port : fallback.port,
    token: typeof r.token === 'string' && r.token.length >= 16 ? r.token : fallback.token,
    pathAllowlist: Array.isArray(r.pathAllowlist) ? r.pathAllowlist.filter((p) => typeof p === 'string' && p.trim()) : []
  }
}

export function loadConfig(): AppConfig {
  const paths = getAppPaths()
  const detected = detectEngineRoot(paths.appRoot)
  const fallback = defaultConfig(detected, paths.dataRoot)
  try {
    if (!fs.existsSync(paths.configFile)) {
      saveConfig(fallback)
      return fallback
    }
    const raw = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) as Partial<StoredConfig>
    const storedVersion = Number(raw.version) || 1
    const theme: ThemeMode =
      raw.theme === 'light' ||
      raw.theme === 'mono-dark' ||
      raw.theme === 'mono-light' ||
      raw.theme === 'color-system' ||
      raw.theme === 'mono-system'
        ? raw.theme
        : 'dark'
    const merged: AppConfig = {
      ...fallback,
      ...raw,
      outputDir: raw.outputDir || fallback.outputDir,
      theme:
        storedVersion < 3 && raw.theme !== 'color-system' && raw.theme !== 'mono-system' ? 'mono-system' : theme,
      autoUnloadOnSwitch: raw.autoUnloadOnSwitch !== false,
      idleUnloadMinutes: num(raw.idleUnloadMinutes, 15),
      device: raw.device || 'cuda:0',
      half: raw.half !== false,
      defaultSampleSteps: normalizeSampleSteps(raw.defaultSampleSteps, fallback.defaultSampleSteps),
      subtitle: mergeSubtitle(raw.subtitle),
      mcp: mergeMcp(raw.mcp, fallback.mcp),
      closeAction: raw.closeAction === 'tray' || raw.closeAction === 'quit' ? raw.closeAction : 'ask',
      hfSource: raw.hfSource === 'official' ? 'official' : 'mirror'
    }
    delete (merged as Partial<StoredConfig>).version
    if (!merged.engineRoot || !isEngineRoot(merged.engineRoot)) {
      merged.engineRoot = detected || merged.engineRoot || ''
    }
    if (!merged.outputDir || !fs.existsSync(merged.outputDir)) {
      merged.outputDir = fallback.outputDir
    }
    if (!fs.existsSync(merged.outputDir)) fs.mkdirSync(merged.outputDir, { recursive: true })
    const tokenChanged = raw.mcp?.token !== merged.mcp.token
    if (tokenChanged || !raw.engineRoot || raw.engineRoot !== merged.engineRoot || storedVersion < CONFIG_VERSION) {
      saveConfig(merged)
    }
    return merged
  } catch {
    return fallback
  }
}

export function saveConfig(config: AppConfig): void {
  const paths = getAppPaths()
  fs.mkdirSync(paths.dataRoot, { recursive: true })
  const stored: StoredConfig = { ...config, version: CONFIG_VERSION }
  fs.writeFileSync(paths.configFile, JSON.stringify(stored, null, 2), 'utf-8')
}
