import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildCues, formatCues, subtitleFor, writeSubtitles } from '../src/main/subtitles.ts'

const OPT = {
  autoExport: false,
  autoFormats: ['srt' as const],
  defaultFormat: 'srt' as const,
  maxChars: 18,
  minChars: 4,
  minDuration: 0.8,
  stripTrailingPunct: true,
  offsetMs: 0,
  assFont: 'Microsoft YaHei',
  assFontSize: 64
}

const dir = path.join(os.tmpdir(), 'gsv-sub-test')
fs.mkdirSync(dir, { recursive: true })

const timing = {
  version: 1,
  duration: 9,
  segments: [
    { index: 0, text: '大家好，今天我们来聊聊语音合成。', start: 0, end: 3.2, voicedStart: 0.1, voicedEnd: 3.1, pauses: [], flags: [] },
    {
      index: 1,
      text: '这个工具可以把文字变成非常自然的声音，而且完全在本地运行不用联网也不需要上传任何数据',
      start: 3.5,
      end: 9,
      voicedStart: 3.55,
      voicedEnd: 8.95,
      pauses: [4.9, 6.4, 7.8],
      flags: []
    },
    { index: 2, text: '好', start: 9.3, end: 9.6, voicedStart: 9.32, voicedEnd: 9.55, pauses: [], flags: [] },
    { index: 3, text: '没有声音的一句', start: 9.9, end: 10.1, voicedStart: 9.9, voicedEnd: 10.0, pauses: [], flags: ['silent'] }
  ]
}
const audio = path.join(dir, 'demo.wav')
fs.writeFileSync(audio, '')
fs.writeFileSync(path.join(dir, 'demo.timing.json'), JSON.stringify(timing))

const cues = buildCues(timing as never, OPT as never)
console.log('CUES:', cues.length)
for (const c of cues) console.log(`  ${c.start.toFixed(2)}-${c.end.toFixed(2)}  ${c.text}`)

function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) process.exitCode = 1
}

const srt = subtitleFor(audio, 'srt', OPT as never)
check('BOM on srt', srt.charCodeAt(0) === 0xfeff)
check('srt has arrow', srt.includes(' --> '))
check('srt first cue starts 00:00:00,100', srt.includes('00:00:00,100 -->'))
check('no silent line', !srt.includes('没有声音的一句'))
check('long sentence split', cues.filter((c) => c.start >= 3.5 && c.end <= 9).length >= 2)
check('short neighbour merged', !cues.some((c) => c.text === '好'))
check('trailing punct stripped', cues[0].text === '大家好，今天我们来聊聊语音合成')
check('no line starts with punctuation', !cues.some((c) => /^[，,、；;：:。.！!？?…]/.test(c.text)))

const asss = subtitleFor(audio, 'ass', OPT as never)
check('ass header + font', asss.includes('[V4+ Styles]') && asss.includes('Microsoft YaHei') && asss.includes('Dialogue: 0,'))
const vtt = subtitleFor(audio, 'vtt', OPT as never)
check('vtt header', vtt.replace(/^\ufeff/, '').startsWith('WEBVTT') && /\d\d:\d\d:\d\d\.\d{3} --> /.test(vtt))
const lrc = subtitleFor(audio, 'lrc', OPT as never)
check('lrc bracket', /^\[\d\d:\d\d\.\d\d\]/m.test(lrc))
const txt = subtitleFor(audio, 'txt', OPT as never)
check('txt = one line per cue', txt.replace(/^\ufeff/, '').trim().split(/\r?\n/).length === cues.length)
const json = subtitleFor(audio, 'json', OPT as never)
check('json keeps segments', JSON.parse(json.replace(/^\ufeff/, '')).segments.length === 4)

const off = buildCues(timing as never, { ...OPT, offsetMs: 500 } as never)
check('offset applied', Math.abs(off[0].start - cues[0].start - 0.5) < 1e-6)
const noStrip = buildCues(timing as never, { ...OPT, stripTrailingPunct: false } as never)
check('strip disabled', noStrip[0].text.endsWith('。'))

let ordered = true
for (let i = 1; i < cues.length; i++) if (cues[i].start < cues[i - 1].start) ordered = false
check('cues ordered', ordered)
check('all cues valid', cues.every((c) => c.start >= 0 && c.end > c.start))

const written = writeSubtitles(audio, ['srt', 'ass', 'vtt', 'lrc', 'txt', 'json'], OPT as never, dir)
check('writes all 6 formats', written.length === 6 && written.every((f) => fs.existsSync(f)))
check('json sidecar untouched', fs.readFileSync(path.join(dir, 'demo.timing.json'), 'utf-8').includes('"segments"'))

console.log('\n--- SRT ---')
console.log(srt.replace(/^\ufeff/, ''))
console.log('OUT_DIR=' + dir)
