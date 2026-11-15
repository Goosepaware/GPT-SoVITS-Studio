export function scrollWithinContent(element: HTMLElement | null, align: 'start' | 'center' = 'center'): void {
  if (!element) return
  const pane = element.closest('.page-pane') as HTMLElement | null
  if (pane && !pane.classList.contains('active')) return
  const container = element.closest('.content-scroll') as HTMLElement | null
  if (!container) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
  }
  const rect = element.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  const offset = align === 'center' ? Math.max(0, container.clientHeight / 2 - element.clientHeight / 2) : 16
  const top = container.scrollTop + (rect.top - containerRect.top) - offset
  container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}
