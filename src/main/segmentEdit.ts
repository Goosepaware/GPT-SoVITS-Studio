/**
 * Segment re-generation: splice candidate clips into a finished WAV + timing file.
 * Runs in the main process (pure Node, no GPU). Only handles the PCM16 WAVs we write ourselves.
 */
import fs from 'node:fs'
import { timingPathFor } from './subtitles'

export interface WavData {
  sampleRate: number
  channels: number
  samples: Int16Array // interleaved (we always write mono)
}

export function readWav(file: string): WavData {
  const buf = fs.readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`不是 WAV 文件: ${file}`)
  let off = 12
  let sampleRate = 0
  let channels = 1
  let bits = 16
  let format = 1
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body)
      channels = buf.readUInt16LE(body + 2)
      sampleRate = buf.readUInt32LE(body + 4)
      bits = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      if (format !== 1 || bits !== 16) throw new Error('仅支持 PCM16 WAV')
      const end = Math.min(buf.length, body + size)
      const copy = Buffer.from(buf.subarray(body, end - ((end - body) % 2)))
      return { sampleRate, channels, samples: new Int16Array(copy.buffer, copy.byteOffset, copy.length / 2) }
    }
    off = body + size + (size % 2)
  }
  throw new Error('WAV 缺少 data 块')
}

export function writeWav(file: string, wav: WavData): void {
  const dataLen = wav.samples.length * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataLen, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(wav.channels, 22)
  header.writeUInt32LE(wav.sampleRate, 24)
  header.writeUInt32LE(wav.sampleRate * wav.channels * 2, 28)
  header.writeUInt16LE(wav.channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataLen, 40)
  const body = Buffer.from(wav.samples.buffer, wav.samples.byteOffset, dataLen)
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, Buffer.concat([header, body]))
  fs.renameSync(tmp, file)
}

export interface SegParams {
  speed?: number
  topK?: number
  topP?: number
  temperature?: number
  sampleSteps?: number
  repetitionPenalty?: number
}

export interface EditSegment {
  index: number
  text: string
  start: number
  end: number
  voicedStart: number
  voicedEnd: number
  pauses?: number[]
  seed?: number
  retries?: number
  flags?: string[]
  params?: SegParams | null
  edited?: boolean
}

export interface TimingSource {
  voiceId?: string
  refAudioPath?: string
  promptText?: string
  promptLang?: string
  textLang?: string
  gptPath?: string
  sovitsPath?: string
  params?: SegParams
}

export interface TimingV2 {
  version: number
  sampleRate: number
  duration: number
  seed?: number
  gain?: number
  gap?: number
  source?: TimingSource
  edited?: boolean
  editCount?: number
  segments: EditSegment[]
}

export interface Candidate {
  candidate: number
  path: string
  duration: number
  sampleRate: number
  voicedStart: number
  voicedEnd: number
  pauses: number[]
  seed: number
  flags: string[]
}

export interface PreviewSegment {
  index: number
  text: string
  params: SegParams
  candidates: Candidate[]
}

/** Pending preview sessions: editId -> data needed to commit. */
export interface PreviewSession {
  editId: string
  audioPath: string
  outDir: string
  createdAt: number
  segments: PreviewSegment[]
}

const sessions = new Map<string, PreviewSession>()

export function newEditId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function rememberPreview(s: PreviewSession): void {
  sessions.set(s.editId, s)
  // Keep at most 20 sessions in memory; temp files are cleaned with data/temp.
  if (sessions.size > 20) {
    const oldest = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0]
    dropPreview(oldest.editId)
  }
}

export function getPreview(editId: string): PreviewSession {
  const s = sessions.get(editId)
  if (!s) throw new Error('试听已过期，请重新生成')
  return s
}

export function dropPreview(editId: string): void {
  const s = sessions.get(editId)
  sessions.delete(editId)
  // Only ever delete the throwaway preview folder, never a user directory.
  if (s && s.outDir.split(/[\\/]/).includes('preview')) fs.rmSync(s.outDir, { recursive: true, force: true })
}

function base(audioPath: string): string {
  return audioPath.replace(/\.[^.\\/]+$/, '')
}

export function backupPaths(audioPath: string, tag: 'orig' | 'prev'): { wav: string; timing: string } {
  const b = base(audioPath)
  return { wav: `${b}.${tag}.wav`, timing: `${b}.${tag}.timing.json` }
}

export function readTimingV2(audioPath: string): TimingV2 {
  const p = timingPathFor(audioPath)
  if (!fs.existsSync(p)) throw new Error('这条记录没有时间轴，无法分段编辑')
  const t = JSON.parse(fs.readFileSync(p, 'utf-8')) as TimingV2
  if (!Array.isArray(t.segments) || !t.segments.length) throw new Error('时间轴为空')
  return t
}

export function editState(audioPath: string): { edited: boolean; editCount: number; hasOriginal: boolean; hasPrevious: boolean } {
  let edited = false
  let editCount = 0
  try {
    const t = readTimingV2(audioPath)
    edited = !!t.edited
    editCount = t.editCount || 0
  } catch {
    /* no timing */
  }
  return {
    edited,
    editCount,
    hasOriginal: fs.existsSync(backupPaths(audioPath, 'orig').wav),
    hasPrevious: fs.existsSync(backupPaths(audioPath, 'prev').wav)
  }
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000

function rms(s: Int16Array, from: number, to: number): number {
  from = Math.max(0, from)
  to = Math.min(s.length, to)
  if (to <= from) return 0
  let acc = 0
  for (let i = from; i < to; i++) acc += s[i] * s[i]
  return Math.sqrt(acc / (to - from))
}

export interface Choice {
  index: number
  candidate: number
}

/**
 * Replace segments with chosen candidates. Later segments shift by the length delta; gaps keep their size.
 * Returns the updated timing.
 */
export function commitSegments(audioPath: string, editId: string, choices: Choice[], matchLoudness = true): TimingV2 {
  const session = getPreview(editId)
  if (session.audioPath !== audioPath) throw new Error('试听与音频文件不匹配')
  const timingPath = timingPathFor(audioPath)
  const timing = readTimingV2(audioPath)
  const wav = readWav(audioPath)
  const sr = wav.sampleRate
  if (wav.channels !== 1) throw new Error('仅支持单声道')

  // Resolve choices into (segment, clip)
  const repl = choices
    .map((c) => {
      const seg = session.segments.find((s) => s.index === c.index)
      const cand = seg?.candidates.find((k) => k.candidate === c.candidate)
      if (!seg || !cand) throw new Error(`第 ${c.index + 1} 句的候选 ${c.candidate + 1} 不存在`)
      const clip = readWav(cand.path)
      if (clip.sampleRate !== sr) throw new Error('候选采样率与原音频不一致')
      return { seg, cand, clip }
    })
    .sort((a, b) => a.seg.index - b.seg.index)
  if (!repl.length) throw new Error('没有选择要替换的候选')

  // Backups
  const orig = backupPaths(audioPath, 'orig')
  if (!fs.existsSync(orig.wav)) {
    fs.copyFileSync(audioPath, orig.wav)
    fs.copyFileSync(timingPath, orig.timing)
  }
  const prev = backupPaths(audioPath, 'prev')
  fs.copyFileSync(audioPath, prev.wav)
  fs.copyFileSync(timingPath, prev.timing)

  const parts: Int16Array[] = []
  let readPos = 0 // samples in original
  let shift = 0 // seconds added so far
  const byIndex = new Map(repl.map((r) => [r.seg.index, r]))
  for (const seg of timing.segments) {
    const s0 = Math.round(seg.start * sr)
    const s1 = Math.min(wav.samples.length, Math.round(seg.end * sr))
    const r = byIndex.get(seg.index)
    if (!r) {
      seg.start = r3(seg.start + shift)
      seg.end = r3(seg.end + shift)
      seg.voicedStart = r3(seg.voicedStart + shift)
      seg.voicedEnd = r3(seg.voicedEnd + shift)
      seg.pauses = (seg.pauses || []).map((p) => r3(p + shift))
      continue
    }
    parts.push(wav.samples.subarray(readPos, s0))
    let clip = r.clip.samples
    if (matchLoudness) {
      const ctx = Math.round(3 * sr)
      const target = (rms(wav.samples, s0 - ctx, s0) + rms(wav.samples, s1, s1 + ctx)) / 2 || rms(wav.samples, s0, s1)
      const cur = rms(clip, 0, clip.length)
      if (target > 0 && cur > 0) {
        const g = Math.max(0.5, Math.min(2, target / cur))
        if (Math.abs(g - 1) > 0.05) {
          const out = new Int16Array(clip.length)
          for (let i = 0; i < clip.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(clip[i] * g)))
          clip = out
        }
      }
    }
    parts.push(clip)
    readPos = s1
    const newStart = seg.start + shift
    const newLen = clip.length / sr
    const oldLen = (s1 - s0) / sr
    seg.start = r3(newStart)
    seg.end = r3(newStart + newLen)
    seg.voicedStart = r3(newStart + r.cand.voicedStart)
    seg.voicedEnd = r3(newStart + r.cand.voicedEnd)
    seg.pauses = r.cand.pauses.map((p) => r3(newStart + p))
    seg.text = r.seg.text
    seg.seed = r.cand.seed
    seg.flags = r.cand.flags
    seg.params = r.seg.params
    seg.retries = 0
    seg.edited = true
    shift += newLen - oldLen
  }
  parts.push(wav.samples.subarray(readPos))
  const total = parts.reduce((n, p) => n + p.length, 0)
  const merged = new Int16Array(total)
  let o = 0
  for (const p of parts) {
    merged.set(p, o)
    o += p.length
  }
  writeWav(audioPath, { sampleRate: sr, channels: 1, samples: merged })
  timing.duration = r3(total / sr)
  timing.edited = true
  timing.editCount = (timing.editCount || 0) + 1
  fs.writeFileSync(timingPath, JSON.stringify(timing, null, 1), 'utf-8')
  dropPreview(editId)
  return timing
}

/** Restore from the original or previous backup. 'last' undoes one step only. */
export function revertEdits(audioPath: string, mode: 'original' | 'last'): TimingV2 {
  const timingPath = timingPathFor(audioPath)
  const src = backupPaths(audioPath, mode === 'original' ? 'orig' : 'prev')
  if (!fs.existsSync(src.wav) || !fs.existsSync(src.timing)) throw new Error(mode === 'original' ? '没有原始备份' : '没有可撤销的操作')
  fs.copyFileSync(src.wav, audioPath)
  fs.copyFileSync(src.timing, timingPath)
  const prev = backupPaths(audioPath, 'prev')
  fs.rmSync(prev.wav, { force: true })
  fs.rmSync(prev.timing, { force: true })
  if (mode === 'original') {
    const orig = backupPaths(audioPath, 'orig')
    fs.rmSync(orig.wav, { force: true })
    fs.rmSync(orig.timing, { force: true })
  }
  return readTimingV2(audioPath)
}
