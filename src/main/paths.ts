import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface AppPaths {
  appRoot: string
  dataRoot: string
  outputDir: string
  voicesDir: string
  logsDir: string
  cacheDir: string
  tempDir: string
  pythonDir: string
  configFile: string
  historyFile: string
  voicesFile: string
}

export function getAppRoot(): string {
  return app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath()
}

export function getPythonDir(appRoot: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'python') : path.join(appRoot, 'python')
}

export function getAppPaths(): AppPaths {
  const appRoot = getAppRoot()
  const dataRoot = path.join(appRoot, 'data')
  const paths: AppPaths = {
    appRoot,
    dataRoot,
    outputDir: path.join(dataRoot, 'outputs'),
    voicesDir: path.join(dataRoot, 'voices'),
    logsDir: path.join(dataRoot, 'logs'),
    cacheDir: path.join(dataRoot, 'cache'),
    tempDir: path.join(dataRoot, 'temp'),
    pythonDir: getPythonDir(appRoot),
    configFile: path.join(dataRoot, 'config.json'),
    historyFile: path.join(dataRoot, 'history.json'),
    voicesFile: path.join(dataRoot, 'voices.json')
  }
  for (const dir of [dataRoot, paths.outputDir, paths.voicesDir, paths.logsDir, paths.cacheDir, paths.tempDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return paths
}

export function isEngineRoot(root: string): boolean {
  if (!root) return false
  try {
    return (
      fs.existsSync(path.join(root, 'runtime', 'python.exe')) &&
      fs.existsSync(path.join(root, 'GPT_SoVITS', 'TTS_infer_pack', 'TTS.py'))
    )
  } catch {
    return false
  }
}

export function detectEngineRoot(projectRoot: string): string {
  const candidates: string[] = []
  if (process.env.GSV_ENGINE_ROOT) candidates.push(process.env.GSV_ENGINE_ROOT)
  candidates.push(path.join(projectRoot, 'engine'))
  try {
    const parent = path.dirname(projectRoot)
    const siblings = fs.readdirSync(parent, { withFileTypes: true })
    for (const entry of siblings) {
      if (entry.isDirectory() && entry.name.toLowerCase().includes('gpt-sovits')) {
        candidates.push(path.join(parent, entry.name))
      }
    }
  } catch {
    // ignore
  }
  for (const candidate of candidates) {
    if (isEngineRoot(candidate)) {
      return path.resolve(candidate)
    }
  }
  return ''
}

export function engineMissing(root: string): string[] {
  const required = [
    ['runtime/python.exe', 'Python 运行时'],
    ['GPT_SoVITS/TTS_infer_pack/TTS.py', 'GPT-SoVITS 推理代码'],
    ['GPT_SoVITS/pretrained_models/s1v3.ckpt', 'v5turbo GPT 底模'],
    ['GPT_SoVITS/pretrained_models/gsv-v5-pretrained/s2Gv5turbo.pth', 'v5turbo SoVITS 底模']
  ]
  if (!root) return required.map(([, label]) => label)
  return required.filter(([rel]) => !fs.existsSync(path.join(root, rel))).map(([, label]) => label)
}

export function getUserCacheDir(): string {
  return path.join(os.homedir(), '.cache')
}
