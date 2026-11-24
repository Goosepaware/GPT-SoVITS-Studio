import fs from 'node:fs'
import path from 'node:path'
import type { ModelCatalog, ModelOption } from '@shared/types'
import { getUserCacheDir } from './paths'

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function dirSize(dir: string): number {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) total += dirSize(full)
      else if (entry.isFile()) total += fileSize(full)
    }
  } catch {
    // ignore
  }
  return total
}

function listFiles(dir: string, ext: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(ext))
      .map((entry) => path.join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}

function option(id: string, filePath: string, kind: ModelOption['kind'], label: string, base = false): ModelOption {
  return {
    id,
    path: filePath,
    label,
    size: kind === 'asr' || kind === 'vad' ? dirSize(filePath) : fileSize(filePath),
    kind,
    base
  }
}

function asrOption(id: string, dir: string, label: string): ModelOption | null {
  if (!dir || !fs.existsSync(dir)) return null
  return option(id, path.resolve(dir), 'asr', label)
}

function resolveDir(candidates: string[]): string {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return ''
}

export function scanModels(engineRoot: string): ModelCatalog {
  const gsv = path.join(engineRoot, 'GPT_SoVITS')
  const gptBase = path.join(gsv, 'pretrained_models', 's1v3.ckpt')
  const sovitsBase = path.join(gsv, 'pretrained_models', 'gsv-v5-pretrained', 's2Gv5turbo.pth')
  const gptDir = path.join(engineRoot, 'GPT_weights_v5turbo')
  const sovitsDir = path.join(engineRoot, 'SoVITS_weights_v5turbo')
  const cache = getUserCacheDir()

  const gpt: ModelOption[] = []
  const sovits: ModelOption[] = []
  if (fs.existsSync(gptBase)) gpt.push(option('gpt-base', gptBase, 'gpt', '预训练底模 · s1v3.ckpt', true))
  if (fs.existsSync(sovitsBase)) sovits.push(option('sovits-base', sovitsBase, 'sovits', 'v5turbo 底模 · s2Gv5turbo.pth', true))
  for (const file of listFiles(gptDir, '.ckpt')) {
    gpt.push(option(path.basename(file), file, 'gpt', path.basename(file)))
  }
  for (const file of listFiles(sovitsDir, '.pth')) {
    sovits.push(option(path.basename(file), file, 'sovits', path.basename(file)))
  }

  const sensevoiceDir = resolveDir([
    path.join(engineRoot, 'models', 'asr', 'SenseVoiceSmall'),
    path.join(cache, 'modelscope', 'hub', 'models', 'iic', 'SenseVoiceSmall'),
    path.join(cache, 'modelscope', 'models', 'iic--SenseVoiceSmall', 'snapshots', 'master')
  ])
  const vadDir = resolveDir([
    path.join(engineRoot, 'models', 'asr', 'fsmn-vad'),
    path.join(engineRoot, 'tools', 'asr', 'models', 'speech_fsmn_vad_zh-cn-16k-common-pytorch'),
    path.join(cache, 'modelscope', 'models', 'iic--speech_fsmn_vad_zh-cn-16k-common-pytorch', 'snapshots', 'master')
  ])
  const spkDir = resolveDir([
    path.join(engineRoot, 'models', 'asr', 'campplus'),
    path.join(engineRoot, 'models', 'asr', 'speech_campplus_sv_zh-cn_16k-common'),
    path.join(cache, 'modelscope', 'hub', 'models', 'iic', 'speech_campplus_sv_zh-cn_16k-common'),
    path.join(cache, 'modelscope', 'models', 'iic--speech_campplus_sv_zh-cn_16k-common', 'snapshots', 'master')
  ])

  return {
    tts: {
      gpt: gpt.length ? gpt : [],
      sovits: sovits.length ? sovits : []
    },
    asr: {
      sensevoice: asrOption('sensevoice', sensevoiceDir, 'SenseVoice · 快速'),
      vad: asrOption('vad', vadDir, 'FSMN-VAD'),
      spk: asrOption('spk', spkDir, 'CAM++ 说话人')
    }
  }
}
