import http from 'node:http'
import { MCP_PROMPTS, type CallContext, type McpTools } from './tools'

/**
 * MCP server over Streamable HTTP. Bound to 127.0.0.1 only.
 * POST /mcp with a JSON-RPC message or batch. Auth: "Authorization: Bearer <token>".
 * - Plain JSON responses by default.
 * - If a single tools/call carries params._meta.progressToken and the client accepts
 *   text/event-stream, the reply is an SSE stream with notifications/progress events
 *   followed by the final JSON-RPC response.
 * - notifications/cancelled {requestId} cancels the job started by that request.
 */

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: Record<string, unknown> }
type Notify = (method: string, params: Record<string, unknown>) => void

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

const INSTRUCTIONS = [
  'Local GPT-SoVITS v5turbo TTS studio (runs on this PC, GPU queue shared with the app).',
  'Voices: list_voices -> synthesize (one text) or synthesize_script (many lines, manifest.json).',
  'New voices: create_voice from a clean 3-10 s clip, or voice_from_span from a diarize reference.',
  'Long tools (synthesize*, transcribe, diarize, create_voice, separate_audio, mix_dub, burn_subtitles, preview_segments) return a jobId if not done within `wait` s; then call job_status {jobId, wait}. Progress notifications are sent when a progressToken is given.',
  'VRAM: models stay loaded between calls for speed. Do not unload during a multi-step task; call unload_models once the whole task is done (or when the user asks).',
  'Fix single bad sentences: list_segments -> preview_segments -> commit_segment (revert_edits to undo).',
  'Synthesis params: agent default sampleSteps 8 (adjust 4-32 as needed); fragmentInterval = pause between sentences inside one line.',
  'Missing models: list_models shows packs; download_models {packs} fetches them (GBs, confirm with the user first).',
  'Dubbing: separate_audio -> diarize (or import_subtitle) -> build_script (you segment sentences, server times them) -> translate -> synthesize_script with start/end -> mix_dub bgm:replace -> burn_subtitles (bilingual). See prompt localize_video.',
  'Paths must be absolute local paths. See prompts for full workflows.'
].join('\n')

export class McpServer {
  private server: http.Server | null = null
  /** request id -> job id, for notifications/cancelled. */
  private inflight = new Map<string, string>()
  port = 0
  error?: string

  constructor(
    private tools: McpTools,
    private getToken: () => string,
    private version: string
  ) {}

  get running(): boolean {
    return Boolean(this.server?.listening)
  }

  async start(port: number): Promise<void> {
    await this.stop()
    this.error = undefined
    const server = http.createServer((req, res) => void this.handle(req, res).catch(() => res.headersSent || res.writeHead(500).end()))
    server.requestTimeout = 0
    server.headersTimeout = 30_000
    server.keepAliveTimeout = 5_000
    await new Promise<void>((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.error = err.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : err.message
        resolve()
      })
      server.listen(port, '127.0.0.1', () => resolve())
    })
    if (server.listening) {
      this.server = server
      this.port = port
    }
  }

  async stop(): Promise<void> {
    const s = this.server
    this.server = null
    if (s) {
      s.closeAllConnections?.()
      await new Promise<void>((r) => s.close(() => r()))
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, app: 'GPT-SoVITS-Studio', version: this.version }))
      return
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    // Reject browser cross-origin requests (DNS rebinding / CSRF).
    const origin = req.headers.origin
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      res.writeHead(403).end()
      return
    }
    const auth = String(req.headers.authorization || '')
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token') || ''
    if (!token || token !== this.getToken()) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid token' }))
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end()
      return
    }
    if (req.method === 'GET') {
      // No server-initiated stream.
      res.writeHead(405, { allow: 'POST, DELETE' }).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }

    let body = ''
    req.setEncoding('utf8')
    for await (const chunk of req) {
      body += chunk
      if (body.length > 20 * 1024 * 1024) {
        res.writeHead(413).end()
        return
      }
    }
    let msg: Rpc | Rpc[]
    try {
      msg = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify(rpcError(null, -32700, 'Parse error')))
      return
    }
    const headers = { 'mcp-session-id': 'gsv' }
    const wantsSse = String(req.headers.accept || '').includes('text/event-stream')
    const single = !Array.isArray(msg) ? msg : null
    const token0 = single?.method === 'tools/call' ? progressToken(single.params) : undefined

    if (single && wantsSse && token0 !== undefined && single.id !== undefined && single.id !== null) {
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = (obj: unknown): void => {
        if (!res.writableEnded) res.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`)
      }
      let closed = false
      res.on('close', () => (closed = true))
      const reply = await this.dispatch(single, (method, params) => !closed && send({ jsonrpc: '2.0', method, params }))
      if (reply) send(reply)
      res.end()
      return
    }

    const list = Array.isArray(msg) ? msg : [msg]
    if (!list.length) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify(rpcError(null, -32600, 'Empty batch')))
      return
    }
    const replies = (await Promise.all(list.map((m) => this.dispatch(m)))).filter((r) => r !== null)
    if (!replies.length) {
      res.writeHead(202, headers).end()
      return
    }
    res.writeHead(200, { ...headers, 'content-type': 'application/json' })
    res.end(JSON.stringify(Array.isArray(msg) ? replies : replies[0]))
  }

  /** Shared by HTTP and in-process callers. Returns null for notifications. */
  async dispatch(m: Rpc, notify?: Notify): Promise<unknown | null> {
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
      return m && m.id !== undefined && m.id !== null ? rpcError(m.id, -32600, 'Invalid Request') : null
    }
    const isNotification = m.id === undefined || m.id === null
    try {
      const result = await this.method(m.method, m.params || {}, isNotification ? undefined : m.id!, notify)
      return isNotification ? null : { jsonrpc: '2.0', id: m.id, result }
    } catch (error) {
      if (isNotification) return null
      const e = error as { code?: number; message?: string }
      return rpcError(m.id ?? null, typeof e.code === 'number' ? e.code : -32603, e.message || String(error))
    }
  }

  private async method(name: string, p: Record<string, unknown>, id: string | number | undefined, notify?: Notify): Promise<unknown> {
    switch (name) {
      case 'initialize': {
        const asked = typeof p.protocolVersion === 'string' ? p.protocolVersion : ''
        return {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { listChanged: false }, logging: {} },
          serverInfo: { name: 'gpt-sovits-studio', title: 'GPT-SoVITS Studio', version: this.version },
          instructions: INSTRUCTIONS
        }
      }
      case 'ping':
      case 'notifications/initialized':
      case 'logging/setLevel':
        return {}
      case 'notifications/cancelled': {
        const jobId = this.inflight.get(String(p.requestId))
        if (jobId) this.tools.cancel(jobId)
        return {}
      }
      case 'tools/list':
        return { tools: this.tools.list() }
      case 'tools/call': {
        const toolName = String(p.name || '')
        const args = (p.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Record<string, unknown>
        const tok = progressToken(p)
        const key = id === undefined ? '' : String(id)
        const ctx: CallContext = {
          onJob: (jobId) => key && this.inflight.set(key, jobId),
          onProgress:
            tok !== undefined && notify
              ? (pr) => notify('notifications/progress', { progressToken: tok, ...pr })
              : undefined
        }
        try {
          const out = await this.tools.call(toolName, args, ctx)
          const text = JSON.stringify(out, null, 1)
          const structured = out && typeof out === 'object' && !Array.isArray(out) ? { structuredContent: out } : {}
          return { content: [{ type: 'text', text }], ...structured }
        } catch (error) {
          // Tool errors are results, not protocol errors, so the model sees them.
          return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
        } finally {
          if (key) this.inflight.delete(key)
        }
      }
      case 'prompts/list':
        return { prompts: MCP_PROMPTS.map(({ name, description }) => ({ name, description })) }
      case 'prompts/get': {
        const pr = MCP_PROMPTS.find((x) => x.name === p.name)
        if (!pr) throw Object.assign(new Error('Unknown prompt'), { code: -32602 })
        return { description: pr.description, messages: [{ role: 'user', content: { type: 'text', text: pr.text } }] }
      }
      case 'resources/list':
        return { resources: [] }
      case 'resources/templates/list':
        return { resourceTemplates: [] }
      default:
        throw Object.assign(new Error(`Method not found: ${name}`), { code: -32601 })
    }
  }
}

function progressToken(p?: Record<string, unknown>): string | number | undefined {
  const meta = p?._meta as Record<string, unknown> | undefined
  const t = meta?.progressToken
  return typeof t === 'string' || typeof t === 'number' ? t : undefined
}

function rpcError(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
