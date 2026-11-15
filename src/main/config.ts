import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig, ThemeMode } from '@shared/types'
import { detectEngineRoot, getAppPaths, isEngineRoot } from './paths'

const CONFIG_VERSION = 3

interface StoredConfig extends AppConfig {
  version: number
}

export function defaultConfig(engineRoot: string, dataRoot: string): AppConfig {
  return {
    engineRoot,
    outputDir: path.join(dataRoot, 'outputs'),
    theme: 'mono-system',
    autoUnloadOnSwitch: true,
    idleUnloadMinutes: 15,
    device: 'cuda:0',
    half: true
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
        storedVersion < CONFIG_VERSION && raw.theme !== 'color-system' && raw.theme !== 'mono-system'
          ? 'mono-system'
          : theme,
      autoUnloadOnSwitch: raw.autoUnloadOnSwitch !== false,
      idleUnloadMinutes: Number.isFinite(Number(raw.idleUnloadMinutes)) ? Number(raw.idleUnloadMinutes) : 15,
      device: raw.device || 'cuda:0',
      half: raw.half !== false
    }
    if (!merged.engineRoot || !isEngineRoot(merged.engineRoot)) {
      merged.engineRoot = detected || merged.engineRoot || ''
    }
    if (!merged.outputDir || !fs.existsSync(merged.outputDir)) {
      merged.outputDir = fallback.outputDir
    }
    if (!fs.existsSync(merged.outputDir)) fs.mkdirSync(merged.outputDir, { recursive: true })
    if (!raw.engineRoot || raw.engineRoot !== merged.engineRoot || storedVersion < CONFIG_VERSION) {
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
