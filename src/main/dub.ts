/** Dubbing helpers: audio extraction, clip cutting, tempo fitting and final mixing (ffmpeg). */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ffmpegPath, getDuration, run } from './media'
import { readWav, writeWav } from './segmentEdit'

async function ff(engineRoot: string, args: string[], what: string): Promise<void> {
  const bin = ffmpegPath(engineRoot)
  const r = await run(bin, ['-y', '-hide_banner', '-loglevel', 'error', ...args], 20 * 60 * 1000)
  if (r.code !== 0) throw new Error(`${what}失败: ${r.stderr.slice(-600)}`)
}

/** Video/audio -> 16 kHz mono PCM wav (for ASR / diarization). Cached by path+mtime+range. */
export async function extractAudio(engineRoot: string, src: string, tempDir: string, start?: number, end?: number, sampleRate = 16000): Promise<string> {
  if (!fs.existsSync(src)) throw new Error(`文件不存在: ${src}`)
  const st = fs.statSync(src)
  const key = crypto.createHash('sha1').update(`${src}:${st.size}:${st.mtimeMs}:${start}:${end}:${sampleRate}`).digest('hex').slice(0, 12)
  const dir = path.join(tempDir, 'extract')
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, `${key}.wav`)
  if (fs.existsSync(out)) return out
  const range: string[] = []
  if (start !== undefined && start > 0) range.push('-ss', String(start))
  if (end !== undefined && end > 0) range.push('-to', String(end))
  await ff(engineRoot, [...range, '-i', src, '-vn', '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', out], '提取音频')
  return out
}

/** Cut [start,end) from a source at 48 kHz mono for use as reference audio. */
export async function cutClip(engineRoot: string, src: string, start: number, end: number, out: string): Promise<string> {
  fs.mkdirSync(path.dirname(out), { recursive: true })
  await ff(engineRoot, ['-ss', String(start), '-to', String(end), '-i', src, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', out], '截取片段')
  return out
}

/** Time-stretch with atempo (pitch preserved). factor > 1 = faster/shorter. */
export async function atempo(engineRoot: string, src: string, factor: number, out: string): Promise<string> {
  await ff(engineRoot, ['-i', src, '-filter:a', `atempo=${factor.toFixed(4)}`, '-c:a', 'pcm_s16le', out], '变速')
  return out
}

export interface FitLine {
  index: number
  target: number
  first: number
  actual: number
  speed: number
  tempo: number
  method: 'none' | 'speed' | 'speed+atempo' | 'overflow'
}

/**
 * Fit one synthesized line into a time window. `synth(speed)` regenerates the line and returns its wav path + duration.
 * Order: default speed -> speed 0.85–1.15 -> atempo ±10% -> overflow.
 */
export async function fitLine(
  engineRoot: string,
  index: number,
  target: number,
  baseSpeed: number,
  synth: (speed: number) => Promise<{ filePath: string; duration: number }>
): Promise<{ filePath: string; report: FitLine }> {
  let r = await synth(baseSpeed)
  const first = r.duration
  const report: FitLine = { index, target, first, actual: first, speed: baseSpeed, tempo: 1, method: 'none' }
  if (target <= 0 || r.duration <= target * 1.02) return { filePath: r.filePath, report }
  const need = r.duration / target
  const speed = Math.min(1.15, Math.max(0.85, baseSpeed * need))
  if (speed > baseSpeed + 0.01) {
    r = await synth(speed)
    report.speed = speed
    report.method = 'speed'
    report.actual = r.duration
  }
  if (r.duration > target * 1.02) {
    const tempo = Math.min(1.1, r.duration / target)
    const out = r.filePath.replace(/\.wav$/i, '') + '.fit.wav'
    await atempo(engineRoot, r.filePath, tempo, out)
    report.tempo = Math.round(tempo * 1000) / 1000
    report.actual = await getDuration(engineRoot, out)
    report.method = report.actual > target * 1.02 ? 'overflow' : 'speed+atempo'
    return { filePath: out, report }
  }
  return { filePath: r.filePath, report }
}

export interface MixItem {
  audioPath: string
  start: number
  gain?: number
}

/**
 * Place dub lines on the timeline of a video/audio and mix.
 * bgm: keep = original + dub, duck = original lowered under dub (sidechain), remove = dub only.
 * Video input with outputPath ending .mp4/.mkv copies the video stream.
 */
export async function mixDub(
  engineRoot: string,
  base: string,
  items: MixItem[],
  outputPath: string,
  bgm: 'keep' | 'duck' | 'remove' | 'replace' = 'duck',
  /** For bgm 'replace': separated instrumental used as the bed under the dub. */
  bedPath?: string
): Promise<string> {
  if (!fs.existsSync(base)) throw new Error(`原始文件不存在: ${base}`)
  if (!items.length) throw new Error('没有配音片段')
  if (bgm === 'replace' && (!bedPath || !fs.existsSync(bedPath))) throw new Error('bgm=replace 需要伴奏文件 bedPath（先做人声分离）')
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const total = await getDuration(engineRoot, base)
  if (total <= 0) throw new Error('无法读取原始文件时长')
  const rate = 48000
  const frames = Math.max(1, Math.round(total * rate))

  // ffmpeg is only used for decoding to PCM16 48k stereo; the mix itself is done on samples.
  const tempDir = path.join(path.dirname(outputPath), '.mix-tmp')
  fs.mkdirSync(tempDir, { recursive: true })
  const decode = async (src: string, name: string): Promise<Float32Array> => {
    const out = path.join(tempDir, `${name}.wav`)
    await ff(engineRoot, ['-i', src, '-vn', '-ac', '2', '-ar', String(rate), '-c:a', 'pcm_s16le', out], '解码音频')
    return toStereo(readWav(out))
  }

  const dub = new Float32Array(frames * 2)
  const active = new Uint8Array(frames)
  // Lines never overlap: a clip is cut (with a 30 ms fade) where the next line starts.
  const ordered = [...items].sort((x, y) => x.start - y.start)
  const fade = Math.round(0.03 * rate) * 2
  for (let k = 0; k < ordered.length; k++) {
    const it = ordered[k]
    const src = await decode(it.audioPath, `item-${path.basename(it.audioPath, path.extname(it.audioPath))}`)
    const gain = it.gain ?? 1
    const offset = Math.max(0, Math.round(it.start * rate)) * 2
    const nextStart = k + 1 < ordered.length ? ordered[k + 1].start : total
    const room = Math.max(0, Math.round((nextStart - it.start) * rate)) * 2
    const usable = Math.min(src.length, room, dub.length - offset)
    for (let i = 0; i < usable; i++) {
      const at = offset + i
      const tail = usable < src.length && i > usable - fade ? (usable - i) / fade : 1
      dub[at] += src[i] * gain * tail
      if ((i & 1) === 0 && Math.abs(src[i]) > 0.01) active[at >> 1] = 1
    }
  }

  const bed = bgm === 'replace' ? await decode(bedPath as string, 'bed') : bgm === 'remove' ? new Float32Array(frames * 2) : await decode(base, 'base')
  const mixed = new Float32Array(frames * 2)
  const envelope = duckEnvelope(active, rate)
  for (let f = 0; f < frames; f++) {
    const g = bgm === 'duck' ? envelope[f] : 1
    mixed[f * 2] = bed[f * 2] * g + dub[f * 2]
    mixed[f * 2 + 1] = bed[f * 2 + 1] * g + dub[f * 2 + 1]
  }
  let peak = 0
  for (let i = 0; i < mixed.length; i++) peak = Math.max(peak, Math.abs(mixed[i]))
  const scale = peak > 0.995 ? 0.995 / peak : 1
  const pcm = new Int16Array(mixed.length)
  for (let i = 0; i < mixed.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(mixed[i] * scale * 32767)))

  const mixedPath = path.join(tempDir, 'mix.wav')
  writeWav(mixedPath, { sampleRate: rate, channels: 2, samples: pcm })

  try {
    if (/\.(mp4|mkv|mov|webm)$/i.test(outputPath)) {
      await ff(engineRoot, ['-i', base, '-i', mixedPath, '-map', '0:v?', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', outputPath], '混音')
    } else {
      await ff(engineRoot, ['-i', mixedPath, '-c:a', 'pcm_s16le', outputPath], '混音')
    }
  } finally {
    for (const name of fs.readdirSync(tempDir)) {
      try {
        fs.rmSync(path.join(tempDir, name))
      } catch {
        // ignore
      }
    }
    try {
      fs.rmdirSync(tempDir)
    } catch {
      // ignore
    }
  }
  return outputPath
}

/** Stereo float samples from our PCM16 reader. */
function toStereo(w: { channels: number; samples: Int16Array }): Float32Array {
  const out = new Float32Array((w.samples.length / w.channels) * 2)
  for (let f = 0, n = out.length / 2; f < n; f++) {
    if (w.channels === 1) {
      const v = w.samples[f] / 32768
      out[f * 2] = v
      out[f * 2 + 1] = v
    } else {
      out[f * 2] = w.samples[f * w.channels] / 32768
      out[f * 2 + 1] = w.samples[f * w.channels + 1] / 32768
    }
  }
  return out
}

/** Sidechain-style gain: pull the bed down ~9 dB while a dub line is playing, 20 ms attack / 300 ms release. */
function duckEnvelope(active: Uint8Array, rate: number): Float32Array {
  const out = new Float32Array(active.length)
  const attack = 1 / (0.02 * rate)
  const release = 1 / (0.3 * rate)
  const low = 0.35
  let g = 1
  for (let f = 0; f < active.length; f++) {
    const target = active[f] ? low : 1
    g += (target - g) * (target < g ? attack : release)
    out[f] = g
  }
  return out
}
