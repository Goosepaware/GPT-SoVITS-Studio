import fs from 'node:fs'
import path from 'node:path'
import {
  SUBTITLE_FORMATS,
  type AppConfig,
  type AsrFileResult,
  type HistoryEntry,
  type ModelCatalog,
  type SepModelInfo,
  type SepResult,
  type SubtitleFormat,
  type TtsResult,
  type Voice
} from '@shared/types'
import { hasTiming, timingPathFor, writeSubtitles } from '../subtitles'
import { alignSentences, buildBilingualSrt, burnSubtitles, parseSubtitleFile, splitLongCues, writeAss, type BiCue } from '../burn'

type Json = Record<string, unknown>

/** Everything the MCP layer needs from the app. Implemented in main/index.ts. */
export interface ToolHost {
  version: string
  config: () => AppConfig
  status: () => Json
  models: () => ModelCatalog
  voices: () => Voice[]
  createVoice: (p: { sourcePath: string; name: string; transcript?: string; lang?: string }) => Promise<Voice>
  removeVoice: (id: string) => void
  history: () => HistoryEntry[]
  /** Runs on the shared GPU queue; auto-loads models. */
  synthesize: (options: Json, outputPath?: string) => Promise<TtsResult>
  transcribe: (files: string[], language: string) => Promise<AsrFileResult[]>
  cancelTts: () => void
  audioFilesInFolder: (dir: string) => string[]
  /** Worker stage/progress events (0..1) while a job runs. Returns an unsubscribe function. */
  onWorkerProgress?: (cb: (p: { percent?: number; message: string }) => void) => () => void
  /** Diarization + dubbing (see main/dub.ts). */
  dub?: {
    extractAudio: (src: string, start?: number, end?: number) => Promise<string>
    diarize: (src: string, opts: { numSpeakers?: number; language?: string; transcribe?: boolean; threshold?: number }) => Promise<unknown>
    voiceFromSpan: (src: string, start: number, end: number, name: string, transcript?: string, lang?: string) => Promise<Voice>
    mix: (
      base: string,
      items: { audioPath: string; start: number; gain?: number }[],
      outputPath: string,
      bgm?: 'keep' | 'duck' | 'remove' | 'replace',
      bedPath?: string
    ) => Promise<string>
    separate: (src: string, model?: string, onProgress?: (current: number, total: number, label: string) => void) => Promise<SepResult>
    sepModels: () => SepModelInfo[]
    fit: (
      index: number,
      target: number,
      baseSpeed: number,
      synth: (speed: number) => Promise<{ filePath: string; duration: number }>
    ) => Promise<{ filePath: string; report: unknown }>
  }
  /** Segment re-generation (see main/segmentEdit.ts). */
  segments?: {
    list: (audioPath: string) => unknown
    preview: (audioPath: string, indices: number[], overrides: Json, count: number) => Promise<unknown>
    commit: (audioPath: string, editId: string, choices: { index: number; candidate: number }[], matchLoudness?: boolean) => unknown
    revert: (audioPath: string, mode: 'original' | 'last') => unknown
  }
  /** Unload engines and free VRAM. Returns the engines actually unloaded. */
  unload?: (which: 'tts' | 'asr' | 'all') => Promise<string[]>
  activity: (line: string) => void
}

interface Job {
  id: string
  tool: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  createdAt: number
  finishedAt?: number
  progress?: string
  /** Fine-grained 0..1 progress from the worker (TTS stages / ASR files). */
  percent?: number
  result?: unknown
  error?: string
  cancelRequested: boolean
  promise: Promise<void>
}

interface ToolDef {
  name: string
  description: string
  inputSchema: Json
  /** Long-running: executed as a job; returns a jobId if not finished within `wait`. */
  long?: boolean
  run: (args: Json, job: Job | null) => Promise<unknown>
}

export interface CallContext {
  /** Called with a job snapshot when status/progress changes (MCP notifications/progress). */
  onProgress?: (p: { progress: number; total?: number; message: string }) => void
  /** Called once a long tool's job is created (lets the server map request ids to jobs). */
  onJob?: (jobId: string) => void
}

function progressOf(job: Job): { progress: number; total?: number; message: string } {
  if (typeof job.percent === 'number') {
    const p = Math.max(0, Math.min(100, Math.round(job.percent * 100)))
    return { progress: p, total: 100, message: job.progress || `${job.tool} ${job.status}` }
  }
  const m = /^(\d+)\/(\d+)/.exec(job.progress || '')
  const message = `${job.tool} ${job.status}${job.progress ? ` · ${job.progress}` : ''}`
  if (m) return { progress: Number(m[1]), total: Number(m[2]), message }
  return { progress: job.status === 'running' ? 0 : 1, total: 1, message }
}

const SYNTH_DEFAULTS: Json = {
  textLang: 'auto',
  speed: 1,
  splitMethod: 'cut5',
  topK: 15,
  topP: 1,
  temperature: 1,
  repetitionPenalty: 1.35,
  seed: -1,
  batchSize: 1,
  // Agent default: 8 steps (better prosody than the UI's fast 4); the agent may override per call / per line.
  sampleSteps: 8,
  fragmentInterval: 0.3,
  parallelInfer: true,
  maxRetries: 2
}

const PARAMS_SCHEMA = {
  type: 'object',
  description:
    'Optional inference params: speed (0.5-2), sampleSteps (4|8|16|32; default 8 for agents, raise to 16 for hero lines, 4 for fast drafts), seed (-1 random), temperature, topK, topP, repetitionPenalty, fragmentInterval (silence between sentences inside one line, s; default 0.3, dubbing 0.1-0.2, narration 0.3-0.5), splitMethod (cut0 = no split, cut5 = by punctuation; timed dubbing lines default to cut0), maxRetries (default 2), gptPath, sovitsPath.',
  additionalProperties: true
}

const FORMATS_SCHEMA = {
  type: 'array',
  items: { type: 'string', enum: SUBTITLE_FORMATS },
  description: 'Subtitle formats to write next to the audio. Text = input script; timing = real generated audio.'
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function sanitize(text: string): string {
  const cleaned = text
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[.。！？!?，,、；;：:\s]+$/g, '')
    .trim()
  const chars = Array.from(cleaned || '语音')
  return chars.length > 40 ? chars.slice(0, 40).join('') : chars.join('')
}

function uniquePath(dir: string, base: string): string {
  fs.mkdirSync(dir, { recursive: true })
  let p = path.join(dir, `${base}.wav`)
  let i = 1
  while (fs.existsSync(p)) p = path.join(dir, `${base}（${i++}）.wav`)
  return p
}

export class McpTools {
  private jobs = new Map<string, Job>()
  private seq = 0
  readonly defs: ToolDef[]

  constructor(private host: ToolHost) {
    this.defs = this.buildDefs()
  }

  list(): Array<{ name: string; description: string; inputSchema: Json }> {
    return this.defs.map(({ name, description, inputSchema, long }) => ({
      name,
      description,
      inputSchema: long
        ? {
            ...inputSchema,
            properties: {
              ...((inputSchema.properties as Json) || {}),
              wait: { type: 'number', description: 'Seconds to wait before returning a jobId (default 90, max 240, 0 = immediately).' }
            }
          }
        : inputSchema
    }))
  }

  async call(name: string, args: Json, ctx: CallContext = {}): Promise<unknown> {
    const def = this.defs.find((d) => d.name === name)
    if (!def) throw new Error(`Unknown tool: ${name}`)
    this.host.activity(`${name} ${JSON.stringify(args).slice(0, 200)}`)
    if (!def.long) return def.run(args, null)
    const job = this.startJob(def, args)
    ctx.onJob?.(job.id)
    const wait = Math.min(240, Math.max(0, Number(args.wait ?? 90)))
    let timer: NodeJS.Timeout | undefined
    let offWorker: (() => void) | undefined
    if (ctx.onProgress) {
      let lastKey = ''
      let lastSent = 0
      const emit = (force: boolean): void => {
        const key = `${job.status}|${job.progress || ''}|${job.percent ?? ''}`
        const now = Date.now()
        if (!force && (key === lastKey || now - lastSent < 150)) return
        if (key === lastKey && !force) return
        lastKey = key
        lastSent = now
        ctx.onProgress!(progressOf(job))
      }
      // Coalesce worker progress into the job so SSE notifications stay cheap.
      offWorker = this.host.onWorkerProgress?.((p) => {
        if (p.percent !== undefined) job.percent = p.percent
        if (p.message) job.progress = p.message
        emit(false)
      })
      emit(true)
      timer = setInterval(() => emit(true), 1000)
    }
    try {
      await Promise.race([job.promise, sleep(wait * 1000)])
    } finally {
      if (timer) clearInterval(timer)
      offWorker?.()
    }
    return this.view(job)
  }

  /** Cancel a job by id (used for MCP notifications/cancelled). */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job || job.status !== 'running') return false
    job.cancelRequested = true
    this.host.cancelTts()
    return true
  }

  // ------------------------------------------------------------------ jobs

  private startJob(def: ToolDef, args: Json): Job {
    const id = `job-${Date.now().toString(36)}-${(++this.seq).toString(36)}`
    const job: Job = { id, tool: def.name, status: 'running', createdAt: Date.now(), cancelRequested: false, promise: Promise.resolve() }
    job.promise = def
      .run(args, job)
      .then((result) => {
        job.result = result
        job.status = job.cancelRequested ? 'cancelled' : 'done'
      })
      .catch((error) => {
        job.error = error instanceof Error ? error.message : String(error)
        job.status = job.cancelRequested ? 'cancelled' : 'error'
      })
      .finally(() => {
        job.finishedAt = Date.now()
        this.host.activity(`${job.tool} ${job.id} → ${job.status}${job.error ? `: ${job.error}` : ''}`)
      })
    this.jobs.set(id, job)
    if (this.jobs.size > 200) {
      for (const [k, j] of this.jobs) {
        if (j.status !== 'running') this.jobs.delete(k)
        if (this.jobs.size <= 150) break
      }
    }
    return job
  }

  private view(job: Job): Json {
    const base: Json = { jobId: job.id, tool: job.tool, status: job.status }
    if (job.progress) base.progress = job.progress
    if (job.status === 'running') base.hint = 'Not finished yet. Call job_status with this jobId (wait up to 240 s).'
    if (job.result !== undefined) base.result = job.result
    if (job.error) base.error = job.error
    return base
  }

  private getJob(args: Json): Job {
    const job = this.jobs.get(String(args.jobId || ''))
    if (!job) throw new Error('Unknown jobId')
    return job
  }

  // --------------------------------------------------------------- helpers

  private checkPath(p: string): string {
    if (!p) throw new Error('path is required')
    const abs = path.resolve(p)
    const allow = this.host.config().mcp.pathAllowlist
    if (allow.length && !allow.some((root) => abs.toLowerCase().startsWith(path.resolve(root).toLowerCase()))) {
      throw new Error(`Path not in allowlist: ${abs}`)
    }
    return abs
  }

  private findVoice(key: string): Voice {
    const voices = this.host.voices()
    const k = key.trim().replace(/\.v5t$/i, '')
    const v = voices.find((x) => x.id === k) || voices.find((x) => x.name === k) || voices.find((x) => x.name.toLowerCase() === k.toLowerCase())
    if (!v) throw new Error(`Voice not found: ${key}. Use list_voices.`)
    return v
  }

  private buildSynth(a: Json, fallbackVoice?: string): Json {
    const text = str(a.text)
    if (!text) throw new Error('text is required')
    const voiceKey = str(a.voice) || fallbackVoice
    const voice = voiceKey ? this.findVoice(voiceKey) : undefined
    const ref = str(a.refAudioPath) ? this.checkPath(String(a.refAudioPath)) : voice?.audioPath
    const promptText = str(a.promptText) || voice?.transcript
    if (!ref || !promptText) throw new Error('Provide voice (name or id), or both refAudioPath and promptText')
    const params = (a.params && typeof a.params === 'object' ? a.params : {}) as Json
    return {
      ...SYNTH_DEFAULTS,
      ...params,
      text,
      textLang: str(a.textLang) || params.textLang || SYNTH_DEFAULTS.textLang,
      refAudioPath: ref,
      promptText,
      promptLang: str(a.promptLang) || voice?.promptLang || 'auto',
      voiceId: voice?.id
    }
  }

  private formats(v: unknown): SubtitleFormat[] {
    if (!Array.isArray(v)) return []
    return v.filter((f): f is SubtitleFormat => SUBTITLE_FORMATS.includes(f as SubtitleFormat))
  }

  private async synthOne(a: Json, extra: { outputDir?: string; fileName?: string; voice?: string; formats?: SubtitleFormat[] } = {}): Promise<Json> {
    const options = this.buildSynth(a, extra.voice)
    const dir = str(a.outputDir) || extra.outputDir
    const out = dir ? uniquePath(this.checkPath(dir), sanitize(str(a.fileName) || extra.fileName || String(options.text))) : undefined
    const r = await this.host.synthesize(options, out)
    const own = this.formats(a.subtitleFormats)
    const fmts = own.length ? own : extra.formats || []
    const subtitles = fmts.length && r.timingPath ? writeSubtitles(r.filePath, fmts, this.host.config().subtitle) : []
    return {
      filePath: r.filePath,
      timingPath: r.timingPath,
      subtitles,
      duration: r.duration,
      sentences: r.segments,
      seed: r.seed,
      warnings: r.warnings || [],
      historyId: r.historyId
    }
  }

  // ----------------------------------------------------------------- tools

  private buildDefs(): ToolDef[] {
    const h = this.host
    const voiceView = (v: Voice): Json => ({ id: v.id, name: v.name, transcript: v.transcript, lang: v.promptLang, duration: v.duration, package: v.packagePath })
    return [
      {
        name: 'studio_status',
        description: 'GPT-SoVITS-Studio status: engine states, loaded models, GPU/VRAM, output dir, voice count, version.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => ({
          version: h.version,
          ...h.status(),
          separation: { installed: (h.dub?.sepModels() || []).filter((m) => m.installed).map((m) => m.id) }
        })
      },
      {
        name: 'list_models',
        description:
          'List v5turbo GPT (.ckpt) and SoVITS (.pth) weights (pass a path as params.gptPath / params.sovitsPath to synthesize; default = base models) and vocal separation models (installed flag; users download them on the 音频处理 page).',
        inputSchema: { type: 'object', properties: {} },
        run: async () => ({
          ...h.models().tts,
          separation: (h.dub?.sepModels() || []).map((m) => ({ id: m.id, label: m.label, installed: m.installed, note: m.note }))
        })
      },
      {
        name: 'list_voices',
        description: 'List saved voices (.v5t = reference audio + transcript + language). Use name or id as `voice` in synthesize.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Optional name filter' } } },
        run: async (a) => {
          const q = str(a.query)?.toLowerCase()
          return h.voices().filter((v) => !q || v.name.toLowerCase().includes(q)).map(voiceView)
        }
      },
      {
        name: 'create_voice',
        description:
          'Create a voice from a clean 3-10 s single-speaker clip (longer clips are trimmed). If transcript is omitted it is recognized with local SenseVoice. Choose clips with clear speech, no music/SFX, little reverb. Grouping clips by speaker is the caller\'s job.',
        long: true,
        inputSchema: {
          type: 'object',
          required: ['audioPath', 'name'],
          properties: {
            audioPath: { type: 'string' },
            name: { type: 'string', description: 'Voice name (also the .v5t file name)' },
            transcript: { type: 'string', description: 'Exact text spoken in the clip. Recommended when known (e.g. game subtitle tables).' },
            lang: { type: 'string', description: 'zh / en / ja / ko / yue / auto' }
          }
        },
        run: async (a) => {
          const name = str(a.name)
          if (!name) throw new Error('name is required')
          const v = await h.createVoice({ sourcePath: this.checkPath(String(a.audioPath || '')), name, transcript: str(a.transcript), lang: str(a.lang) })
          return voiceView(v)
        }
      },
      {
        name: 'delete_voice',
        description: 'Delete a saved voice. Requires confirm: true.',
        inputSchema: { type: 'object', required: ['voice', 'confirm'], properties: { voice: { type: 'string' }, confirm: { type: 'boolean' } } },
        run: async (a) => {
          if (a.confirm !== true) throw new Error('Set confirm: true to delete')
          const v = this.findVoice(String(a.voice || ''))
          h.removeVoice(v.id)
          return { deleted: v.name }
        }
      },
      {
        name: 'synthesize',
        description:
          'Generate speech for one text with a saved voice. Produces a WAV and a .timing.json (real per-sentence timeline), optionally subtitles. Silent or abnormally long/short sentences are auto-retried with new seeds; remaining issues are listed in `warnings`.',
        long: true,
        inputSchema: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string' },
            voice: { type: 'string', description: 'Voice name or id from list_voices' },
            refAudioPath: { type: 'string', description: 'Alternative to voice: ad-hoc reference clip' },
            promptText: { type: 'string', description: 'Transcript of refAudioPath' },
            promptLang: { type: 'string' },
            textLang: { type: 'string', description: 'Language of text, default auto' },
            outputDir: { type: 'string', description: 'Default: app output folder' },
            fileName: { type: 'string', description: 'Base file name without extension' },
            subtitleFormats: FORMATS_SCHEMA,
            params: PARAMS_SCHEMA
          }
        },
        run: async (a) => this.synthOne(a)
      },
      {
        name: 'synthesize_script',
        description:
          'Batch-generate many lines (animation script, translated dialogue). One WAV per line named by line id; manifest.json in outputDir lists every file, duration, timing and warnings and is updated after each line. Failed lines are reported and skipped.',
        long: true,
        inputSchema: {
          type: 'object',
          required: ['lines', 'outputDir'],
          properties: {
            lines: {
              type: 'array',
              items: {
                type: 'object',
                required: ['text'],
                properties: {
                  id: { type: 'string', description: 'File name, e.g. "s01_003_alice"' },
                  text: { type: 'string' },
                  voice: { type: 'string' },
                  textLang: { type: 'string' },
                  start: { type: 'number', description: 'Dubbing window start (s). With end, the line is fitted into the window (speed 0.85-1.15, then atempo ±10%); see fitReport/overflow.' },
                  end: { type: 'number' },
                  params: PARAMS_SCHEMA
                }
              }
            },
            voice: { type: 'string', description: 'Default voice for lines without one' },
            refAudioPath: { type: 'string', description: 'Default reference clip for lines without a voice' },
            promptText: { type: 'string', description: 'Transcript of refAudioPath' },
            promptLang: { type: 'string' },
            textLang: { type: 'string' },
            outputDir: { type: 'string' },
            subtitleFormats: FORMATS_SCHEMA,
            params: PARAMS_SCHEMA,
            stopOnError: { type: 'boolean' }
          }
        },
        run: async (a, job) => {
          const lines = Array.isArray(a.lines) ? (a.lines as Json[]) : []
          if (!lines.length) throw new Error('lines is empty')
          const outputDir = this.checkPath(String(a.outputDir || ''))
          fs.mkdirSync(outputDir, { recursive: true })
          const shared = (a.params && typeof a.params === 'object' ? a.params : {}) as Json
          const defaults: Json = {
            refAudioPath: a.refAudioPath,
            promptText: a.promptText,
            promptLang: a.promptLang,
            textLang: a.textLang
          }
          const formats = this.formats(a.subtitleFormats)
          const manifest = path.join(outputDir, 'manifest.json')
          // Re-running a subset of lines (fixes after "overflow") must not wipe the other lines.
          let merged: Json[] = []
          try {
            if (fs.existsSync(manifest)) merged = (JSON.parse(fs.readFileSync(manifest, 'utf-8')).items || []) as Json[]
          } catch {
            merged = []
          }
          const items: Json[] = []
          for (let i = 0; i < lines.length; i++) {
            if (job?.cancelRequested) break
            const line = lines[i]
            const id = str(line.id) || String(i + 1).padStart(3, '0')
            if (job) job.progress = `${i}/${lines.length} · ${id}`
            try {
              let lp: Json = { ...shared, ...((line.params as Json) || {}) }
              const s0 = Number(line.start)
              const s1 = Number(line.end)
              if (h.dub && Number.isFinite(s0) && Number.isFinite(s1) && s1 > s0) {
                // Timed dubbing line = one sentence already segmented by the agent: don't split again.
                lp = { splitMethod: 'cut0', ...lp }
                let last: Json = {}
                const lineIndex = Number(/^l?0*(\d+)$/.exec(id)?.[1] ?? i + 1) - 1
                const fit = await h.dub.fit(Number.isFinite(lineIndex) ? lineIndex : i, s1 - s0, Number(lp.speed) || 1, async (speed) => {
                  last = await this.synthOne({ ...defaults, ...line, params: { ...lp, speed } }, { outputDir, fileName: id, voice: str(a.voice), formats })
                  return { filePath: String(last.filePath), duration: Number(last.duration) }
                })
                items.push({ id, text: line.text, ok: true, ...last, filePath: fit.filePath, start: s0, end: s1, fit: fit.report })
              } else {
                const r = await this.synthOne({ ...defaults, ...line, params: lp }, { outputDir, fileName: id, voice: str(a.voice), formats })
                items.push({ id, text: line.text, ok: true, ...r })
              }
            } catch (error) {
              items.push({ id, text: line.text, ok: false, error: error instanceof Error ? error.message : String(error) })
              if (a.stopOnError === true) break
            }
            const rest = merged.filter((x) => !items.some((y) => y.id === x.id))
            const all = [...rest, ...items].sort((x, y) => Number(x.start ?? 0) - Number(y.start ?? 0))
            fs.writeFileSync(manifest, JSON.stringify({ outputDir, items: all }, null, 1), 'utf-8')
          }
          if (job) job.progress = `${items.length}/${lines.length}`
          const fitReport = items.filter((x) => x.fit).map((x) => x.fit)
          return {
            manifest,
            done: items.filter((x) => x.ok).length,
            failed: items.filter((x) => !x.ok).length,
            total: lines.length,
            overflow: fitReport.filter((f) => (f as Json).method === 'overflow').map((f) => (f as Json).index),
            ...(fitReport.length ? { fitReport } : {}),
            items
          }
        }
      },
      {
        name: 'transcribe',
        description: 'Local speech-to-text with SenseVoice (zh/en/ja/ko/yue). Pass files and/or a folder (recursive).',
        long: true,
        inputSchema: {
          type: 'object',
          properties: {
            files: { type: 'array', items: { type: 'string' } },
            folder: { type: 'string' },
            language: { type: 'string', description: 'auto / zh / en / ja / ko / yue' }
          }
        },
        run: async (a) => {
          let files = Array.isArray(a.files) ? (a.files as string[]).map((f) => this.checkPath(f)) : []
          if (str(a.folder)) files = files.concat(h.audioFilesInFolder(this.checkPath(String(a.folder))))
          if (!files.length) throw new Error('No audio files')
          const results = await h.transcribe(files, str(a.language) || 'auto')
          return results.map((r) => ({ path: r.path, text: r.text, language: r.language, ok: r.ok, error: r.error }))
        }
      },
      {
        name: 'export_subtitle',
        description: 'Write subtitles for audio generated by this app (needs its .timing.json).',
        inputSchema: { type: 'object', required: ['audioPath'], properties: { audioPath: { type: 'string' }, formats: FORMATS_SCHEMA, outputDir: { type: 'string' } } },
        run: async (a) => {
          const audio = this.checkPath(String(a.audioPath || ''))
          if (!hasTiming(audio)) throw new Error(`No timeline: ${timingPathFor(audio)}`)
          const fmts = this.formats(a.formats)
          const dir = str(a.outputDir) ? this.checkPath(String(a.outputDir)) : undefined
          return { files: writeSubtitles(audio, fmts.length ? fmts : [h.config().subtitle.defaultFormat], h.config().subtitle, dir) }
        }
      },
      {
        name: 'extract_audio',
        description: 'Extract audio from a video/audio file as 16 kHz mono WAV (optional start/end seconds).',
        inputSchema: { type: 'object', required: ['videoPath'], properties: { videoPath: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } } },
        run: async (a) => {
          if (!h.dub) throw new Error('Dubbing unavailable')
          const s = a.start === undefined ? undefined : Number(a.start)
          const e = a.end === undefined ? undefined : Number(a.end)
          return { audioPath: await h.dub.extractAudio(this.checkPath(String(a.videoPath || '')), s, e) }
        }
      },
      {
        name: 'diarize',
        description:
          'Speaker diarization (CAM++) + per-line transcription. Returns items [{start,end,speaker:"S1",text,lang,confidence}] and per-speaker reference candidates (3-10 s). Accepts video or audio. Limits: overlapping speech goes to one speaker; lines <1 s and similar voices may be mislabeled; pass numSpeakers when known.',
        long: true,
        inputSchema: {
          type: 'object',
          required: ['audioPath'],
          properties: {
            audioPath: { type: 'string' },
            numSpeakers: { type: 'number' },
            language: { type: 'string' },
            transcribe: { type: 'boolean' },
            threshold: { type: 'number', description: 'Cosine distance for auto speaker count (default 0.6; lower = more speakers)' },
            useVocals: { type: 'boolean', description: 'Separate vocals first (needs a separation model; cached). Recommended for videos with music.' }
          }
        },
        run: async (a) => {
          if (!h.dub) throw new Error('Dubbing unavailable')
          let src = this.checkPath(String(a.audioPath || ''))
          if (a.useVocals === true) src = (await h.dub.separate(src)).vocals
          return h.dub.diarize(src, {
            numSpeakers: Number(a.numSpeakers) || undefined,
            language: str(a.language),
            transcribe: a.transcribe !== false,
            threshold: Number(a.threshold) || undefined
          })
        }
      },
      {
        name: 'voice_from_span',
        description: 'Create a voice from a time span of a video/audio (e.g. a diarize reference candidate). transcript = what is said in the span.',
        inputSchema: {
          type: 'object',
          required: ['sourcePath', 'start', 'end', 'name'],
          properties: {
            sourcePath: { type: 'string' },
            start: { type: 'number' },
            end: { type: 'number' },
            name: { type: 'string' },
            transcript: { type: 'string' },
            lang: { type: 'string' },
            useVocals: { type: 'boolean', description: 'Cut from separated vocals (cleaner reference). Same timeline as the source.' }
          }
        },
        run: async (a) => {
          if (!h.dub) throw new Error('Dubbing unavailable')
          let src = this.checkPath(String(a.sourcePath || ''))
          if (a.useVocals === true) src = (await h.dub.separate(src)).vocals
          const v = await h.dub.voiceFromSpan(src, Number(a.start), Number(a.end), String(a.name || ''), str(a.transcript), str(a.lang))
          return voiceView(v)
        }
      },
      {
        name: 'separate_audio',
        description:
          'Split a video/audio into vocals.wav and instrumental.wav (UVR MDX-Net, 44.1 kHz stereo). Cached per source+model, so calling again is free. Use vocals for diarize/voice_from_span and instrumental as bedPath for mix_dub bgm:"replace". Fails if no separation model is installed: tell the user to download one on the 音频处理 page.',
        long: true,
        inputSchema: {
          type: 'object',
          required: ['sourcePath'],
          properties: { sourcePath: { type: 'string' }, model: { type: 'string', description: "'kim_vocal_2' (cleaner vocals, default) or 'inst_hq_3' (fuller background)" } }
        },
        run: async (a, job) => {
          if (!h.dub) throw new Error('Dubbing unavailable')
          return h.dub.separate(this.checkPath(String(a.sourcePath || '')), str(a.model), (cur, total, label) => {
            if (job) {
              job.progress = `${label} ${cur}/${total}`
              job.percent = total ? cur / total : undefined
            }
          })
        }
      },
      {
        name: 'mix_dub',
        description:
          "Place dub clips at their start times over the original and mix. bgm: 'replace' (separated instrumental bedPath + dub; best, original voices gone, music/SFX kept), 'duck' (original lowered under dub, default without bedPath), 'keep' (original + dub), 'remove' (dub only). Pass manifestPath (from synthesize_script with start/end lines) instead of items to use every ok line. Output .mp4/.mkv keeps the video stream; .wav = audio only.",
        long: true,
        inputSchema: {
          type: 'object',
          required: ['basePath', 'outputPath'],
          properties: {
            basePath: { type: 'string', description: 'Original video or audio' },
            items: { type: 'array', items: { type: 'object', properties: { audioPath: { type: 'string' }, start: { type: 'number' }, gain: { type: 'number' } } } },
            manifestPath: { type: 'string', description: 'manifest.json from synthesize_script; used when items is empty' },
            outputPath: { type: 'string' },
            bgm: { type: 'string', enum: ['replace', 'duck', 'keep', 'remove'] },
            bedPath: { type: 'string', description: 'instrumental.wav from separate_audio (required for replace)' }
          }
        },
        run: async (a) => {
          if (!h.dub) throw new Error('Dubbing unavailable')
          let raw = Array.isArray(a.items) ? (a.items as Json[]) : []
          if (!raw.length && a.manifestPath) {
            const m = JSON.parse(fs.readFileSync(this.checkPath(String(a.manifestPath)), 'utf-8')) as { items?: Json[] }
            raw = (m.items || []).filter((x) => x.ok && x.filePath && Number.isFinite(Number(x.start))).map((x) => ({ audioPath: x.filePath, start: x.start }))
            if (!raw.length) throw new Error('manifest has no ok lines with start times')
          }
          const items = raw.map((x) => ({
            audioPath: this.checkPath(String(x.audioPath || '')),
            start: Number(x.start) || 0,
            gain: x.gain === undefined ? undefined : Number(x.gain)
          }))
          const bedPath = a.bedPath ? this.checkPath(String(a.bedPath)) : undefined
          const bgm = a.bgm === 'keep' || a.bgm === 'remove' || a.bgm === 'duck' ? a.bgm : a.bgm === 'replace' || bedPath ? 'replace' : 'duck'
          const out = await h.dub.mix(this.checkPath(String(a.basePath || '')), items, this.checkPath(String(a.outputPath || '')), bgm, bedPath)
          return { outputPath: out, lines: items.length, bgm }
        }
      },
      {
        name: 'import_subtitle',
        description:
          'Read an existing SRT/VTT (e.g. YouTube CC) as transcript items [{start,end,text}]. Prefer this over diarize transcription when good captions exist; then build_script to re-segment into full sentences.',
        inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
        run: async (a) => ({ items: parseSubtitleFile(this.checkPath(String(a.path || ''))) })
      },
      {
        name: 'build_script',
        description:
          'Turn transcript items (from diarize or import_subtitle) into timed sentence lines. YOU segment: pass sentences = the transcript text re-cut into complete, natural sentences, in order, VERBATIM (only punctuation may change; do not translate here). The server aligns each sentence to the transcript and computes start/end (estimated by character position inside an item). Returns lines [{id,start,end,text,speaker,matched}]; check lines with matched:false. Then translate each line and pass lines (with start/end) to synthesize_script. Writes script.json if outputDir is given.',
        inputSchema: {
          type: 'object',
          required: ['items', 'sentences'],
          properties: {
            items: { type: 'array', items: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' }, speaker: { type: 'string' } } } },
            sentences: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, speaker: { type: 'string' } } } },
            outputDir: { type: 'string' }
          }
        },
        run: async (a) => {
          const items = (Array.isArray(a.items) ? (a.items as Json[]) : []).map((x) => ({
            start: Number(x.start) || 0,
            end: Number(x.end) || 0,
            text: String(x.text || ''),
            speaker: str(x.speaker)
          }))
          const sentences = (Array.isArray(a.sentences) ? (a.sentences as unknown[]) : []).map((x) =>
            typeof x === 'string' ? { text: x } : { text: String((x as Json).text || ''), speaker: str((x as Json).speaker) }
          )
          if (!items.length || !sentences.length) throw new Error('items and sentences are required')
          const r = alignSentences(items, sentences)
          let scriptPath: string | undefined
          if (str(a.outputDir)) {
            const dir = this.checkPath(String(a.outputDir))
            fs.mkdirSync(dir, { recursive: true })
            scriptPath = path.join(dir, 'script.json')
            fs.writeFileSync(scriptPath, JSON.stringify(r, null, 1), 'utf-8')
          }
          return { ...r, scriptPath, note: r.leftover ? 'Transcript text after the last sentence was not covered (leftover).' : undefined }
        }
      },
      {
        name: 'burn_subtitles',
        description:
          "Add bilingual subtitles to a video. primary = translated lines (large, bottom), secondary = original lines (small, above; layout 'split' puts it at the top). Each is lines [{start,end,text}], a manifest.json/script.json path, or an .srt/.vtt path. For a synthesize_script manifest, timing 'dub' (default) shows start..start+dub duration, 'slot' uses the original window. mode 'hard' burns in (re-encode, NVENC if available), 'soft' adds a subtitle track. Run on mix_dub's output. assOnly writes .ass + bilingual .srt only.",
        long: true,
        inputSchema: {
          type: 'object',
          required: ['videoPath', 'outputPath', 'primary'],
          properties: {
            videoPath: { type: 'string' },
            outputPath: { type: 'string' },
            primary: { description: 'lines array | manifest/script .json | .srt/.vtt path' },
            secondary: { description: 'same forms as primary; optional' },
            timing: { type: 'string', enum: ['dub', 'slot'] },
            mode: { type: 'string', enum: ['hard', 'soft'] },
            layout: { type: 'string', enum: ['stack', 'split'] },
            primarySize: { type: 'number' },
            secondarySize: { type: 'number' },
            font: { type: 'string' },
            assOnly: { type: 'boolean' }
          }
        },
        run: async (a) => {
          const timing = a.timing === 'slot' ? 'slot' : 'dub'
          const load = (v: unknown): { start: number; end: number; text: string }[] => {
            if (Array.isArray(v)) return (v as Json[]).map((x) => ({ start: Number(x.start) || 0, end: Number(x.end) || 0, text: String(x.text || '') }))
            if (typeof v !== 'string' || !v.trim()) return []
            const p = this.checkPath(v)
            if (/\.json$/i.test(p)) {
              const m = JSON.parse(fs.readFileSync(p, 'utf-8')) as { items?: Json[]; lines?: Json[] }
              return (m.items || m.lines || [])
                .filter((x) => x.ok !== false && Number.isFinite(Number(x.start)))
                .map((x) => {
                  const s = Number(x.start)
                  const fit = x.fit as Json | undefined
                  const dur = Number(fit?.actual) || Number(x.duration) || 0
                  const e = timing === 'dub' && dur > 0 ? s + dur : Number(x.end) || s + dur
                  return { start: s, end: e, text: String(x.text || '') }
                })
            }
            return parseSubtitleFile(p)
          }
          const prim = load(a.primary)
          if (!prim.length) throw new Error('primary has no lines')
          const sec = load(a.secondary)
          // Pair each primary cue with the secondary cue of largest time overlap, then cut
          // long cues so a whole paragraph never sits on screen at once.
          const paired: BiCue[] = prim.map((p) => {
            let best = ''
            let bestOv = 0
            for (const s of sec) {
              const ov = Math.min(p.end, s.end) - Math.max(p.start, s.start)
              if (ov > bestOv) {
                bestOv = ov
                best = s.text
              }
            }
            return { start: p.start, end: p.end, primary: p.text, secondary: best || undefined }
          })
          const cues = splitLongCues(paired, Math.max(8, Number(h.config().subtitle.maxChars) || 18))
          const style = {
            layout: a.layout === 'split' ? ('split' as const) : ('stack' as const),
            primarySize: Number(a.primarySize) || undefined,
            secondarySize: Number(a.secondarySize) || undefined,
            font: str(a.font)
          }
          const outputPath = this.checkPath(String(a.outputPath || ''))
          if (a.assOnly === true) {
            const stem = outputPath.replace(/\.[^.\\/]+$/, '')
            fs.mkdirSync(path.dirname(outputPath), { recursive: true })
            await writeAss(h.config().engineRoot, this.checkPath(String(a.videoPath || '')), cues, `${stem}.ass`, style)
            fs.writeFileSync(`${stem}.bilingual.srt`, buildBilingualSrt(cues), 'utf-8')
            return { assPath: `${stem}.ass`, srtPath: `${stem}.bilingual.srt`, cues: cues.length }
          }
          const r = await burnSubtitles(h.config().engineRoot, this.checkPath(String(a.videoPath || '')), cues, outputPath, a.mode === 'soft' ? 'soft' : 'hard', style)
          return { ...r, cues: cues.length, paired: cues.filter((c) => c.secondary).length }
        }
      },
      {
        name: 'list_segments',
        description: 'Sentence timeline of a generated audio (text, start/end, seed, flags, edited). Use to find bad sentences to re-generate.',
        inputSchema: { type: 'object', required: ['audioPath'], properties: { audioPath: { type: 'string' } } },
        run: async (a) => {
          if (!h.segments) throw new Error('Segment editing unavailable')
          return h.segments.list(this.checkPath(String(a.audioPath || '')))
        }
      },
      {
        name: 'preview_segments',
        description:
          'Re-generate selected sentences (0-based indices) as candidate clips without touching the full audio. Optional seed, params (speed/topK/topP/temperature/sampleSteps/repetitionPenalty), texts {"<index>": "new text"}, count (1-8 candidates). Returns editId + candidates; then call commit_segment.',
        long: true,
        inputSchema: {
          type: 'object',
          required: ['audioPath', 'indices'],
          properties: {
            audioPath: { type: 'string' },
            indices: { type: 'array', items: { type: 'number' } },
            seed: { type: 'number' },
            params: { type: 'object' },
            texts: { type: 'object' },
            count: { type: 'number' }
          }
        },
        run: async (a) => {
          if (!h.segments) throw new Error('Segment editing unavailable')
          const indices = Array.isArray(a.indices) ? a.indices.map(Number) : []
          return h.segments.preview(
            this.checkPath(String(a.audioPath || '')),
            indices,
            { seed: a.seed, params: a.params, texts: a.texts },
            Number(a.count) || 1
          )
        }
      },
      {
        name: 'commit_segment',
        description: 'Replace sentences in the full audio with chosen preview candidates. choices: [{index, candidate}]. Later sentences shift; subtitles stay valid. Marks the audio as edited.',
        inputSchema: {
          type: 'object',
          required: ['audioPath', 'editId', 'choices'],
          properties: {
            audioPath: { type: 'string' },
            editId: { type: 'string' },
            choices: { type: 'array', items: { type: 'object', properties: { index: { type: 'number' }, candidate: { type: 'number' } } } },
            matchLoudness: { type: 'boolean' }
          }
        },
        run: async (a) => {
          if (!h.segments) throw new Error('Segment editing unavailable')
          const choices = (Array.isArray(a.choices) ? a.choices : []).map((c) => ({ index: Number((c as Json).index), candidate: Number((c as Json).candidate ?? 0) }))
          const t = h.segments.commit(this.checkPath(String(a.audioPath || '')), String(a.editId || ''), choices, a.matchLoudness !== false) as Json
          return { duration: t.duration, editCount: t.editCount }
        }
      },
      {
        name: 'revert_edits',
        description: "Undo segment replacements: mode 'last' (one step) or 'original'.",
        inputSchema: { type: 'object', required: ['audioPath'], properties: { audioPath: { type: 'string' }, mode: { type: 'string', enum: ['last', 'original'] } } },
        run: async (a) => {
          if (!h.segments) throw new Error('Segment editing unavailable')
          const t = h.segments.revert(this.checkPath(String(a.audioPath || '')), a.mode === 'original' ? 'original' : 'last') as Json
          return { duration: t.duration, edited: !!t.edited }
        }
      },
      {
        name: 'unload_models',
        description:
          "Unload TTS and/or ASR models to free GPU memory. Models auto-load on the next call (first call is then slower), so do NOT unload between lines of one long task; call this once when the whole task is finished, or when the user needs VRAM. which: 'tts' | 'asr' | 'all' (default all). Running jobs are not interrupted: unload waits for the GPU queue.",
        inputSchema: { type: 'object', properties: { which: { type: 'string', enum: ['tts', 'asr', 'all'] } } },
        run: async (a) => {
          if (!h.unload) throw new Error('Unload unavailable')
          const which = a.which === 'tts' || a.which === 'asr' ? a.which : 'all'
          const unloaded = await h.unload(which)
          const st = h.status() as Json
          return { unloaded, gpu: st.gpu ?? null }
        }
      },
      {
        name: 'list_history',
        description: 'Recent generations, newest first.',
        inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
        run: async (a) =>
          h
            .history()
            .slice(0, Math.max(1, Math.min(200, Number(a.limit) || 20)))
            .map((e) => ({ id: e.id, text: e.text, filePath: e.filePath, duration: e.duration, voice: e.voiceName, seed: e.seed, params: e.params || null, createdAt: e.createdAt }))
      },
      {
        name: 'job_status',
        description: 'Get job progress/result. Optionally wait up to N seconds for completion.',
        inputSchema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' }, wait: { type: 'number' } } },
        run: async (a) => {
          const job = this.getJob(a)
          const wait = Math.min(240, Math.max(0, Number(a.wait ?? 0)))
          if (wait && job.status === 'running') await Promise.race([job.promise, sleep(wait * 1000)])
          return this.view(job)
        }
      },
      {
        name: 'job_cancel',
        description: 'Cancel a running job (stops current generation, skips remaining script lines).',
        inputSchema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' } } },
        run: async (a) => {
          const job = this.getJob(a)
          if (job.status === 'running') {
            job.cancelRequested = true
            h.cancelTts()
          }
          return this.view(job)
        }
      },
      {
        name: 'job_list',
        description: 'List recent jobs.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => [...this.jobs.values()].reverse().slice(0, 50).map((j) => ({ jobId: j.id, tool: j.tool, status: j.status, progress: j.progress }))
      }
    ]
  }
}

export const MCP_PROMPTS = [
  {
    name: 'dub_animation',
    description: 'Voice an animation/video script with saved voices; per-line WAVs plus subtitles.',
    text: `Dub a script with GPT-SoVITS-Studio:
1. list_voices; map each character to a voice (ask the user only if truly ambiguous).
2. Split the script into short utterances, id like "s01_003_alice".
3. synthesize_script {outputDir, lines:[{id,text,voice}], subtitleFormats:["srt"]}. Poll job_status if it returns a jobId.
4. For lines with warnings, call synthesize again for that line with the same fileName/outputDir.
5. Bad sentences inside a long line: list_segments -> preview_segments {indices, count:2} -> commit_segment instead of regenerating the whole line.
6. Report manifest path, total duration and remaining warnings. Assemble video with mix_dub if asked.`
  },
  {
    name: 'localize_video',
    description: 'Translate and re-dub a video: extract, transcribe, translate, synthesize timed lines, mix.',
    text: `Localized dubbing:
0. studio_status / list_models: check separation.installed. If none, skip step 1 and use bgm:'duck' in step 6 (tell the user they can download a model on the 音频处理 page for cleaner results).
1. separate_audio {sourcePath: video} -> {vocals, instrumental}. Cached; same timeline as the video.
2. Transcript: if good captions exist (e.g. YouTube CC .srt/.vtt), import_subtitle {path}; otherwise diarize {audioPath: vocals, numSpeakers if known} -> items [{start,end,speaker,text}] + references per speaker. Diarize items are VAD chunks, NOT sentences.
3. YOU segment: build_script {items, sentences:[{text}...], outputDir} where sentences = the transcript re-cut into complete natural sentences, verbatim and in order. The server computes start/end. Review lines with matched:false.
4. For each speaker: voice_from_span {sourcePath: vocals, start, end, name, transcript} using the best diarize reference (skip if the user maps speakers to existing voices).
5. Translate each script line; keep spoken length close to its slot (CJK ~4-5 chars/s). Keep the original text for subtitles.
6. synthesize_script {outputDir, lines:[{id, text, voice, start, end}], params:{sampleSteps:8, fragmentInterval:0.15}}. Timed lines are not re-split (cut0) and are fitted to their window; for indices in "overflow" shorten the translation and regenerate those lines (same id/outputDir). Raise sampleSteps to 16 for lines that sound rough.
7. mix_dub {basePath: video, manifestPath: <outputDir>/manifest.json, bedPath: instrumental, bgm:'replace', outputPath: dub.mp4}.
8. burn_subtitles {videoPath: dub.mp4, outputPath: final.mp4, primary: <outputDir>/manifest.json, secondary: <outputDir>/script.json, mode:'hard'} for bilingual subtitles (mode 'soft' if the user wants a toggleable track).
9. unload_models once at the end. Check speaker labels with the user when confidence is low.`
  },
  {
    name: 'build_voice_library',
    description: 'Turn a folder of character voice lines (e.g. extracted from a game) into saved voices.',
    text: `Build voices from voice lines:
1. Group files by character using folder/file names, game data tables, or the user. The app does not identify speakers.
2. Per character pick 1-3 clips: 3-10 s, single speaker, clear, no music/SFX/heavy reverb, complete sentence, neutral emotion.
3. Use the game's line text as transcript if available; otherwise create_voice recognizes it.
4. create_voice {audioPath, name, transcript, lang}. Optionally test with a short synthesize and keep the best.
5. Report created voices.`
  }
]
