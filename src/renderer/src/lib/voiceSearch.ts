import { pinyin } from 'pinyin-pro'

export interface VoiceSearchKey {
  name: string
  initials: string
  full: string
}

const normalize = (value: string): string => value.toLowerCase().replace(/[\s_-]+/g, '')

export function makeVoiceSearchKey(name: string): VoiceSearchKey {
  const text = name.trim()
  let initials = ''
  let full = ''
  try {
    initials = pinyin(text, { pattern: 'first', toneType: 'none', type: 'array' }).join('')
    full = pinyin(text, { toneType: 'none', type: 'array' }).join('')
  } catch {
    // Names can contain unusual characters; direct text matching still works.
  }
  return {
    name: normalize(text),
    initials: normalize(initials),
    full: normalize(full)
  }
}

/** Returns 0 when the voice does not match; higher is a better result. */
export function scoreVoiceMatch(key: VoiceSearchKey, query: string): number {
  const q = normalize(query)
  if (!q) return 1
  if (key.name === q) return 1000
  if (key.name.startsWith(q)) return 850
  if (key.initials === q) return 800
  if (key.initials.startsWith(q)) return 720
  if (key.full.startsWith(q)) return 640
  if (key.name.includes(q)) return 520
  if (key.initials.includes(q)) return 430
  if (key.full.includes(q)) return 360
  return 0
}

export function folderContains(voiceFolder: string, folder: string): boolean {
  if (!folder) return true
  return voiceFolder === folder || voiceFolder.startsWith(`${folder}/`)
}

export function folderLabel(folder: string): string {
  return folder || '根目录'
}

export function parentFolder(folder: string): string {
  const index = folder.lastIndexOf('/')
  return index < 0 ? '' : folder.slice(0, index)
}

export function folderDepth(folder: string): number {
  return folder ? folder.split('/').length : 0
}
