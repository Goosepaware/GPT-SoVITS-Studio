/** Create the v1.0.0 GitHub release and upload the UI package (uses GH_TOKEN from the env). */
import fs from 'node:fs'

const REPO = 'Goosepaware/GPT-SoVITS-Studio'
const TAG = 'v1.0.0'
const NAME = 'GPT-SoVITS-Studio v1.0.0 · UI 版'
const BODY = fs.readFileSync('D:\\program\\tts\\GPT-SoVITS-Studio-src\\dist\\release-notes-1.0.0.md', 'utf-8')
const ASSET = 'D:\\program\\tts\\GPT-SoVITS-Studio-src\\dist\\GPT-SoVITS-Studio-1.0.0-ui.7z'
const token = process.env.GH_TOKEN
if (!token) throw new Error('GH_TOKEN missing')

const api = async (method, url, body, headers = {}) => {
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'gsv-release', ...headers },
    body
  })
  const text = await r.text()
  return { status: r.status, json: text ? (() => { try { return JSON.parse(text) } catch { return text } })() : null }
}

const me = await api('GET', 'https://api.github.com/user')
console.log('auth', me.status, me.json?.login || String(me.json).slice(0, 120))

let rel = await api('GET', `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`)
if (rel.status === 200) {
  console.log('release exists', rel.json.id, rel.json.html_url)
  rel = await api('PATCH', `https://api.github.com/repos/${REPO}/releases/${rel.json.id}`, JSON.stringify({ name: NAME, body: BODY, draft: false, prerelease: false }), { 'content-type': 'application/json' })
} else {
  rel = await api(
    'POST',
    `https://api.github.com/repos/${REPO}/releases`,
    JSON.stringify({ tag_name: TAG, target_commitish: 'main', name: NAME, body: BODY, draft: false, prerelease: false }),
    { 'content-type': 'application/json' }
  )
}
console.log('release', rel.status, rel.json.html_url || JSON.stringify(rel.json).slice(0, 300))
if (rel.status >= 300) process.exit(1)

const assets = await api('GET', `https://api.github.com/repos/${REPO}/releases/${rel.json.id}/assets`)
const existing = (assets.json || []).find((a) => a.name === 'GPT-SoVITS-Studio-1.0.0-ui.7z')
if (existing) {
  console.log('asset already uploaded', existing.browser_download_url)
} else {
  const url = `https://uploads.github.com/repos/${REPO}/releases/${rel.json.id}/assets?name=${encodeURIComponent('GPT-SoVITS-Studio-1.0.0-ui.7z')}`
  const buf = fs.readFileSync(ASSET)
  console.log('uploading', (buf.length / 1024 / 1024).toFixed(1), 'MB ...')
  const up = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/octet-stream',
      'content-length': String(buf.length),
      'user-agent': 'gsv-release'
    },
    body: buf
  })
  const j = await up.json().catch(() => null)
  console.log('asset', up.status, j?.browser_download_url || JSON.stringify(j).slice(0, 300))
}
console.log('PAGE', rel.json.html_url)
