import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildCues, formatCues, subtitleFor, DEFAULT_SUBTITLE_OPTIONS } from '../src/main/subtitles.ts'

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

const cues = buildCues(timing, DEFAULT_SUBTITLE_OPTIONS)
console.log('CUES:', cues.length)
for (const c of cues) console.log(`  ${c.start.toFixed(2)}-${c.end.toFixed(2)}  ${c.text}`)

const srt = subtitleFor(audio, 'srt')
const ass = subtitleFor(audio, 'ass')
const lrc = subtitleFor(audio, 'lrc')
fs.writeFileSync(path.join(dir, 'demo.srt'), srt)
fs.writeFileSync(path.join(dir, 'demo.ass'), ass)
fs.writeFileSync(path.join(dir, 'demo.lrc'), lrc)

function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) process.exitCode = 1
}

check('BOM on srt', srt.charCodeAt(0) === 0xfeff)
check('srt has arrow', srt.includes(' --> '))
check('srt first cue starts 00:00:00,100', srt.includes('00:00:00,100 -->'))
check('no silent line', !srt.includes('没有声音的一句'))
check('long sentence split', cues.filter((c) => c.start >= 3.5 && c.end <= 9).length >= 2)
check('short neighbour merged', !cues.some((c) => c.text === '好'))
check('trailing punct stripped', cues[0].text === '大家好，今天我们来聊聊语音合成')
check('ass header', ass.includes('[V4+ Styles]') && ass.includes('Dialogue: 0,'))
check('lrc bracket', /^\[\d\d:\d\d\.\d\d\]/m.test(lrc))

const off = buildCues(timing, { ...DEFAULT_SUBTITLE_OPTIONS, offsetMs: 500 })
check('offset applied', Math.abs(off[0].start - cues[0].start - 0.5) < 1e-6)

const noStrip = buildCues(timing, { ...DEFAULT_SUBTITLE_OPTIONS, stripTrailingPunct: false })
check('strip disabled', noStrip[0].text.endsWith('。'))

// Monotonic, non-overlapping cues
let ok = true
for (let i = 1; i < cues.length; i++) if (cues[i].start < cues[i - 1].start) ok = false
check('cues ordered', ok)
check('all cues within duration+offset', cues.every((c) => c.start >= 0 && c.end > c.start))

console.log('\n--- SRT ---')
console.log(srt.replace(/^\ufeff/, ''))
console.log('OUT_DIR=' + dir)
