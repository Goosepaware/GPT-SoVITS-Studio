import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AsrFileResult } from '@shared/types'

export function ffmpegPath(engineRoot: string): string {
  return path.join(engineRoot, 'runtime', 'ffmpeg.exe')
}

export function ffprobePath(engineRoot: string): string {
  return path.join(engineRoot, 'runtime', 'ffprobe.exe')
}

export function run(command: string, args: string[], timeoutMs = 0): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (result: { code: number; stdout: string; stderr: string }): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            try {
              if (proc.pid) spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true })
            } catch {
              proc.kill()
            }
            finish({ code: -1, stdout, stderr: `${stderr}\n[超时 ${Math.round(timeoutMs / 1000)} 秒，已终止：${path.basename(command)} ${args.join(' ').slice(0, 400)}]` })
          }, timeoutMs)
        : null
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    proc.on('error', (error) => finish({ code: -1, stdout, stderr: error.message }))
    proc.on('exit', (code) => finish({ code: code ?? -1, stdout, stderr }))
  })
}

export async function getDuration(engineRoot: string, file: string): Promise<number> {
  const probe = ffprobePath(engineRoot)
  const result = await run(probe, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    file
  ])
  const value = Number.parseFloat(result.stdout.trim())
  return Number.isFinite(value) ? value : 0
}

export async function prepareReference(
  engineRoot: string,
  sourcePath: string,
  tempDir: string
): Promise<{ path: string; duration: number; name: string }> {
  if (!fs.existsSync(sourcePath)) throw new Error(`音频文件不存在: ${sourcePath}`)
  fs.mkdirSync(tempDir, { recursive: true })
  const stat = fs.statSync(sourcePath)
  const hash = crypto
    .createHash('sha1')
    .update(`${sourcePath}:${stat.size}:${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 12)
  const output = path.join(tempDir, `ref-${hash}.wav`)
  if (!fs.existsSync(output)) {
    const result = await run(ffmpegPath(engineRoot), [
      '-y',
      '-i',
      sourcePath,
      '-vn',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      output
    ])
    if (result.code !== 0) {
      throw new Error(`音频转码失败: ${result.stderr.slice(-600)}`)
    }
  }
  const duration = await getDuration(engineRoot, output)
  return { path: output, duration, name: path.basename(sourcePath) }
}

export function mimeForFile(file: string): string {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.ogg') return 'audio/ogg'
  if (ext === '.flac') return 'audio/flac'
  if (ext === '.m4a' || ext === '.aac') return 'audio/mp4'
  return 'application/octet-stream'
}

export async function exportMp3(engineRoot: string, sourcePath: string): Promise<string> {
  if (!fs.existsSync(sourcePath)) throw new Error('源音频不存在')
  const parsed = path.parse(sourcePath)
  let output = path.join(parsed.dir, `${parsed.name}.mp3`)
  let index = 1
  while (fs.existsSync(output)) {
    output = path.join(parsed.dir, `${parsed.name}-${index++}.mp3`)
  }
  const result = await run(ffmpegPath(engineRoot), [
    '-y',
    '-i',
    sourcePath,
    '-vn',
    '-codec:a',
    'libmp3lame',
    '-b:a',
    '192k',
    output
  ])
  if (result.code !== 0) throw new Error(`MP3 导出失败: ${result.stderr.slice(-600)}`)
  return output
}

export function formatAsrFile(items: AsrFileResult[], format: 'list' | 'txt'): string {
  if (format === 'txt') {
    return items.map((item) => `${item.name}\t${item.text}`).join('\n') + '\n'
  }
  return (
    items
      .map((item) => {
        const folder = path.basename(path.dirname(item.path))
        const lang = (item.language || 'auto').toUpperCase()
        return `${item.path}|${folder}|${lang}|${item.text}`
      })
      .join('\n') + '\n'
  )
}
