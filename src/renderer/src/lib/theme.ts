import type { ThemeMode } from '@shared/types'

export type ResolvedTheme = 'dark' | 'light' | 'mono-dark' | 'mono-light'

const darkQuery = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

export function resolveTheme(theme: ThemeMode): ResolvedTheme {
  if (theme === 'color-system') return darkQuery().matches ? 'dark' : 'light'
  if (theme === 'mono-system') return darkQuery().matches ? 'mono-dark' : 'mono-light'
  return theme
}

export function applyTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = resolveTheme(theme)
}

export function watchSystemTheme(theme: ThemeMode, onChange: () => void): () => void {
  if (theme !== 'color-system' && theme !== 'mono-system') return () => {}
  const query = darkQuery()
  const listener = (): void => onChange()
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}
