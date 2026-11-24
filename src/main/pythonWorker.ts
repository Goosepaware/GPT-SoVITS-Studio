import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { EngineName, EngineStatus, WorkerEvent } from '@shared/types'

export class CancelledError extends Error {
  constructor() {
    super('任务已取消')
    this.name = 'CancelledError'
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface Options {
  engine: EngineName
  engineRoot: string
  pythonDir: string
  dataDir: string
  logsDir: string
  script: string
}

export class PythonWorker extends EventEmitter {
  readonly engine: EngineName
  private options: Options
  private proc: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, Pending>()
  private requestSeq = 0
  private logStream: fs.WriteStream | null = null
  private stopping = false
  status: EngineStatus

  constructor(options: Options) {
    super()
    this.options = options
    this.engine = options.engine
    this.status = {
      engine: options.engine,
      state: 'stopped',
      models: {}
    }
  }

  private emitEvent(event: WorkerEvent): void {
    this.emit('event', event)
  }

  private setStatus(patch: Partial<EngineStatus>): void {
    const normalized: Partial<EngineStatus> = { ...patch }
    if ((patch.state === 'ready' || patch.state === 'stopped') && patch.message === undefined) {
      normalized.message = ''
    }
    this.status = { ...this.status, ...normalized, engine: this.engine }
    this.emitEvent({ type: 'status', engine: this.engine, status: normalized })
  }

  private openLog(): void {
    if (this.logStream) return
    fs.mkdirSync(this.options.logsDir, { recursive: true })
    const file = path.join(this.options.logsDir, `${this.engine}.log`)
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 8 * 1024 * 1024) {
        fs.renameSync(file, `${file}.1`)
      }
    } catch {
      // ignore
    }
    this.logStream = fs.createWriteStream(file, { flags: 'a' })
  }

  private writeLog(line: string): void {
    const time = new Date().toISOString()
    this.openLog()
    this.logStream?.write(`[${time}] ${line}\n`)
  }

  start(): void {
    if (this.proc && this.proc.exitCode === null) return
    this.stopping = false
    const script = path.join(this.options.pythonDir, this.options.script)
    const python = path.join(this.options.engineRoot, 'runtime', 'python.exe')
    if (!fs.existsSync(python)) {
      this.setStatus({ state: 'error', message: `找不到 Python 运行时: ${python}` })
      throw new Error(`找不到 Python 运行时: ${python}`)
    }
    if (!fs.existsSync(script)) {
      this.setStatus({ state: 'error', message: `找不到 worker 脚本: ${script}` })
      throw new Error(`找不到 worker 脚本: ${script}`)
    }
    this.setStatus({ state: 'starting', message: '启动推理进程', models: {}, pid: undefined, vram: undefined })
    this.openLog()
    this.writeLog(`starting ${script}`)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      PATH: `${path.join(this.options.engineRoot, 'runtime')};${process.env.PATH || ''}`,
      HF_HOME: path.join(this.options.dataDir, 'cache', 'huggingface'),
      MODELSCOPE_CACHE: path.join(this.options.dataDir, 'cache', 'modelscope'),
      TORCH_HOME: path.join(this.options.dataDir, 'cache', 'torch')
    }
    const proc = spawn(python, ['-I', '-u', '-X', 'utf8', script, '--engine-root', this.options.engineRoot, '--data-dir', this.options.dataDir], {
      cwd: this.options.engineRoot,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.proc = proc
    // EPIPE after the child dies arrives asynchronously; without a listener it crashes the main process.
    proc.stdin.on('error', (error) => {
      this.writeLog(`stdin error: ${error.message}`)
    })
    proc.stdout.setEncoding('utf8')
    const stdout = readline.createInterface({ input: proc.stdout })
    stdout.on('line', (line) => this.handleStdout(line))
    let stderrBuffer = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk
      const parts = stderrBuffer.split(/\r?\n|\r/)
      stderrBuffer = parts.pop() || ''
      for (const part of parts) {
        const line = part.trimEnd()
        if (!line.trim()) continue
        this.writeLog(line)
        this.emitEvent({ type: 'log', engine: this.engine, line })
      }
    })
    proc.on('error', (error) => {
      this.writeLog(`process error: ${error.message}`)
      this.setStatus({ state: 'error', message: error.message })
    })
    proc.on('exit', (code, signal) => {
      const wasStopping = this.stopping
      this.proc = null
      this.stopping = false
      this.writeLog(`exited code=${code} signal=${signal}`)
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error(wasStopping ? '引擎已卸载' : `推理进程意外退出 (code ${code})`))
        this.pending.delete(id)
      }
      this.setStatus({
        state: code === 0 || wasStopping ? 'stopped' : 'error',
        models: {},
        pid: undefined,
        vram: undefined,
        message: wasStopping ? '已释放模型和显存' : code === 0 ? undefined : `进程退出 code=${code}`
      })
    })
  }

  private handleStdout(line: string): void {
    if (!line.trim()) return
    let event: WorkerEvent
    try {
      event = JSON.parse(line) as WorkerEvent
    } catch {
      this.writeLog(`[protocol] ${line}`)
      return
    }
    if (!event.type) return
    if (event.type === 'worker-ready') {
      this.setStatus({ state: 'starting', pid: event.pid })
      this.emitEvent(event)
      return
    }
    if (event.type === 'status') {
      const status = event.status || {}
      this.setStatus({ ...status, engine: this.engine })
      return
    }
    if (event.type === 'result') {
      const pending = event.id ? this.pending.get(event.id) : undefined
      if (pending && event.id) {
        clearTimeout(pending.timer)
        this.pending.delete(event.id)
        pending.resolve(event.data)
      }
      this.emitEvent(event)
      return
    }
    if (event.type === 'error') {
      const pending = event.id ? this.pending.get(event.id) : undefined
      if (pending && event.id) {
        clearTimeout(pending.timer)
        this.pending.delete(event.id)
        pending.reject(new Error(event.message || '推理失败'))
      }
      this.emitEvent(event)
      return
    }
    if (event.type === 'cancelled') {
      const pending = event.id ? this.pending.get(event.id) : undefined
      if (pending && event.id) {
        clearTimeout(pending.timer)
        this.pending.delete(event.id)
        pending.reject(new CancelledError())
      }
      this.emitEvent(event)
      return
    }
    this.emitEvent(event)
  }

  request<T>(command: string, payload: Record<string, unknown> = {}, timeoutMs = 60 * 60 * 1000): Promise<T> {
    this.start()
    const proc = this.proc
    if (!proc) return Promise.reject(new Error('推理进程未启动'))
    const id = `${this.engine}-${Date.now()}-${++this.requestSeq}`
    const message = JSON.stringify({ cmd: command, id, ...payload }) + '\n'
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`任务超时（${Math.round(timeoutMs / 1000)} 秒）`))
        // Stop the GPU work too, otherwise the next queued job runs concurrently.
        this.send('cancel', { id })
        setTimeout(() => {
          if (this.proc === proc && this.pending.size === 0) {
            void this.unload('任务超时，已释放模型').catch(() => undefined)
          }
        }, 10_000)
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      try {
        proc.stdin.write(message, (error) => {
          if (!error || !this.pending.has(id)) return
          clearTimeout(timer)
          this.pending.delete(id)
          reject(error)
        })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error as Error)
      }
    })
  }

  send(command: string, payload: Record<string, unknown> = {}): void {
    if (!this.proc) return
    try {
      this.proc.stdin.write(JSON.stringify({ cmd: command, ...payload }) + '\n')
    } catch {
      // ignore
    }
  }

  async unload(reason = '手动卸载'): Promise<void> {
    if (!this.proc) {
      this.setStatus({ state: 'stopped', models: {}, pid: undefined, vram: undefined, message: reason })
      return
    }
    await this.shutdown(reason)
  }

  private shutdown(reason: string): Promise<void> {
    const proc = this.proc
    if (!proc) return Promise.resolve()
    this.stopping = true
    this.setStatus({ state: 'stopping', message: reason })
    return new Promise((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        resolve()
      }
      proc.once('exit', finish)
      this.send('shutdown')
      setTimeout(() => {
        if (this.proc) {
          this.writeLog('graceful shutdown timed out, killing process tree')
          try {
            spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true })
          } catch {
            proc.kill()
          }
        }
      }, 1800)
      setTimeout(finish, 4000)
    })
  }

  getStatus(): EngineStatus {
    return this.status
  }
}
