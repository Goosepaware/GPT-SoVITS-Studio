import fs from 'node:fs'
import path from 'node:path'
import {
  SUBTITLE_FORMATS,
  type AppConfig,
  type AsrFileResult,
  type HistoryEntry,
  type ModelCatalog,
  type SubtitleFormat,
  type TtsResult,
  type Voice
} from '@shared/types'
import { hasTiming, timingPathFor, writeSubtitles } from '../subtitles'

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
  activity: (line: string) => void
}

interface Job {
  id: string
  tool: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  createdAt: number
  finishedAt?: number
  progress?: string
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
  sampleSteps: 4,
  fragmentInterval: 0.3,
  parallelInfer: true,
  maxRetries: 2
}

const PARAMS_SCHEMA = {
  type: 'object',
  description:
    'Optional inference params: speed (0.5-2), sampleSteps (4|8|16|32), seed (-1 random), temperature, topK, topP, repetitionPenalty, fragmentInterval (gap between sentences, s), splitMethod (cut0..cut5), maxRetries (default 2), gptPath, sovitsPath.',
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

  async call(name: string, args: Json): Promise<unknown> {
    const def = this.defs.find((d) => d.name === name)
    if (!def) throw new Error(`Unknown tool: ${name}`)
    this.host.activity(`${name} ${JSON.stringify(args).slice(0, 200)}`)
    if (!def.long) return def.run(args, null)
    const job = this.startJob(def, args)
    const wait = Math.min(240, Math.max(0, Number(args.wait ?? 90)))
    await Promise.race([job.promise, sleep(wait * 1000)])
    return this.view(job)
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
        run: async () => ({ version: h.version, ...h.status() })
      },
      {
        name: 'list_models',
        description: 'List v5turbo GPT (.ckpt) and SoVITS (.pth) weights. Pass a path as params.gptPath / params.sovitsPath to synthesize; default = base models.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => h.models().tts
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
          const items: Json[] = []
          for (let i = 0; i < lines.length; i++) {
            if (job?.cancelRequested) break
            const line = lines[i]
            const id = str(line.id) || String(i + 1).padStart(3, '0')
            if (job) job.progress = `${i}/${lines.length} · ${id}`
            try {
              const r = await this.synthOne(
                { ...defaults, ...line, params: { ...shared, ...((line.params as Json) || {}) } },
                { outputDir, fileName: id, voice: str(a.voice), formats }
              )
              items.push({ id, text: line.text, ok: true, ...r })
            } catch (error) {
              items.push({ id, text: line.text, ok: false, error: error instanceof Error ? error.message : String(error) })
              if (a.stopOnError === true) break
            }
            fs.writeFileSync(manifest, JSON.stringify({ outputDir, items }, null, 1), 'utf-8')
          }
          if (job) job.progress = `${items.length}/${lines.length}`
          return { manifest, done: items.filter((x) => x.ok).length, failed: items.filter((x) => !x.ok).length, total: lines.length, items }
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
        name: 'list_history',
        description: 'Recent generations, newest first.',
        inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
        run: async (a) =>
          h
            .history()
            .slice(0, Math.max(1, Math.min(200, Number(a.limit) || 20)))
            .map((e) => ({ id: e.id, text: e.text, filePath: e.filePath, duration: e.duration, voice: e.voiceName, seed: e.seed, createdAt: e.createdAt }))
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
5. Report manifest path, total duration and remaining warnings. Assemble video with ffmpeg if asked.`
  },
  {
    name: 'localize_video',
    description: 'Translate and re-dub a video: extract, transcribe, translate, synthesize timed lines, mix.',
    text: `Localized dubbing:
1. ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 src.wav; split into utterances with ffmpeg silencedetect, keep each clip's start/end.
2. transcribe the clips.
3. Translate each line; keep spoken length close to the original slot (CJK ~4-5 chars/s).
4. synthesize_script, id = clip index. If a result is longer than its slot, shorten the translation or set params.speed (<=1.15) and regenerate that line.
5. Mix with ffmpeg (adelay per clip at its start, duck/remove original vocals). export_subtitle if needed.
Speaker identification is the caller's job.`
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
