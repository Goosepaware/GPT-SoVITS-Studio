/**
 * Model packs: what ships with the app, what can be downloaded, and the resumable downloader.
 *
 * Only the big files are downloadable (that is what keeps the slim package small); small or
 * hard-to-mirror files (FSMN-VAD, CAM++) stay in the package and are only listed for repair.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ModelPackInfo } from '@shared/types'

export type PackId = 'tts-core' | 'g2pw' | 'langdetect' | 'asr-sensevoice' | 'asr-vad' | 'asr-spk'

interface PackFile {
  /** Path inside the HF repo (or the single remote name). */
  rel: string
  /** Path relative to the engine root. Defaults to `<targetDir>/<basename(rel)>`. */
  target?: string
  size?: number
  sha256?: string
}

interface PackDef {
  id: PackId
  label: string
  note: string
  group: 'tts' | 'asr'
  /** HF repo; served by both huggingface.co and hf-mirror.com. */
  repo?: string
  /** Absolute URLs (no mirror). Tried in order after the HF sources. */
  urls?: string[]
  /** Directory under the engine root that receives the files. */
  targetDir: string
  files: PackFile[]
  /** Shipped in the slim package; downloading only repairs a deleted folder. */
  bundled?: boolean
}

const PM = 'GPT_SoVITS/pretrained_models'

export const PACKS: PackDef[] = [
  {
    id: 'tts-core',
    label: 'GPT-SoVITS v5turbo 主模型',
    note: 'GPT 基座、SoVITS turbo 权重、声码器、HuBERT 与中文 RoBERTa',
    group: 'tts',
    repo: 'lj1995/GPT-SoVITS',
    targetDir: PM,
    files: [
      { rel: 's1v3.ckpt', target: `${PM}/s1v3.ckpt`, size: 155284856, sha256: '87133414860ea14ff6620c483a3db5ed07b44be42e2c3fcdad65523a729a745a' },
      {
        rel: 'gsv-v5-pretrained/s2Gv5turbo.pth',
        target: `${PM}/gsv-v5-pretrained/s2Gv5turbo.pth`,
        size: 766406144,
        sha256: '287b32a06b7d486f5303ec520468b0728fb01aac8b0f5d86fd5455c9a1d3e022'
      },
      {
        rel: 'gsv-v5-pretrained/vocoder.pth',
        target: `${PM}/gsv-v5-pretrained/vocoder.pth`,
        size: 57761163,
        sha256: 'b7543c83222aa2105bb4efb56845086bc5f2eeba61243d723ffa062052b3221f'
      },
      {
        rel: 'chinese-hubert-base/pytorch_model.bin',
        target: `${PM}/chinese-hubert-base/pytorch_model.bin`,
        size: 188811417,
        sha256: '24164f129c66499d1346e2aa55f183250c223161ec2770c0da3d3b08cf432d3c'
      },
      { rel: 'chinese-hubert-base/config.json', target: `${PM}/chinese-hubert-base/config.json`, size: 1449 },
      { rel: 'chinese-hubert-base/preprocessor_config.json', target: `${PM}/chinese-hubert-base/preprocessor_config.json`, size: 212 },
      {
        rel: 'chinese-roberta-wwm-ext-large/pytorch_model.bin',
        target: `${PM}/chinese-roberta-wwm-ext-large/pytorch_model.bin`,
        size: 651225145,
        sha256: 'e53a693acc59ace251d143d068096ae0d7b79e4b1b503fa84c9dcf576448c1d8'
      },
      { rel: 'chinese-roberta-wwm-ext-large/config.json', target: `${PM}/chinese-roberta-wwm-ext-large/config.json`, size: 963 },
      { rel: 'chinese-roberta-wwm-ext-large/tokenizer.json', target: `${PM}/chinese-roberta-wwm-ext-large/tokenizer.json`, size: 268962 }
    ]
  },
  {
    id: 'g2pw',
    label: '中文多音字 G2PW',
    note: '中文断句与多音字标注，缺了中文发音会出错',
    group: 'tts',
    repo: 'iqt-voice/G2PWModel',
    targetDir: 'GPT_SoVITS/text/G2PWModel',
    files: [
      { rel: 'g2pW.onnx', size: 635212732 },
      { rel: 'config.py', size: 347 },
      { rel: 'MONOPHONIC_CHARS.txt', size: 120779 },
      { rel: 'POLYPHONIC_CHARS.txt', size: 102449 },
      { rel: 'bopomofo_to_pinyin_wo_tune_dict.json', size: 7739 },
      { rel: 'char_bopomofo_dict.json', size: 1851143 },
      { rel: 'version', size: 5 }
    ]
  },
  {
    id: 'langdetect',
    label: '语种识别模型',
    note: 'fastText lid.176，自动语种检测用；只有官方地址，没有镜像',
    group: 'tts',
    urls: ['https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin'],
    targetDir: `${PM}/fast_langdetect`,
    files: [{ rel: 'lid.176.bin', size: 131266198 }]
  },
  {
    id: 'asr-sensevoice',
    label: 'SenseVoice 语音识别',
    note: '中 / 英 / 日 / 韩 / 粤 识别模型',
    group: 'asr',
    repo: 'FunAudioLLM/SenseVoiceSmall',
    targetDir: 'models/asr/SenseVoiceSmall',
    files: [
      // TODO: add the full 64-char sha256 once known; verified by size only for now.
      { rel: 'model.pt', size: 936291369 },
      { rel: 'config.yaml', size: 1855 },
      { rel: 'configuration.json', size: 396 },
      { rel: 'am.mvn', size: 11203 },
      { rel: 'chn_jpn_yue_eng_ko_spectok.bpe.model', size: 377341 }
    ]
  },
  {
    id: 'asr-vad',
    label: 'FSMN-VAD 静音检测',
    note: '随包附带的辅助模型，删掉了可以重新下载',
    group: 'asr',
    repo: 'funasr/fsmn-vad',
    targetDir: 'models/asr/fsmn-vad',
    bundled: true,
    files: [
      { rel: 'model.pt', size: 1721366 },
      { rel: 'config.yaml', size: 1215 },
      { rel: 'configuration.json', size: 365 },
      { rel: 'am.mvn', size: 8033 }
    ]
  },
  {
    id: 'asr-spk',
    label: 'CAM++ 说话人分离',
    note: '随包附带（你说要保留），删掉了也可以重新下载',
    group: 'asr',
    repo: 'funasr/campplus',
    targetDir: 'models/asr/campplus',
    bundled: true,
    files: [
      { rel: 'campplus_cn_common.bin', size: 28036335 },
      { rel: 'config.yaml', size: 537 },
      { rel: 'configuration.json', size: 581 }
    ]
  }
]

/** sha256 values shortened in the table above (I only need the length check for these). */
function expectedSha(file: PackFile): string | undefined {
  return file.sha256 && file.sha256.length === 64 ? file.sha256 : undefined
}

export interface PackState {
  received: number
  total: number
  file: string
  controller: AbortController
}

const active = new Map<PackId, PackState>()

export function packFilePaths(engineRoot: string, pack: PackDef): { remote: PackFile; local: string }[] {
  return pack.files.map((f) => ({
    remote: f,
    local: path.join(engineRoot, f.target || path.join(pack.targetDir, path.basename(f.rel)))
  }))
}

function fileOk(local: string, remote: PackFile): boolean {
  try {
    const st = fs.statSync(local)
    if (!st.isFile() || st.size === 0) return false
    if (!remote.size) return true
    // Config files are tiny; model weights from another source can differ by a hair.
    // Partial downloads never reach this path (they stay in `<file>.part`).
    const slack = Math.max(8, Math.floor(remote.size * 0.02))
    return Math.abs(st.size - remote.size) <= slack
  } catch {
    return false
  }
}

export function packStatus(engineRoot: string): ModelPackInfo[] {
  return PACKS.map((pack) => {
    const files = packFilePaths(engineRoot, pack)
    const missing = files.filter((f) => !fileOk(f.local, f.remote))
    const total = files.reduce((a, f) => a + (f.remote.size || 0), 0)
    const missingBytes = missing.reduce((a, f) => a + (f.remote.size || 0), 0)
    const dl = active.get(pack.id)
    return {
      id: pack.id,
      label: pack.label,
      note: pack.note,
      group: pack.group,
      bundled: pack.bundled === true,
      installed: missing.length === 0,
      totalBytes: total,
      missingBytes,
      downloading: dl ? { received: dl.received, total: dl.total, file: dl.file } : null
    }
  })
}

function sourceUrls(pack: PackDef, remote: PackFile, source: 'hf' | 'mirror'): string[] {
  const urls: string[] = []
  if (pack.repo) {
    const host = source === 'hf' ? 'https://huggingface.co' : 'https://hf-mirror.com'
    urls.push(`${host}/${pack.repo}/resolve/main/${remote.rel}`)
    // Fall back to the other mirror if the first one fails.
    const other = source === 'hf' ? 'https://hf-mirror.com' : 'https://huggingface.co'
    urls.push(`${other}/${pack.repo}/resolve/main/${remote.rel}`)
  }
  for (const u of pack.urls || []) urls.push(u)
  return urls
}

async function fetchTo(url: string, local: string, remote: PackFile, onProgress: (received: number, total: number) => void, signal: AbortSignal): Promise<void> {
  const part = `${local}.part`
  fs.mkdirSync(path.dirname(local), { recursive: true })
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0
  const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const resumed = res.status === 206
  const len = Number(res.headers.get('content-length')) || 0
  let received = resumed ? have : 0
  const total = len ? received + len : remote.size || 0
  const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' })
  try {
    const reader = res.body.getReader()
    let last = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once('drain', () => r()))
      received += value.byteLength
      const now = Date.now()
      if (now - last > 200) {
        last = now
        onProgress(received, total)
      }
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()))
  }
  if (remote.size && fs.statSync(part).size !== remote.size) throw new Error(`大小不符（应为 ${remote.size} 字节）`)
  const sha = expectedSha(remote)
  if (sha) {
    const hash = await new Promise<string>((resolve, reject) => {
      const h = crypto.createHash('sha256')
      fs.createReadStream(part)
        .on('data', (c) => h.update(c))
        .on('error', reject)
        .on('end', () => resolve(h.digest('hex')))
    })
    if (hash !== sha) {
      fs.rmSync(part)
      throw new Error('校验失败（sha256 不匹配），已删除文件')
    }
  }
  fs.renameSync(part, local)
  onProgress(total, total)
}

/** Download one pack (skipping files already present). Progress is reported per file. */
export async function downloadPack(
  engineRoot: string,
  id: PackId,
  source: 'hf' | 'mirror',
  onProgress: (p: { file: string; received: number; total: number }) => void
): Promise<string[]> {
  const pack = PACKS.find((p) => p.id === id)
  if (!pack) throw new Error(`未知的模型包: ${id}`)
  if (active.has(id)) throw new Error('该模型包正在下载')
  const controller = new AbortController()
  const files = packFilePaths(engineRoot, pack).filter((f) => !fileOk(f.local, f.remote))
  if (!files.length) return []
  const done: string[] = []
  let idx = 0
  active.set(id, { received: 0, total: files.reduce((a, f) => a + (f.remote.size || 0), 0), file: '', controller })
  try {
    for (const f of files) {
      const label = path.basename(f.local)
      const state = active.get(id)
      if (state) state.file = label
      let lastErr: unknown = null
      for (const url of sourceUrls(pack, f.remote, source)) {
        try {
          await fetchTo(
            url,
            f.local,
            f.remote,
            (received, total) => {
              const st = active.get(id)
              if (!st) return
              st.received = received
              st.total = total
              onProgress({ file: label, received, total })
            },
            controller.signal
          )
          lastErr = null
          break
        } catch (error) {
          lastErr = error
          if (controller.signal.aborted) throw new Error('下载已取消')
        }
      }
      if (lastErr) throw new Error(`${label}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
      done.push(f.local)
      idx++
      if (idx < files.length) {
        // Progress for the next file starts from zero.
        const st = active.get(id)
        if (st) st.received = 0
      }
    }
    return done
  } finally {
    active.delete(id)
  }
}

export function cancelPack(id: PackId): void {
  active.get(id)?.controller.abort()
}

export function packById(id: string): PackDef | undefined {
  return PACKS.find((p) => p.id === id)
}

/** Strip a downloaded model set back out (keeps the folders and any user files). */
export function removePack(engineRoot: string, id: PackId): void {
  const pack = PACKS.find((p) => p.id === id)
  if (!pack) return
  for (const f of packFilePaths(engineRoot, pack)) {
    if (!path.resolve(f.local).startsWith(path.resolve(engineRoot))) continue
    for (const p of [f.local, `${f.local}.part`]) {
      try {
        if (fs.existsSync(p)) fs.rmSync(p)
      } catch {
        // ignore
      }
    }
  }
}
