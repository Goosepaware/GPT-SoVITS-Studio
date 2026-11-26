import { useEffect, useState } from 'react'

export function useAudioUrl(filePath: string | null | undefined): { url: string | null; loading: boolean; error: string | null } {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    let objectUrl: string | null = null
    setError(null)
    if (!filePath) {
      setUrl(null)
      setLoading(false)
      return
    }
    setLoading(true)
    window.api
      .readAudio(filePath)
      .then(({ data, mime }) => {
        if (!alive) return
        const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
        const blob = new Blob([bytes], { type: mime })
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(err instanceof Error ? err.message : String(err))
        setUrl(null)
        setLoading(false)
      })
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [filePath])

  return { url, loading, error }
}
