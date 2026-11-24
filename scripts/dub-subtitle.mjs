/**
 * Combine per-line SRT files from synthesize_script into one subtitle track for the final video.
 * Each line's cues are shifted by its start time on the video timeline.
 * Usage: node scripts/dub-subtitle.mjs <manifest.json> <outputBase>
 */
import fs from 'node:fs'
import path from 'node:path'

const [manifestPath, outputBase] = process.argv.slice(2)
if (!manifestPath || !outputBase) {
  console.log('usage: node scripts/dub-subtitle.mjs <manifest.json> <outputBase>')
  process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
const dir = manifest.outputDir || path.dirname(manifestPath)

function parseSrt(file) {
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, 'utf-8').replace(/\r/g, '')
  const cues = []
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split('\n').filter(Boolean)
    const idx = lines.findIndex((l) => l.includes('-->'))
    if (idx < 0) continue
    const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/.exec(lines[idx])
    if (!m) continue
    const s = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000
    const e = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000
    cues.push({ start: s, end: e, text: lines.slice(idx + 1).join('\n') })
  }
  return cues
}

const all = []
for (const item of manifest.items || []) {
  if (!item.ok || !item.filePath) continue
  for (const cue of parseSrt(item.filePath.replace(/\.[^.]+$/, '.srt'))) {
    all.push({ start: cue.start + (item.start || 0), end: cue.end + (item.start || 0), text: cue.text })
  }
}
all.sort((a, b) => a.start - b.start)

const stamp = (t, sep) => {
  const ms = Math.max(0, Math.round(t * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(ms % 1000).padStart(3, '0')}`
}

const srt = all.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}`).join('\n\n') + '\n'
const vtt = 'WEBVTT\n\n' + all.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text}`).join('\n\n') + '\n'

fs.writeFileSync(`${outputBase}.srt`, srt, 'utf-8')
fs.writeFileSync(`${outputBase}.vtt`, vtt, 'utf-8')
console.log(`cues=${all.length}`)
console.log(`${outputBase}.srt`)
console.log(`${outputBase}.vtt`)
