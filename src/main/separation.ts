/** Vocal / accompaniment separation: model registry, HF download (with mirror) and one-shot python runner. */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { SepModelInfo, SepResult } from '@shared/types'
import { ffmpegPath, run } from './media'

export interface SepModelDef {
  id: string
  label: string
  repo: string
  file: string
  size: number
  nFft: number
  dimF: number
  dimT: number
  compensate: number
  primary: 'vocals' | 'instrumental'
  note: string
}

/** UVR MDX-Net ONNX models. Repo/file verified against the public UVR model mirror on HF. */
export const SEP_MODELS: SepModelDef[] = [
  {
    id: 'kim_vocal_2',
    label: 'Kim Vocal 2 · 人声优先',
    repo: 'seanghay/uvr_models',
    file: 'Kim_Vocal_2.onnx',
    size: 66_759_214,
    nFft: 7680,
    dimF: 3072,
    dimT: 256,
    compensate: 1.009,
    primary: 'vocals',
    note: '人声干净，适合说话人识别和提取参考音'
  },
  {
    id: 'inst_hq_3',
    label: 'Inst HQ 3 · 伴奏优先',
    repo: 'seanghay/uvr_models',
    file: 'UVR-MDX-NET-Inst_HQ_3.onnx',
    size: 66_759_214,
    nFft: 6144,
    dimF: 2560,
    dimT: 256,
    compensate: 1.022,
    primary: 'instrumental',
    note: '背景音保留更完整，适合做配音底轨'
  }
]

export const HF_ENDPOINTS = { official: 'https://huggingface.co', mirror: 'https://hf-mirror.com' } as const
export type HfSource = keyof typeof HF_ENDPOINTS

export function sepDir(engineRoot: string): string {
  return path.join(engineRoot, 'models', 'separation')
}

function modelFile(engineRoot: string, def: SepModelDef): string {
  return path.join(sepDir(engineRoot), def.file)
}

function def(id?: string): SepModelDef {
  const d = SEP_MODELS.find((m) => m.id === id) || SEP_MODELS[0]
  return d
}

const downloads = new Map<string, { received: number; total: number; abort: AbortController }>()

export function listSepModels(engineRoot: string): SepModelInfo[] {
  return SEP_MODELS.map((m) => {
    const file = modelFile(engineRoot, m)
    const dl = downloads.get(m.id)
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      // not installed
    }
    return {
      id: m.id,
      label: m.label,
      note: m.note,
      size: m.size,
      installed: size > 1_000_000,
      path: file,
      downloading: dl ? { received: dl.received, total: dl.total } : null
    }
  })
}

export function installedSepModel(engineRoot: string, id?: string): SepModelDef | null {
  const order = id ? [def(id)] : SEP_MODELS
  for (const m of order) if (fs.existsSync(modelFile(engineRoot, m))) return m
  return null
}

/** Download a model from HF (or hf-mirror). Resumes from a .part file. */
export async function downloadSepModel(
  engineRoot: string,
  id: string,
  source: HfSource,
  onProgress: (received: number, total: number) => void
): Promise<string> {
  const m = def(id)
  if (downloads.has(m.id)) throw new Error('该模型正在下载')
  const target = modelFile(engineRoot, m)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const part = `${target}.part`
  const abort = new AbortController()
  const state = { received: 0, total: m.size, abort }
  downloads.set(m.id, state)
  try {
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0
    const url = `${HF_ENDPOINTS[source] || HF_ENDPOINTS.mirror}/${m.repo}/resolve/main/${encodeURIComponent(m.file)}`
    const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: abort.signal, redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
    const resumed = res.status === 206
    const len = Number(res.headers.get('content-length')) || 0
    state.received = resumed ? have : 0
    state.total = len ? state.received + len : m.size
    const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' })
    let last = 0
    try {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once('drain', () => r()))
        state.received += value.byteLength
        const now = Date.now()
        if (now - last > 250) {
          last = now
          onProgress(state.received, state.total)
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()))
    }
    if (fs.statSync(part).size < 1_000_000) throw new Error('下载文件过小，可能被重定向到错误页面')
    fs.renameSync(part, target)
    onProgress(state.total, state.total)
    return target
  } finally {
    downloads.delete(m.id)
  }
}

export function cancelSepDownload(id: string): void {
  downloads.get(id)?.abort.abort()
}

export function removeSepModel(engineRoot: string, id: string): void {
  const f = modelFile(engineRoot, def(id))
  for (const p of [f, `${f}.part`]) if (fs.existsSync(p)) fs.rmSync(p)
}

let activeProc: ReturnType<typeof spawn> | null = null

export function cancelSeparation(): void {
  if (activeProc?.pid) {
    try {
      spawn('taskkill', ['/PID', String(activeProc.pid), '/T', '/F'], { windowsHide: true })
    } catch {
      activeProc.kill()
    }
  }
}

export interface SepOptions {
  engineRoot: string
  pythonDir: string
  tempDir: string
  logsDir: string
  device: string
  model?: string
  /** Output folder; defaults to a cache folder keyed by source+model. */
  outputDir?: string
  onProgress?: (current: number, total: number, label: string) => void
}

/** Separate vocals / instrumental from a video or audio. Cached by path+size+mtime+model. */
export async function separate(src: string, o: SepOptions): Promise<SepResult> {
  if (!fs.existsSync(src)) throw new Error(`文件不存在: ${src}`)
  const m = installedSepModel(o.engineRoot, o.model)
  if (!m) throw new Error('未安装人声分离模型，请在「音频处理」页下载（Kim Vocal 2 约 64 MB）')
  const st = fs.statSync(src)
  const key = crypto.createHash('sha1').update(`${src}:${st.size}:${st.mtimeMs}:${m.id}`).digest('hex').slice(0, 12)
  const outDir = o.outputDir || path.join(o.tempDir, 'separate', key)
  const vocals = path.join(outDir, 'vocals.wav')
  const instrumental = path.join(outDir, 'instrumental.wav')
  if (fs.existsSync(vocals) && fs.existsSync(instrumental)) return { vocals, instrumental, model: m.id, sourcePath: src, cached: true }

  fs.mkdirSync(outDir, { recursive: true })
  o.onProgress?.(0, 1, '提取音频')
  const wav = path.join(outDir, 'mix_44k.wav')
  const r = await run(ffmpegPath(o.engineRoot), ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', wav])
  if (r.code !== 0) throw new Error(`提取音频失败: ${r.stderr.slice(-600)}`)

  const python = path.join(o.engineRoot, 'runtime', 'python.exe')
  const script = path.join(o.pythonDir, 'separate.py')
  const args = [
    '-I', '-u', '-X', 'utf8', script,
    '--input', wav, '--model', modelFile(o.engineRoot, m), '--out', outDir,
    '--n-fft', String(m.nFft), '--dim-f', String(m.dimF), '--dim-t', String(m.dimT),
    '--compensate', String(m.compensate), '--primary', m.primary,
    '--device', o.device === 'cpu' ? 'cpu' : 'cuda'
  ]
  fs.mkdirSync(o.logsDir, { recursive: true })
  const log = fs.createWriteStream(path.join(o.logsDir, 'separate.log'), { flags: 'a' })
  log.write(`[${new Date().toISOString()}] ${src} model=${m.id}\n`)
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(python, args, {
        cwd: o.engineRoot,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          PATH: `${path.join(o.engineRoot, 'runtime')};${process.env.PATH || ''}`
        }
      })
      activeProc = proc
      let err = ''
      let stderrTail = ''
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (c: string) => {
        log.write(c)
        stderrTail = (stderrTail + c).slice(-800)
      })
      proc.stdout.setEncoding('utf8')
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        try {
          const ev = JSON.parse(line)
          if (ev.type === 'progress') o.onProgress?.(ev.current, ev.total, '分离人声')
          else if (ev.type === 'error') {
            err = ev.message
            log.write(`${ev.traceback || ev.message}\n`)
          } else if (ev.type === 'log') log.write(`${ev.line}\n`)
        } catch {
          log.write(`${line}\n`)
        }
      })
      proc.on('error', reject)
      proc.on('exit', (code) => {
        activeProc = null
        if (code === 0) resolve()
        else reject(new Error(err ? `人声分离失败: ${err}` : `人声分离已取消或异常退出 (code ${code}) ${stderrTail}`))
      })
    })
  } finally {
    log.end()
    try {
      fs.rmSync(wav)
    } catch {
      // ignore
    }
  }
  return { vocals, instrumental, model: m.id, sourcePath: src, cached: false }
}
