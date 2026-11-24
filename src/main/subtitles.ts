import fs from 'node:fs'
import path from 'node:path'

export type SubtitleFormat = 'srt' | 'ass' | 'lrc'

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

interface TimingFile {
  version: number
  duration: number
  segments: TimingSegment[]
}

export interface Cue {
  start: number
  end: number
  text: string
}

export interface SubtitleOptions {
  maxChars: number // per cue, CJK-weighted
  minChars: number // merge shorter neighbours
  minDuration: number // seconds
  stripTrailingPunct: boolean
  offsetMs: number
}

export const DEFAULT_SUBTITLE_OPTIONS: SubtitleOptions = {
  maxChars: 18,
  minChars: 4,
  minDuration: 0.8,
  stripTrailingPunct: true,
  offsetMs: 0
}

const BREAK_PUNCT = /[，,、；;：:。！？!?…—\s]/
const TRAILING_PUNCT = /[，,、；;：:。.！!？?…\s]+$/u

export function timingPathFor(audioPath: string): string {
  return audioPath.replace(/\.[^.\\/]+$/, '') + '.timing.json'
}

export function hasTiming(audioPath: string): boolean {
  return fs.existsSync(timingPathFor(audioPath))
}

function readTiming(audioPath: string): TimingFile {
  const p = timingPathFor(audioPath)
  if (!fs.existsSync(p)) throw new Error('这条记录没有时间轴（旧版本生成），请重新生成后再导出字幕')
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as TimingFile
}

function weight(text: string): number {
  let w = 0
  for (const ch of text) w += /[\u0000-\u00ff]/.test(ch) ? 0.5 : 1
  return w
}

/** Split long text into chunks <= maxChars, preferring punctuation boundaries. */
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
    // A cut right after punctuation leaves it orphaned at the head of the next line.
    rest = chars
      .slice(cut)
      .join('')
      .replace(/^[，,、；;：:。.！!？?…—\s]+/u, '')
      .trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}

/** Move a proportional cut point to the nearest detected breath pause, if close. */
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

export function buildCues(timing: TimingFile, opts: SubtitleOptions): Cue[] {
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

  // Merge too-short neighbours that sit close together.
  const short = (c: Cue): boolean => weight(c.text) < opts.minChars || c.end - c.start < opts.minDuration
  const merged: Cue[] = []
  for (const cue of raw) {
    const last = merged[merged.length - 1]
    if (
      last &&
      (short(cue) || short(last)) &&
      cue.start - last.end < 0.5 &&
      weight(last.text) + weight(cue.text) <= opts.maxChars
    ) {
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

function srtTime(t: number): string {
  const ms = Math.round(t * 1000)
  return `${pad(ms / 3600000)}:${pad((ms / 60000) % 60)}:${pad((ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}

function assTime(t: number): string {
  const cs = Math.round(t * 100)
  return `${Math.floor(cs / 360000)}:${pad((cs / 6000) % 60)}:${pad((cs / 100) % 60)}.${pad(cs % 100)}`
}

function lrcTime(t: number): string {
  const cs = Math.round(t * 100)
  return `[${pad(cs / 6000)}:${pad((cs / 100) % 60)}.${pad(cs % 100)}]`
}

export function formatCues(cues: Cue[], format: SubtitleFormat): string {
  if (format === 'srt') {
    return cues.map((c, i) => `${i + 1}\r\n${srtTime(c.start)} --> ${srtTime(c.end)}\r\n${c.text}\r\n`).join('\r\n')
  }
  if (format === 'lrc') {
    return cues.map((c) => `${lrcTime(c.start)}${c.text}`).join('\r\n') + '\r\n'
  }
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1920',
    'PlayResY: 1080',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Microsoft YaHei,64,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,3,0,2,60,60,60,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]
  const lines = cues.map(
    (c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${c.text.replace(/\r?\n/g, '\\N')}`
  )
  return [...header, ...lines].join('\r\n') + '\r\n'
}

/** Build subtitle text for one generated audio file. */
export function subtitleFor(audioPath: string, format: SubtitleFormat, opts: Partial<SubtitleOptions> = {}): string {
  const cues = buildCues(readTiming(audioPath), { ...DEFAULT_SUBTITLE_OPTIONS, ...opts })
  // BOM keeps Chinese readable in editors that sniff encoding (Premiere, older Aegisub).
  return '\ufeff' + formatCues(cues, format)
}

export function writeSubtitle(
  audioPath: string,
  targetPath: string,
  format: SubtitleFormat,
  opts?: Partial<SubtitleOptions>
): string {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.writeFileSync(targetPath, subtitleFor(audioPath, format, opts), 'utf-8')
  return targetPath
}
