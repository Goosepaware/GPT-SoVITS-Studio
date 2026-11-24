/** Dubbing helpers: audio extraction, clip cutting, tempo fitting and final mixing (ffmpeg). */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ffmpegPath, getDuration, run } from './media'

async function ff(engineRoot: string, args: string[], what: string): Promise<void> {
  const r = await run(ffmpegPath(engineRoot), ['-y', '-hide_banner', '-loglevel', 'error', ...args])
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
  bgm: 'keep' | 'duck' | 'remove' = 'duck'
): Promise<string> {
  if (!fs.existsSync(base)) throw new Error(`原始文件不存在: ${base}`)
  if (!items.length) throw new Error('没有配音片段')
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const total = await getDuration(engineRoot, base)
  const inputs: string[] = ['-i', base]
  const filters: string[] = []
  items.forEach((it, i) => {
    inputs.push('-i', it.audioPath)
    const ms = Math.max(0, Math.round(it.start * 1000))
    filters.push(`[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${(it.gain ?? 1).toFixed(3)},adelay=${ms}|${ms}[d${i}]`)
  })
  const dubs = items.map((_, i) => `[d${i}]`).join('')
  // Older bundled ffmpeg has no `normalize` option on amix, so compensate the
  // 1/N attenuation it applies with a matching volume boost.
  filters.push(
    `${dubs}amix=inputs=${items.length}:dropout_transition=0,volume=${items.length},apad,atrim=0:${total.toFixed(3)}[dub]`
  )
  if (bgm === 'remove') {
    filters.push('[dub]anull[out]')
  } else {
    filters.push('[0:a]aresample=48000,aformat=channel_layouts=stereo[orig]')
    if (bgm === 'duck') {
      filters.push('[dub]asplit=2[dub1][sc]')
      filters.push('[orig][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=300[ducked]')
      filters.push('[ducked][dub1]amix=inputs=2:dropout_transition=0,volume=2[out]')
    } else {
      filters.push('[orig][dub]amix=inputs=2:dropout_transition=0,volume=2[out]')
    }
  }
  const isVideo = /\.(mp4|mkv|mov|webm)$/i.test(outputPath)
  const tail = isVideo ? ['-map', '0:v?', '-map', '[out]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest'] : ['-map', '[out]', '-c:a', 'pcm_s16le']
  await ff(engineRoot, [...inputs, '-filter_complex', filters.join(';'), ...tail, outputPath], '混音')
  return outputPath
}
