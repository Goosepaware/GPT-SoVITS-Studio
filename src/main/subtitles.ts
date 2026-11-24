import fs from 'node:fs'
import path from 'node:path'
import type { SubtitleConfig, SubtitleFormat } from '@shared/types'

export type { SubtitleFormat }

export function defaultSubtitleConfig(): SubtitleConfig {
  return {
    autoExport: false,
    autoFormats: ['srt'],
    defaultFormat: 'srt',
    maxChars: 18,
    minChars: 4,
    minDuration: 0.8,
    stripTrailingPunct: true,
    offsetMs: 0,
    assFont: 'Microsoft YaHei',
    assFontSize: 64
  }
}

interface TimingSegment {
  index: number
  text: string
  start: number
  end: number
  voicedStart: number
  voicedEnd: number
  pauses?: number[]
  flags?: string[]
}

export interface TimingFile {
  version: number
  duration: number
  sampleRate?: number
  seed?: number
  segments: TimingSegment[]
}

export interface Cue {
  start: number
  end: number
  text: string
}

const BREAK_PUNCT = /[，,、；;：:。！？!?…—\s]/
const TRAILING_PUNCT = /[，,、；;：:。.！!？?…\s]+$/u

export const SUBTITLE_EXT: Record<SubtitleFormat, string> = {
  srt: 'srt',
  ass: 'ass',
  vtt: 'vtt',
  lrc: 'lrc',
  txt: 'txt',
  json: 'timing.json'
}

export function timingPathFor(audioPath: string): string {
  return audioPath.replace(/\.[^.\\/]+$/, '') + '.timing.json'
}

export function hasTiming(audioPath: string): boolean {
  return fs.existsSync(timingPathFor(audioPath))
}

export function readTiming(audioPath: string): TimingFile {
  const p = timingPathFor(audioPath)
  if (!fs.existsSync(p)) throw new Error('这条记录没有时间轴（旧版本生成），请重新生成后再导出字幕')
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as TimingFile
}

/** All sidecar subtitle files that may sit next to an audio file (for cleanup). */
export function sidecarPaths(audioPath: string): string[] {
  const base = audioPath.replace(/\.[^.\\/]+$/, '')
  return [...new Set(Object.values(SUBTITLE_EXT))].map((ext) => `${base}.${ext}`)
}

function weight(text: string): number {
  let w = 0
  for (const ch of text) w += /[\u0000-\u00ff]/.test(ch) ? 0.5 : 1
  return w
}

function chunkText(text: string, maxChars: number): string[] {
  if (weight(text) <= maxChars) return [text]
  const parts: string[] = []
  let rest = text
  while (weight(rest) > maxChars) {
    const chars = [...rest]
    let acc = 0
    let hard = chars.length
    let soft = -1
    for (let i = 0; i < chars.length; i++) {
      acc += weight(chars[i])
      if (acc > maxChars) {
        hard = i
        break
      }
      if (BREAK_PUNCT.test(chars[i]) && acc >= maxChars * 0.4) soft = i + 1
    }
    const cut = soft > 0 ? soft : Math.max(1, hard)
    parts.push(chars.slice(0, cut).join('').trim())
    // A hard cut can leave punctuation orphaned at the head of the next line.
    rest = chars
      .slice(cut)
      .join('')
      .replace(/^[，,、；;：:。.！!？?…—\s]+/u, '')
      .trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}

function snapToPause(t: number, pauses: number[], lo: number, hi: number): number {
  const window = Math.min(0.6, (hi - lo) * 0.25)
  let best = t
  let bestDist = window
  for (const p of pauses) {
    if (p <= lo || p >= hi) continue
    const d = Math.abs(p - t)
    if (d < bestDist) {
      best = p
      bestDist = d
    }
  }
  return best
}

export function buildCues(timing: TimingFile, opts: SubtitleConfig): Cue[] {
  const raw: Cue[] = []
  for (const seg of timing.segments) {
    if (seg.flags?.includes('silent') || !seg.text.trim()) continue
    const s = seg.voicedStart
    const e = Math.max(seg.voicedEnd, s + 0.2)
    const chunks = chunkText(seg.text.trim(), opts.maxChars)
    if (chunks.length === 1) {
      raw.push({ start: s, end: e, text: chunks[0] })
      continue
    }
    const total = chunks.reduce((a, c) => a + weight(c), 0)
    let acc = 0
    let prev = s
    chunks.forEach((c, i) => {
      acc += weight(c)
      let cut = i === chunks.length - 1 ? e : s + ((e - s) * acc) / total
      if (i < chunks.length - 1) cut = snapToPause(cut, seg.pauses || [], prev + 0.2, e - 0.2)
      raw.push({ start: prev, end: cut, text: c })
      prev = cut
    })
  }

  const short = (c: Cue): boolean => weight(c.text) < opts.minChars || c.end - c.start < opts.minDuration
  const merged: Cue[] = []
  for (const cue of raw) {
    const last = merged[merged.length - 1]
    if (last && (short(cue) || short(last)) && cue.start - last.end < 0.5 && weight(last.text) + weight(cue.text) <= opts.maxChars) {
      last.text = `${last.text}${/[A-Za-z0-9]$/.test(last.text) ? ' ' : ''}${cue.text}`
      last.end = cue.end
    } else {
      merged.push({ ...cue })
    }
  }

  const off = opts.offsetMs / 1000
  return merged.map((c) => ({
    start: Math.max(0, c.start + off),
    end: Math.max(0, c.end + off),
    text: opts.stripTrailingPunct ? c.text.replace(TRAILING_PUNCT, '') || c.text : c.text
  }))
}

function pad(n: number, w = 2): string {
  return String(Math.floor(n)).padStart(w, '0')
}

function clock(t: number, msSep: string): string {
  const ms = Math.round(t * 1000)
  return `${pad(ms / 3600000)}:${pad((ms / 60000) % 60)}:${pad((ms / 1000) % 60)}${msSep}${pad(ms % 1000, 3)}`
}

function assTime(t: number): string {
  const cs = Math.round(t * 100)
  return `${Math.floor(cs / 360000)}:${pad((cs / 6000) % 60)}:${pad((cs / 100) % 60)}.${pad(cs % 100)}`
}

function lrcTime(t: number): string {
  const cs = Math.round(t * 100)
  return `[${pad(cs / 6000)}:${pad((cs / 100) % 60)}.${pad(cs % 100)}]`
}

export function formatCues(cues: Cue[], format: Exclude<SubtitleFormat, 'json'>, opts: SubtitleConfig): string {
  const NL = '\r\n'
  switch (format) {
    case 'srt':
      return cues.map((c, i) => `${i + 1}${NL}${clock(c.start, ',')} --> ${clock(c.end, ',')}${NL}${c.text}${NL}`).join(NL)
    case 'vtt':
      return 'WEBVTT' + NL + NL + cues.map((c, i) => `${i + 1}${NL}${clock(c.start, '.')} --> ${clock(c.end, '.')}${NL}${c.text}${NL}`).join(NL)
    case 'lrc':
      return cues.map((c) => `${lrcTime(c.start)}${c.text}`).join(NL) + NL
    case 'txt':
      return cues.map((c) => c.text).join(NL) + NL
    case 'ass': {
      const header = [
        '[Script Info]',
        'ScriptType: v4.00+',
        'PlayResX: 1920',
        'PlayResY: 1080',
        'WrapStyle: 0',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        `Style: Default,${opts.assFont.replace(/,/g, ' ')},${opts.assFontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,3,0,2,60,60,60,1`,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
      ]
      const lines = cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${c.text.replace(/\r?\n/g, '\\N')}`)
      return [...header, ...lines].join(NL) + NL
    }
  }
}

export function subtitleFileName(audioPath: string, format: SubtitleFormat): string {
  return `${path.basename(audioPath).replace(/\.[^.]+$/, '')}.${SUBTITLE_EXT[format]}`
}

/** Subtitle text for one audio file (for previews/tests). */
export function subtitleFor(audioPath: string, format: SubtitleFormat, opts?: Partial<SubtitleConfig>): string {
  const timing = readTiming(audioPath)
  const cfg = { ...defaultSubtitleConfig(), ...(opts || {}) }
  if (format === 'json') return JSON.stringify(timing, null, 1)
  return '\ufeff' + formatCues(buildCues(timing, cfg), format, cfg)
}

/** Write one subtitle file. Returns the written path. */
export function writeSubtitle(audioPath: string, targetPath: string, format: SubtitleFormat, opts?: Partial<SubtitleConfig>): string {
  const timing = readTiming(audioPath)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  if (format === 'json') {
    if (path.resolve(targetPath) !== path.resolve(timingPathFor(audioPath))) {
      fs.writeFileSync(targetPath, JSON.stringify(timing, null, 1), 'utf-8')
    }
    return targetPath
  }
  const cfg = { ...defaultSubtitleConfig(), ...(opts || {}) }
  const body = formatCues(buildCues(timing, cfg), format, cfg)
  // BOM keeps Chinese readable in editors that sniff encoding (Premiere, older Aegisub).
  fs.writeFileSync(targetPath, '\ufeff' + body, 'utf-8')
  return targetPath
}

/** Write several formats into a directory (default: next to the audio). */
export function writeSubtitles(audioPath: string, formats: SubtitleFormat[], opts?: Partial<SubtitleConfig>, dir?: string): string[] {
  const outDir = dir || path.dirname(audioPath)
  return [...new Set(formats)].map((f) => writeSubtitle(audioPath, path.join(outDir, subtitleFileName(audioPath, f)), f, opts))
}
