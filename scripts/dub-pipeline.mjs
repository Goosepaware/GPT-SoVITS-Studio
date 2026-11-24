/**
 * Drives the dubbing pipeline over MCP (the same path an AI agent uses).
 * Usage: node scripts/dub-pipeline.mjs <cmd> [args...]
 *   status
 *   sep <sourcePath> [model]
 *   diarize <audioPath> [numSpeakers]
 *   synth <script.json> <outputDir>
 *   mix <basePath> <manifestPath> <bedPath> <outputPath>
 *   subtitle <audioPath>
 */
import fs from 'node:fs'
import path from 'node:path'

const APP = process.env.GSV_APP_DIR || 'D:\\program\\tts\\GPT-SoVITS-Studio-Portable'
const cfg = JSON.parse(fs.readFileSync(path.join(APP, 'data', 'config.json'), 'utf-8'))
const url = `http://127.0.0.1:${cfg.mcp?.port || 39281}/mcp`
const token = cfg.mcp?.token
const OUT = path.join(process.cwd(), 'data', 'dubtest')

let idSeq = 0
async function rpc(method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++idSeq, method, params })
  })
  const text = await res.text()
  if (!text) return { status: res.status, body: null }
  return { status: res.status, body: JSON.parse(text) }
}

async function call(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: { wait: 240, ...args } })
  const result = r.body?.result
  if (!result) throw new Error(`${name} failed: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`)
  const text = result.content?.[0]?.text
  let value = text
  try {
    value = JSON.parse(text)
  } catch {
    // plain text
  }
  if (result.isError) throw new Error(`${name}: ${typeof value === 'string' ? value : JSON.stringify(value).slice(0, 400)}`)
  return value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitJob(v, label) {
  if (!v?.jobId || v.status !== 'running') return v
  let last = ''
  for (;;) {
    const j = await call('job_status', { jobId: v.jobId, wait: 60 })
    const line = `${label}: ${j.status} ${j.progress || ''}`
    if (line !== last) {
      console.log(`  ${line}`)
      last = line
    }
    if (j.status !== 'running') {
      if (j.status === 'error') throw new Error(`${label} failed: ${j.error}`)
      return j.result
    }
    await sleep(1500)
  }
}

function save(name, data) {
  fs.mkdirSync(OUT, { recursive: true })
  const f = path.join(OUT, name)
  fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf-8')
  console.log(`saved ${f}`)
  return f
}

const [cmd, ...rest] = process.argv.slice(2)

if (cmd === 'status') {
  console.log(JSON.stringify(await call('studio_status'), null, 2))
  const models = await call('list_models')
  console.log(JSON.stringify(models.separation, null, 2))
} else if (cmd === 'sep') {
  const r = await waitJob(await call('separate_audio', { sourcePath: rest[0], model: rest[1] }), 'separate')
  console.log(JSON.stringify(r, null, 2))
  save('separate.json', r)
} else if (cmd === 'diarize') {
  const args = { audioPath: rest[0], transcribe: true }
  if (rest[1]) args.numSpeakers = Number(rest[1])
  const r = await waitJob(await call('diarize', args), 'diarize')
  console.log(`speakers=${r.speakers?.length ?? '?'} items=${r.items?.length ?? '?'}`)
  save('diarize.json', r)
} else if (cmd === 'synth') {
  const script = JSON.parse(fs.readFileSync(rest[0], 'utf-8'))
  const outputDir = rest[1]
  const r = await waitJob(
    await call('synthesize_script', {
      outputDir,
      lines: script.lines,
      voice: script.voice,
      textLang: script.textLang || 'zh',
      subtitleFormats: ['srt', 'vtt'],
      params: script.params || { sampleSteps: 8, splitMethod: 'cut0', batchSize: 1 }
    }),
    'synthesize_script'
  )
  console.log(JSON.stringify({ manifest: r.manifest, done: r.done, failed: r.failed, overflow: r.overflow }, null, 2))
  save('synth.json', r)
} else if (cmd === 'voice') {
  const useVocals = rest.includes('--vocals')
  const parts = rest.filter((x) => x !== '--vocals')
  const [src, start, end, name, transcript] = parts
  const v = await call('voice_from_span', {
    sourcePath: src,
    start: Number(start),
    end: Number(end),
    name,
    transcript,
    ...(useVocals ? { useVocals: true } : {})
  })
  console.log(JSON.stringify(v, null, 2))
} else if (cmd === 'asr') {
  const [file, lang] = rest
  const r = await waitJob(await call('transcribe', { files: [file], language: lang || 'zh' }), 'transcribe')
  console.log(JSON.stringify(r).slice(0, 3000))
} else if (cmd === 'build') {
  const items = JSON.parse(fs.readFileSync(path.join(OUT, 'diarize.json'), 'utf-8')).result.items
  const sentences = JSON.parse(fs.readFileSync(rest[0], 'utf-8')).sentences
  const r = await call('build_script', { items, sentences: sentences.map((text) => ({ text })), outputDir: rest[1] })
  const lines = r.lines || []
  console.log(`lines=${lines.length} unmatched=${JSON.stringify(r.unmatched)} leftover=${JSON.stringify(r.leftover || '').slice(0, 60)}`)
  for (const l of lines) console.log(`${l.id} ${l.start.toFixed(2)}-${l.end.toFixed(2)} ${l.matched ? ' ' : '!'} ${l.text}`)
  save('build.json', r)
} else if (cmd === 'burn') {
  const [video, out, primary, secondary, mode] = rest
  const r = await waitJob(
    await call('burn_subtitles', { videoPath: video, outputPath: out, primary, secondary, mode: mode || 'hard' }),
    'burn'
  )
  console.log(JSON.stringify(r, null, 2))
} else if (cmd === 'mix') {
  const r = await waitJob(
    await call('mix_dub', { basePath: rest[0], manifestPath: rest[1], bedPath: rest[2], outputPath: rest[3], bgm: 'replace' }),
    'mix_dub'
  )
  console.log(JSON.stringify(r, null, 2))
} else if (cmd === 'subtitle') {
  const r = await call('export_subtitle', { audioPath: rest[0], formats: ['srt', 'vtt'] })
  console.log(JSON.stringify(r, null, 2))
} else {
  console.log('unknown command: ' + cmd)
  process.exitCode = 1
}
