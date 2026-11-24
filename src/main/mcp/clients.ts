import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpClientInfo } from '@shared/types'

/**
 * stdio bridge + one-click config writers for common MCP harnesses.
 * The bridge runs with the app's own exe (ELECTRON_RUN_AS_NODE=1), reads port/token
 * from data/config.json on every request, and starts the app headless if it is not running.
 */

const SERVER_NAME = 'gpt-sovits-studio'

const BRIDGE_JS = String.raw`// GPT-SoVITS-Studio MCP stdio bridge (auto-generated, do not edit)
const fs = require('fs'), http = require('http'), cp = require('child_process'), readline = require('readline')
const CONFIG = process.env.GSV_CONFIG || require('path').join(__dirname, '..', 'config.json')
const EXE = process.env.GSV_EXE || ''
const APP = process.env.GSV_APP || ''
function cfg() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')).mcp || {} } catch { return {} } }
function out(obj) { process.stdout.write((typeof obj === 'string' ? obj.replace(/\n/g, ' ') : JSON.stringify(obj)) + '\n') }
function post(body) {
  const c = cfg()
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: c.port || 39281, path: '/mcp', method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + (c.token || ''), 'content-length': Buffer.byteLength(body) } }, (res) => {
      res.setEncoding('utf8')
      if (String(res.headers['content-type'] || '').includes('text/event-stream')) {
        // Forward each SSE data event (progress notifications + final reply) as one stdio line.
        let buf = ''
        res.on('data', (d) => {
          buf += d
          let i
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const ev = buf.slice(0, i); buf = buf.slice(i + 2)
            const data = ev.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('')
            if (data) out(data)
          }
        })
        res.on('end', () => resolve({ status: 202, data: '' }))
        return
      }
      let data = ''; res.on('data', (d) => (data += d)); res.on('end', () => resolve({ status: res.statusCode, data }))
    })
    req.setTimeout(0); req.on('error', reject); req.end(body)
  })
}
let launched = false
async function send(body) {
  for (let i = 0; i < 90; i++) {
    try { return await post(body) } catch (e) {
      if (e.code !== 'ECONNREFUSED' && e.code !== 'ECONNRESET') throw e
      if (!launched && EXE && fs.existsSync(EXE)) {
        launched = true
        const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE
        cp.spawn(EXE, (APP ? [APP] : []).concat(['--headless']), { detached: true, stdio: 'ignore', env }).unref()
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw new Error('GPT-SoVITS-Studio is not running and could not be started')
}
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let id = null; try { id = JSON.parse(line).id ?? null } catch {}
  try {
    const r = await send(line)
    if (r.status === 200 && r.data) process.stdout.write(r.data.replace(/\n/g, ' ') + '\n')
    else if (r.status !== 202 && id !== null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'HTTP ' + r.status + ' ' + r.data } }) + '\n')
  } catch (e) {
    if (id !== null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: String(e.message || e) } }) + '\n')
  }
})
rl.on('close', () => setTimeout(() => process.exit(0), 200))
`

export interface BridgeInfo {
  exe: string
  script: string
  configFile: string
  appPath?: string
}

export function ensureBridge(dataRoot: string, exe: string, configFile: string, appPath?: string): BridgeInfo {
  const dir = path.join(dataRoot, 'mcp')
  fs.mkdirSync(dir, { recursive: true })
  const script = path.join(dir, 'gsv-mcp.js')
  if (!fs.existsSync(script) || fs.readFileSync(script, 'utf-8') !== BRIDGE_JS) fs.writeFileSync(script, BRIDGE_JS, 'utf-8')
  const cmd = path.join(dir, 'gsv-mcp.cmd')
  const appLine = appPath ? `set GSV_APP=${appPath}\r\n` : ''
  const cmdBody = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nset GSV_EXE=${exe}\r\n${appLine}set GSV_CONFIG=${configFile}\r\n"${exe}" "${script}"\r\n`
  if (!fs.existsSync(cmd) || fs.readFileSync(cmd, 'utf-8') !== cmdBody) fs.writeFileSync(cmd, cmdBody, 'utf-8')
  return { exe, script, configFile, appPath }
}

type StdioSpec = { command: string; args: string[]; env: Record<string, string> }

function stdioSpec(b: BridgeInfo): StdioSpec {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1', GSV_EXE: b.exe, GSV_CONFIG: b.configFile }
  if (b.appPath) env.GSV_APP = b.appPath
  return { command: b.exe, args: [b.script], env }
}

interface ClientDef {
  id: string
  label: string
  file: () => string
  detect: () => boolean
  format: 'json' | 'toml'
  /** JSON object path where servers live. */
  key?: string[]
  entry: (b: BridgeInfo, url: string, token: string) => unknown
}

const home = os.homedir()
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
const exists = (...p: string[]): boolean => fs.existsSync(path.join(...p))

const CLIENTS: ClientDef[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    file: () => path.join(home, '.claude.json'),
    detect: () => exists(home, '.claude.json') || exists(home, '.claude'),
    format: 'json',
    key: ['mcpServers'],
    entry: (b) => ({ type: 'stdio', ...stdioSpec(b) })
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    file: () => path.join(appData, 'Claude', 'claude_desktop_config.json'),
    detect: () => exists(appData, 'Claude'),
    format: 'json',
    key: ['mcpServers'],
    entry: (b) => stdioSpec(b)
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    file: () => path.join(home, '.codex', 'config.toml'),
    detect: () => exists(home, '.codex'),
    format: 'toml',
    entry: (b) => stdioSpec(b)
  },
  {
    id: 'cursor',
    label: 'Cursor',
    file: () => path.join(home, '.cursor', 'mcp.json'),
    detect: () => exists(home, '.cursor'),
    format: 'json',
    key: ['mcpServers'],
    entry: (_b, url, token) => ({ url, headers: { Authorization: `Bearer ${token}` } })
  },
  {
    id: 'opencode',
    label: 'opencode',
    file: () => path.join(home, '.config', 'opencode', 'opencode.json'),
    detect: () => exists(home, '.config', 'opencode') || exists(home, '.opencode'),
    format: 'json',
    key: ['mcp'],
    entry: (b) => ({ type: 'local', command: [b.exe, b.script], environment: stdioSpec(b).env, enabled: true })
  },
  {
    id: 'kiro',
    label: 'Kiro',
    file: () => path.join(home, '.kiro', 'settings', 'mcp.json'),
    detect: () => exists(home, '.kiro'),
    format: 'json',
    key: ['mcpServers'],
    entry: (b) => ({ ...stdioSpec(b), disabled: false })
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    file: () => path.join(home, '.gemini', 'settings.json'),
    detect: () => exists(home, '.gemini'),
    format: 'json',
    key: ['mcpServers'],
    entry: (b) => stdioSpec(b)
  },
  {
    id: 'vscode',
    label: 'VS Code (Copilot)',
    file: () => path.join(appData, 'Code', 'User', 'mcp.json'),
    detect: () => exists(appData, 'Code', 'User'),
    format: 'json',
    key: ['servers'],
    entry: (_b, url, token) => ({ type: 'http', url, headers: { Authorization: `Bearer ${token}` } })
  },
  {
    id: 'cline',
    label: 'Cline',
    file: () => path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
    detect: () => exists(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'),
    format: 'json',
    key: ['mcpServers'],
    entry: (b) => ({ ...stdioSpec(b), disabled: false })
  }
]

function readJson(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {}
  const text = fs.readFileSync(file, 'utf-8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${file} 不是标准 JSON（可能含注释），请用“复制配置”手动粘贴`)
  }
}

const tomlString = (s: string): string => `'${s.replace(/'/g, "''")}'`

function tomlBlock(spec: StdioSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `${k} = ${tomlString(v)}`)
    .join(', ')
  return `[mcp_servers.${SERVER_NAME}]\ncommand = ${tomlString(spec.command)}\nargs = [${spec.args.map(tomlString).join(', ')}]\nenv = { ${env} }\nstartup_timeout_sec = 120\ntool_timeout_sec = 300\n`
}

function isConfigured(c: ClientDef): boolean {
  try {
    const file = c.file()
    if (!fs.existsSync(file)) return false
    if (c.format === 'toml') return fs.readFileSync(file, 'utf-8').includes(`[mcp_servers.${SERVER_NAME}]`)
    let node: unknown = readJson(file)
    for (const k of c.key || []) node = (node as Record<string, unknown> | undefined)?.[k]
    return Boolean(node && typeof node === 'object' && SERVER_NAME in (node as object))
  } catch {
    return false
  }
}

export function listClients(): McpClientInfo[] {
  return CLIENTS.map((c) => ({ id: c.id, label: c.label, detected: c.detect(), configured: isConfigured(c), configPath: c.file() }))
}

export function clientSnippet(id: string, b: BridgeInfo, url: string, token: string): string {
  const c = CLIENTS.find((x) => x.id === id)
  if (!c) return JSON.stringify({ mcpServers: { [SERVER_NAME]: stdioSpec(b) } }, null, 2)
  if (c.format === 'toml') return tomlBlock(stdioSpec(b))
  const obj: Record<string, unknown> = {}
  let node = obj
  const keys = c.key || []
  keys.forEach((k, i) => {
    node[k] = i === keys.length - 1 ? { [SERVER_NAME]: c.entry(b, url, token) } : {}
    node = node[k] as Record<string, unknown>
  })
  return JSON.stringify(obj, null, 2)
}

export function configureClient(id: string, b: BridgeInfo, url: string, token: string): string {
  const c = CLIENTS.find((x) => x.id === id)
  if (!c) throw new Error(`未知客户端：${id}`)
  const file = c.file()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.gsv-backup`)
  if (c.format === 'toml') {
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
    text = text.replace(new RegExp(`\\n?\\[mcp_servers\\.${SERVER_NAME}\\][\\s\\S]*?(?=\\n\\[|$)`), '')
    fs.writeFileSync(file, `${text.trimEnd()}\n\n${tomlBlock(stdioSpec(b))}`, 'utf-8')
    return file
  }
  const root = readJson(file)
  let node: Record<string, unknown> = root
  for (const k of c.key || []) {
    if (!node[k] || typeof node[k] !== 'object') node[k] = {}
    node = node[k] as Record<string, unknown>
  }
  node[SERVER_NAME] = c.entry(b, url, token)
  fs.writeFileSync(file, JSON.stringify(root, null, 2), 'utf-8')
  return file
}

/** A prompt the user pastes into any agent so it installs the connection itself. */
export function agentSetupPrompt(b: BridgeInfo, url: string, token: string): string {
  const j = (s: string): string => JSON.stringify(s)
  return `请把本机的 GPT-SoVITS-Studio 连接为你的 MCP 服务器（本地 TTS / 语音识别 / 音色库 / 字幕）。

服务器名：${SERVER_NAME}
方式一（推荐，stdio）：
  command: ${j(b.exe)}
  args: [${j(b.script)}]
  env: { "ELECTRON_RUN_AS_NODE": "1", "GSV_EXE": ${j(b.exe)}, "GSV_CONFIG": ${j(b.configFile)} }
方式二（Streamable HTTP）：
  url: ${url}
  header: Authorization: Bearer ${token}

步骤：
1. 判断你所在的客户端（Claude Code / Codex / Cursor / opencode / Kiro / Gemini CLI / VS Code / Cline 等），找到它的 MCP 配置，按该客户端格式加入上面的服务器；有命令行方式（如 claude mcp add）优先用命令行。修改文件前先备份，保留已有的其他服务器。
2. 告诉我是否需要重启客户端；重启后调用 studio_status 和 list_voices 验证。
软件未运行时 stdio 方式会自动以托盘模式启动它。`
}
