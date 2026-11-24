/** Bilingual subtitles: ASS generation, SRT/VTT parsing, sentence alignment, hard/soft muxing (ffmpeg + libass). */
import fs from 'node:fs'
import path from 'node:path'
import { ffmpegPath, ffprobePath, run } from './media'

export interface BiCue {
  start: number
  end: number
  /** Main line (translation), large, bottom. */
  primary: string
  /** Optional second line (original), small. */
  secondary?: string
}

export interface SubStyle {
  font?: string
  primarySize?: number
  secondarySize?: number
  /** 'stack' = both at the bottom (translation above, original below); 'split' = original at the top of the screen. */
  layout?: 'stack' | 'split'
  /** Put the original above the translation instead of below it. */
  secondaryOnTop?: boolean
  marginV?: number
  /** Video height in pixels; sizes are relative to it (default 1080). */
  playResY?: number
  playResX?: number
}

/** Frame size of a video (for sizing subtitles relative to the real resolution). */
async function probeSize(engineRoot: string, video: string): Promise<{ width: number; height: number }> {
  const r = await run(ffprobePath(engineRoot), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', video])
  const m = /^(\d+)x(\d+)/.exec((r.stdout || '').trim())
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1920, height: 1080 }
}

/** Write an ASS file sized for `video`. */
export async function writeAss(engineRoot: string, video: string, cues: BiCue[], target: string, style: SubStyle = {}): Promise<string> {
  const size = await probeSize(engineRoot, video)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, buildAss(cues, { ...style, playResX: size.width, playResY: size.height }), 'utf-8')
  return target
}

const BREAK = /[，,、；;：:。！？!?…—\s]/

function weight(text: string): number {
  let w = 0
  for (const ch of text) w += /[\u0000-\u00ff]/.test(ch) ? 0.5 : 1
  return w
}

/** Cut one long line into readable cues at punctuation, keeping the reading order. */
function chunk(text: string, maxChars: number): string[] {
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
      if (BREAK.test(chars[i]) && acc >= maxChars * 0.4) soft = i + 1
    }
    const cut = soft > 0 ? soft : Math.max(1, hard)
    parts.push(chars.slice(0, cut).join('').trim())
    rest = chars
      .slice(cut)
      .join('')
      .replace(/^[，,、；;：:。.！!？?…—\s]+/u, '')
      .trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}

/**
 * Cut indices for `text` at the given cumulative weight fractions, snapped to word
 * boundaries for latin text, so slices never lose or duplicate a word.
 */
function sliceByFractions(text: string, fractions: number[]): string[] {
  const chars = [...text]
  const w = chars.map((ch) => (/[\u0000-\u00ff]/.test(ch) ? 0.5 : 1))
  const total = w.reduce((a, b) => a + b, 0)
  if (!total) return fractions.slice(0, -1).map(() => '')
  const cum: number[] = []
  let acc = 0
  for (const x of w) {
    acc += x
    cum.push(acc)
  }
  const at = (f: number): number => {
    if (f <= 0) return 0
    if (f >= 1) return chars.length
    const target = total * f
    const i = cum.findIndex((c) => c >= target)
    return i < 0 ? chars.length : i + 1
  }
  let cuts = fractions.map((f, i) => (i === 0 ? 0 : i === fractions.length - 1 ? chars.length : at(f)))
  const latin = w.every((x) => x === 0.5)
  if (latin) {
    cuts = cuts.map((c, i) => {
      if (i === 0 || i === cuts.length - 1) return c
      let left = c
      let right = c
      for (let k = 0; k < 12 && left > 0; k++, left--) if (chars[left - 1] === ' ') break
      for (let k = 0; k < 12 && right < chars.length; k++, right++) {
        if (chars[right] === ' ') {
          right++
          break
        }
      }
      return Math.abs(c - left) <= Math.abs(right - c) ? left : right
    })
    for (let i = 1; i < cuts.length; i++) if (cuts[i] <= cuts[i - 1]) cuts[i] = Math.min(chars.length, cuts[i - 1] + 1)
  }
  const out: string[] = []
  for (let i = 0; i + 1 < cuts.length; i++) out.push(chars.slice(cuts[i], cuts[i + 1]).join('').trim())
  return out
}

/**
 * Split long cues so nothing stays on screen for a whole paragraph.
 * Both languages are cut over the same fractions, so every cue carries the matching
 * slice of the original line and the two stay in sync.
 */
export function splitLongCues(cues: BiCue[], maxChars = 18): BiCue[] {
  const out: BiCue[] = []
  for (const c of cues) {
    const span = c.end - c.start
    const primary = c.primary?.trim() || ''
    const secondary = c.secondary?.trim() || ''
    const parts = chunk(primary, maxChars)
    if (parts.length <= 1 || span <= 0) {
      out.push({ start: c.start, end: c.end, primary, secondary: secondary || undefined })
      continue
    }
    const total = parts.reduce((a, p) => a + weight(p), 0)
    const fractions: number[] = [0]
    let acc = 0
    for (const p of parts) {
      acc += weight(p)
      fractions.push(acc / total)
    }
    const secParts = secondary ? sliceByFractions(secondary, fractions) : []
    parts.forEach((p, i) => {
      out.push({
        start: c.start + span * fractions[i],
        end: c.start + span * fractions[i + 1],
        primary: p,
        secondary: secParts[i]?.trim() || undefined
      })
    })
  }
  return out
}

function ts(t: number): string {
  const cs = Math.max(0, Math.round(t * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

function assText(s: string): string {
  return s.replace(/[{}]/g, '').replace(/\r?\n/g, '\\N').trim()
}

export function buildAss(cues: BiCue[], style: SubStyle = {}): string {
  const font = style.font || 'Microsoft YaHei'
  const resY = style.playResY || 1080
  const resX = style.playResX || Math.round((resY * 16) / 9)
  // Sizes scale with the frame so 360p previews and 1080p exports look the same.
  const p = style.primarySize || Math.round(resY * 0.052)
  const p2 = style.secondarySize || Math.round(resY * 0.035)
  const mv = style.marginV ?? Math.round(resY * 0.043)
  const split = style.layout === 'split'
  const secondaryOnTop = style.secondaryOnTop === true
  // stack (default): translation above, original below, both bottom-aligned.
  // stack + secondaryOnTop: the old order (original above, translation below).
  // split: original at the top of the frame, translation at the bottom.
  const priMV = split || secondaryOnTop ? mv : mv + Math.round(p2 * 1.5)
  const secMV = split ? mv : secondaryOnTop ? mv + Math.round(p * 1.5) : mv
  const secAlign = split ? 8 : 2
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${resX}`,
    `PlayResY: ${resY}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Primary,${font},${p},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,${priMV},1`,
    `Style: Secondary,${font},${p2},&H00D8D8D8,&H00D8D8D8,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2.4,1,${secAlign},60,60,${secMV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]
  const ev: string[] = []
  for (const c of cues) {
    if (!(c.end > c.start)) continue
    if (c.primary?.trim()) ev.push(`Dialogue: 0,${ts(c.start)},${ts(c.end)},Primary,,0,0,0,,${assText(c.primary)}`)
    if (c.secondary?.trim()) ev.push(`Dialogue: 0,${ts(c.start)},${ts(c.end)},Secondary,,0,0,0,,${assText(c.secondary)}`)
  }
  return '\ufeff' + [...head, ...ev].join('\r\n') + '\r\n'
}

function srtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}

/** Bilingual SRT: primary line then secondary line in one cue. */
export function buildBilingualSrt(cues: BiCue[]): string {
  return cues
    .filter((c) => c.end > c.start)
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${[c.primary, c.secondary].filter((x) => x && x.trim()).join('\n')}\n`)
    .join('\n')
}

function parseTime(s: string): number {
  const m = s.trim().replace(',', '.').match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return NaN
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/** Parse SRT / VTT into [{start,end,text}]. Tags stripped; YouTube rolling duplicates merged. */
export function parseSubtitleFile(file: string): { start: number; end: number; text: string }[] {
  const raw = fs.readFileSync(file, 'utf-8').replace(/^\ufeff/, '').replace(/\r/g, '')
  const out: { start: number; end: number; text: string }[] = []
  for (const block of raw.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim())
    const ti = lines.findIndex((l) => l.includes('-->'))
    if (ti < 0) continue
    const [a, b] = lines[ti].split('-->')
    const start = parseTime(a)
    const end = parseTime((b || '').trim().split(/\s+/)[0] || '')
    const text = lines
      .slice(ti + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) continue
    const prev = out[out.length - 1]
    if (prev && prev.text === text) prev.end = end
    else out.push({ start, end, text })
  }
  return out
}

function filterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/**
 * Put subtitles on a video. hard = burn with libass (re-encode: h264_nvenc, fallback libx264/mpeg4);
 * soft = add a subtitle track (mkv: ass, mp4: mov_text), no re-encode.
 */
export async function burnSubtitles(
  engineRoot: string,
  video: string,
  cues: BiCue[],
  outputPath: string,
  mode: 'hard' | 'soft' = 'hard',
  style: SubStyle = {}
): Promise<{ outputPath: string; assPath: string; encoder: string }> {
  if (!fs.existsSync(video)) throw new Error(`视频不存在: ${video}`)
  if (!cues.length) throw new Error('没有字幕内容')
  if (path.resolve(video) === path.resolve(outputPath)) throw new Error('outputPath 不能与输入视频相同')
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const assPath = outputPath.replace(/\.[^.\\/]+$/, '') + '.ass'
  const size = await probeSize(engineRoot, video)
  fs.writeFileSync(assPath, buildAss(cues, { ...style, playResX: size.width, playResY: size.height }), 'utf-8')
  const bitrate = size.height >= 1080 ? '12M' : size.height >= 720 ? '6M' : '3M'
  const ffmpeg = ffmpegPath(engineRoot)
  const base = ['-y', '-hide_banner', '-loglevel', 'error']

  if (mode === 'soft') {
    const mkv = /\.mkv$/i.test(outputPath)
    const r = await run(ffmpeg, [...base, '-i', video, '-i', assPath, '-map', '0:v?', '-map', '0:a?', '-map', '1:0', '-c:v', 'copy', '-c:a', 'copy', '-c:s', mkv ? 'ass' : 'mov_text', outputPath])
    if (r.code !== 0) throw new Error(`封装字幕失败: ${r.stderr.slice(-600)}`)
    return { outputPath, assPath, encoder: 'copy' }
  }

  const vf = `subtitles='${filterPath(assPath)}'`
  // The bundled ffmpeg's NVENC is too old for current drivers ("unsupported param"), and it has no
  // libx264, so MediaFoundation H.264 is the working GPU/OS encoder; mpeg4 is the last resort.
  const tries: [string, string[]][] = [
    ['h264_mf', ['-c:v', 'h264_mf', '-b:v', bitrate]],
    ['libx264', ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20']],
    ['mpeg4', ['-c:v', 'mpeg4', '-q:v', '2']]
  ]
  let last = ''
  for (const [name, enc] of tries) {
    const r = await run(ffmpeg, [...base, '-i', video, '-vf', vf, '-map', '0:v', '-map', '0:a?', ...enc, '-pix_fmt', 'yuv420p', '-c:a', 'copy', outputPath])
    if (r.code === 0) return { outputPath, assPath, encoder: name }
    last = r.stderr.slice(-600)
  }
  throw new Error(`烧录字幕失败: ${last}`)
}

// ------------------------------------------------------------ sentence alignment

interface CharT {
  ch: string
  t0: number
  t1: number
  item: number
}

const PUNCT = /[\s\p{P}\p{S}]/u

function norm(s: string): string {
  return Array.from(s.toLowerCase())
    .filter((c) => !PUNCT.test(c))
    .join('')
}

/** Per-character timeline; times inside an item are estimated proportionally by character count. */
function charTimeline(items: { start: number; end: number; text: string }[]): CharT[] {
  const out: CharT[] = []
  items.forEach((it, idx) => {
    const chars = Array.from(norm(it.text || ''))
    if (!chars.length) return
    const d = Math.max(0.01, it.end - it.start) / chars.length
    chars.forEach((ch, k) => out.push({ ch, t0: it.start + k * d, t1: it.start + (k + 1) * d, item: idx }))
  })
  return out
}

export interface ScriptLine {
  id: string
  start: number
  end: number
  text: string
  speaker?: string
  items: number[]
  /** false = fuzzy match; check this line. */
  matched: boolean
}

/**
 * Align AI-segmented sentences (verbatim, in order) back to transcript time.
 * Punctuation / case / spaces are ignored when matching.
 */
export function alignSentences(
  items: { start: number; end: number; text: string; speaker?: string }[],
  sentences: { text: string; speaker?: string }[],
  idPrefix = 'l'
): { lines: ScriptLine[]; unmatched: number[]; leftover: string } {
  const tl = charTimeline(items)
  const flat = tl.map((c) => c.ch).join('')
  let cursor = 0
  const lines: ScriptLine[] = []
  const unmatched = new Set<number>()
  sentences.forEach((s, i) => {
    const key = norm(s.text || '')
    if (!key || cursor >= tl.length) {
      if (key) unmatched.add(i)
      return
    }
    let at = flat.indexOf(key, cursor)
    let len = key.length
    let matched = true
    if (at < 0 || at - cursor > Math.max(40, key.length * 2)) {
      // Transcripts carry ASR errors ("patta pixel" vs "PetaPixel"), so sentences the agent cleaned up
      // will not match exactly. Try head+tail anchoring before giving up.
      const headKey = key.slice(0, Math.min(4, key.length))
      const tailKey = key.slice(-Math.min(4, key.length))
      const head = flat.indexOf(headKey, cursor)
      const tail = head >= 0 ? flat.indexOf(tailKey, head + Math.max(0, key.length - 12)) : -1
      if (head >= 0 && head - cursor <= Math.max(40, key.length * 2) && tail >= 0 && tail - head < key.length * 2) {
        at = head
        len = tail + tailKey.length - head
      } else {
        // Give up on this one but do NOT advance the cursor: a wrong guess would swallow
        // the sentences after it. Times are filled in from the neighbours below.
        matched = false
        unmatched.add(i)
        const here = tl[Math.min(tl.length - 1, cursor)]
        lines.push({
          id: `${idPrefix}${String(lines.length + 1).padStart(3, '0')}`,
          start: here.t0,
          end: here.t0,
          text: s.text.trim(),
          speaker: s.speaker,
          items: [here.item],
          matched: false
        })
        return
      }
    }
    const a = tl[at]
    const b = tl[Math.min(tl.length - 1, at + len - 1)]
    const its = [...new Set(tl.slice(at, at + len).map((c) => c.item))]
    const votes: Record<string, number> = {}
    for (const c of tl.slice(at, at + len)) {
      const sp = items[c.item]?.speaker
      if (sp) votes[sp] = (votes[sp] || 0) + 1
    }
    lines.push({
      id: `${idPrefix}${String(lines.length + 1).padStart(3, '0')}`,
      start: Math.round(a.t0 * 1000) / 1000,
      end: Math.round(b.t1 * 1000) / 1000,
      text: s.text.trim(),
      speaker: s.speaker || Object.entries(votes).sort((x, y) => y[1] - x[1])[0]?.[0],
      items: its,
      matched
    })
    cursor = at + len
  })
  // Unmatched sentences got a placeholder time; spread each run of them over the gap between neighbours.
  const total = tl.length ? tl[tl.length - 1].t1 : 0
  for (let i = 0; i < lines.length; ) {
    if (lines[i].matched) {
      i++
      continue
    }
    let j = i
    while (j + 1 < lines.length && !lines[j + 1].matched) j++
    const from = i > 0 ? lines[i - 1].end : 0
    const to = j + 1 < lines.length ? lines[j + 1].start : total
    const n = j - i + 1
    const span = Math.max(0.2 * n, to - from)
    for (let k = 0; k < n; k++) {
      lines[i + k].start = Math.round((from + (span * k) / n) * 1000) / 1000
      lines[i + k].end = Math.round((from + (span * (k + 1)) / n) * 1000) / 1000
    }
    i = j + 1
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].start < lines[i - 1].end) {
      const mid = Math.round(((lines[i].start + lines[i - 1].end) / 2) * 1000) / 1000
      lines[i - 1].end = mid
      lines[i].start = mid
    }
  }
  return { lines, unmatched: [...unmatched], leftover: flat.slice(cursor, cursor + 80) }
}
