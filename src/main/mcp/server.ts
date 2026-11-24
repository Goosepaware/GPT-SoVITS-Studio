import http from 'node:http'
import { MCP_PROMPTS, type McpTools } from './tools'

/**
 * Minimal MCP server over Streamable HTTP (JSON responses, no SSE stream).
 * POST /mcp with a JSON-RPC message or batch. Auth: "Authorization: Bearer <token>".
 * Bound to 127.0.0.1 only.
 */

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: Record<string, unknown> }

const PROTOCOL = '2025-03-26'

export class McpServer {
  private server: http.Server | null = null
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
    const server = http.createServer((req, res) => void this.handle(req, res))
    server.requestTimeout = 0
    server.headersTimeout = 30_000
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
    if (s) await new Promise<void>((r) => s.close(() => r()))
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
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }

    let body = ''
    for await (const chunk of req) body += chunk
    let msg: Rpc | Rpc[]
    try {
      msg = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify(rpcError(null, -32700, 'Parse error')))
      return
    }
    const list = Array.isArray(msg) ? msg : [msg]
    const replies = (await Promise.all(list.map((m) => this.dispatch(m)))).filter((r) => r !== null)
    if (!replies.length) {
      res.writeHead(202).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'gsv' })
    res.end(JSON.stringify(Array.isArray(msg) ? replies : replies[0]))
  }

  private async dispatch(m: Rpc): Promise<unknown | null> {
    const isNotification = m.id === undefined || m.id === null
    try {
      const result = await this.method(m.method || '', m.params || {})
      return isNotification ? null : { jsonrpc: '2.0', id: m.id, result }
    } catch (error) {
      if (isNotification) return null
      const e = error as { code?: number; message?: string }
      return rpcError(m.id ?? null, typeof e.code === 'number' ? e.code : -32603, e.message || String(error))
    }
  }

  private async method(name: string, p: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'initialize':
        return {
          protocolVersion: typeof p.protocolVersion === 'string' ? p.protocolVersion : PROTOCOL,
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: 'gpt-sovits-studio', version: this.version },
          instructions:
            'Local GPT-SoVITS v5turbo TTS studio. Use list_voices then synthesize / synthesize_script. Long tools return a jobId if not done within `wait` seconds; poll job_status. Subtitles use the input text with real audio timing. Speaker identification is not provided.'
        }
      case 'ping':
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return {}
      case 'tools/list':
        return { tools: this.tools.list() }
      case 'tools/call': {
        const toolName = String(p.name || '')
        const args = (p.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Record<string, unknown>
        try {
          const out = await this.tools.call(toolName, args)
          return { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] }
        } catch (error) {
          // Tool errors are results, not protocol errors, so the model sees them.
          return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
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
      default:
        throw Object.assign(new Error(`Method not found: ${name}`), { code: -32601 })
    }
  }
}

function rpcError(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
