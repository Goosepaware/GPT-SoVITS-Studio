import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const engineRoot = (() => {
  if (process.env.GSV_ENGINE_ROOT) return process.env.GSV_ENGINE_ROOT
  const local = path.join(process.cwd(), 'engine')
  if (fs.existsSync(path.join(local, 'runtime', 'python.exe'))) return local
  const parent = path.dirname(process.cwd())
  try {
    const candidates = fs.readdirSync(parent)
      .filter((name) => name.toLowerCase().startsWith('gpt-sovits-v5'))
      .map((name) => path.join(parent, name))
      .sort()
    const found = candidates.find((dir) => fs.existsSync(path.join(dir, 'runtime', 'python.exe')))
    if (found) return found
  } catch {
    // ignore
  }
  return ''
})()
if (!engineRoot) {
  console.error('GPT-SoVITS engine not found. Set GSV_ENGINE_ROOT or pass a sibling GPT-SoVITS-v5-* folder.')
  process.exit(1)
}
const python = path.join(engineRoot, 'runtime', 'python.exe')
const dataDir = path.join(process.cwd(), 'data', 'probe')
const refWav = path.join(os.tmpdir(), 'opencode', 'gsv_ref.wav')
const mode = process.argv[2] || 'tts'
const worker = path.join(process.cwd(), 'python', mode === 'asr' ? 'asr_worker.py' : 'tts_worker.py')

fs.mkdirSync(dataDir, { recursive: true })

const proc = spawn(python, ['-I', '-u', worker, '--engine-root', engineRoot, '--data-dir', dataDir], {
  cwd: engineRoot,
  env: {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    GSV_NO_WATCHDOG: process.env.GSV_NO_WATCHDOG || '',
    PATH: `${path.join(engineRoot, 'runtime')};${process.env.PATH || ''}`
  },
  windowsHide: true
})

const pending = new Map()
let seq = 0
proc.stdout.setEncoding('utf8')
const rl = readline.createInterface({ input: proc.stdout })
proc.stderr.setEncoding('utf8')
proc.stderr.on('data', (chunk) => process.stderr.write(chunk))
rl.on('line', (line) => {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    console.log('[raw]', line)
    return
  }
  if (event.type === 'stage' || event.type === 'progress') {
    console.log(`[${event.type}] ${event.stage || ''} ${event.label || event.current + '/' + event.total} ${event.progress ?? ''} ${event.detail || ''}`)
  } else if (event.type === 'status') {
    console.log('[status]', event.status?.state, event.status?.vram || '')
  } else if (event.type === 'worker-ready') {
    console.log('[ready]', event.pid)
  } else if (event.type === 'log') {
    console.log('[log]', event.line)
  } else if (event.type === 'result') {
    console.log('[result]', JSON.stringify(event.data))
    const waiter = pending.get(event.id)
    if (waiter) {
      pending.delete(event.id)
      waiter.resolve(event.data)
    }
  } else if (event.type === 'error') {
    console.log('[error]', event.message)
    const waiter = pending.get(event.id)
    if (waiter) {
      pending.delete(event.id)
      waiter.reject(new Error(event.message))
    }
  } else if (event.type === 'cancelled') {
    console.log('[cancelled]')
    const waiter = pending.get(event.id)
    if (waiter) {
      pending.delete(event.id)
      waiter.reject(new Error('cancelled'))
    }
  }
})

proc.on('exit', (code) => console.log('[exit]', code))

function request(cmd, payload = {}) {
  const id = `req-${++seq}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    proc.stdin.write(JSON.stringify({ cmd, id, ...payload }) + '\n')
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

try {
  await sleep(1200)
  if (mode === 'tts') {
    const base = path.join(engineRoot, 'GPT_SoVITS', 'pretrained_models')
    await request('load', {
      gptPath: path.join(base, 's1v3.ckpt'),
      sovitsPath: path.join(base, 'gsv-v5-pretrained', 's2Gv5turbo.pth'),
      device: 'cuda:0',
      half: true
    })
    const out = path.join(dataDir, 'probe-tts.wav')
    const result = await request('synthesize', {
      text: '你好，这是桌面版语音合成的测试。',
      textLang: 'zh',
      promptText: '开饭时间早上九点至下午五点。',
      promptLang: 'zh',
      refAudioPath: refWav,
      speed: 1,
      splitMethod: 'cut5',
      topK: 15,
      topP: 1,
      temperature: 1,
      repetitionPenalty: 1.35,
      seed: 42,
      batchSize: 1,
      sampleSteps: 4,
      fragmentInterval: 0.3,
      parallelInfer: true,
      outputPath: out
    })
    console.log('TTS OK', result)
  } else {
    const cache = path.join(os.homedir(), '.cache', 'modelscope')
    await request('load', {
      model: 'sensevoice',
      modelPath: path.join(cache, 'hub', 'models', 'iic', 'SenseVoiceSmall'),
      vadPath: path.join(cache, 'models', 'iic--speech_fsmn_vad_zh-cn-16k-common-pytorch', 'snapshots', 'master'),
      device: 'cuda'
    })
    const result = await request('transcribe', { files: [refWav], language: 'auto' })
    console.log('ASR OK', result)
  }
  proc.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n')
  await sleep(800)
} catch (error) {
  console.error('PROBE FAILED', error)
  proc.kill()
  process.exitCode = 1
}
