import { useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { cn, formatDuration } from '../lib/format'

let activeAudio: HTMLAudioElement | null = null

function audioErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'NotAllowedError') return '浏览器阻止了自动播放，请再点一次播放'
  return error instanceof Error ? error.message : '音频播放失败'
}

interface Props {
  src: string | null
  durationHint?: number
  compact?: boolean
  className?: string
  /** Start playing as soon as this player mounts / receives a new src. */
  autoPlay?: boolean
}

export function AudioPlayer({ src, durationHint, compact = false, className, autoPlay = false }: Props): JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const peaksRef = useRef<number[]>([])
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(durationHint || 0)
  const [themeRevision, setThemeRevision] = useState(0)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    setPlaying(false)
    setError(null)
    setCurrent(0)
    setDuration(durationHint || 0)
    peaksRef.current = []
    if (!src) return
    let cancelled = false
    // Waveform decoding must not open the hardware audio device. Creating one
    // AudioContext per history row used to exhaust/perturb the audio backend.
    const context = new OfflineAudioContext(1, 1, 48000)
    fetch(src)
      .then((response) => response.arrayBuffer())
      .then((buffer) => context.decodeAudioData(buffer))
      .then((audioBuffer) => {
        if (cancelled) return
        const channel = audioBuffer.getChannelData(0)
        const bars = 160
        const block = Math.max(1, Math.floor(channel.length / bars))
        const peaks: number[] = []
        for (let i = 0; i < bars; i += 1) {
          let peak = 0
          const start = i * block
          const end = Math.min(channel.length, start + block)
          for (let j = start; j < end; j += 1) {
            const value = Math.abs(channel[j])
            if (value > peak) peak = value
          }
          peaks.push(peak)
        }
        const max = Math.max(...peaks, 0.0001)
        peaksRef.current = peaks.map((value) => Math.max(0.06, value / max))
        setDuration(audioBuffer.duration)
        draw()
      })
      .catch(() => {
        // Keep the placeholder waveform; playback is independent of decoding.
      })
    return () => {
      cancelled = true
    }
  }, [src, durationHint])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = (): void => setCurrent(audio.currentTime)
    const onMeta = (): void => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration)
    }
    const onEnd = (): void => {
      setPlaying(false)
      setCurrent(0)
      if (activeAudio === audio) activeAudio = null
    }
    const onPause = (): void => setPlaying(false)
    const onError = (): void => {
      setPlaying(false)
      setError(audio.error?.message || '音频输出初始化失败，请检查默认播放设备')
      if (activeAudio === audio) activeAudio = null
    }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('ended', onEnd)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('error', onError)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('ended', onEnd)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('error', onError)
      audio.pause()
      if (activeAudio === audio) activeAudio = null
    }
  }, [src])

  useEffect(() => {
    if (!autoPlay || !src) return
    const audio = audioRef.current
    if (!audio) return
    let cancelled = false
    const start = async (): Promise<void> => {
      setError(null)
      if (activeAudio && activeAudio !== audio) activeAudio.pause()
      activeAudio = audio
      try {
        await audio.play()
        if (!cancelled) setPlaying(true)
      } catch (playError) {
        if (cancelled) return
        setPlaying(false)
        setError(audio.error?.message || audioErrorMessage(playError))
        if (activeAudio === audio) activeAudio = null
      }
    }
    void start()
    return () => {
      cancelled = true
    }
  }, [autoPlay, src])

  useEffect(() => {
    const animate = (): void => {
      const audio = audioRef.current
      if (audio && !audio.paused) setCurrent(audio.currentTime)
      rafRef.current = requestAnimationFrame(animate)
    }
    if (playing) {
      rafRef.current = requestAnimationFrame(animate)
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [playing])

  useEffect(() => {
    draw()
  }, [current, duration, themeRevision])

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeRevision((value) => value + 1))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const observer = new ResizeObserver(() => draw())
    if (wrapRef.current) observer.observe(wrapRef.current)
    return () => observer.disconnect()
  }, [])

  function draw(): void {
    const canvas = canvasRef.current
    const wrapper = wrapRef.current
    if (!canvas || !wrapper) return
    const dpr = window.devicePixelRatio || 1
    const width = wrapper.clientWidth
    const height = compact ? 42 : 64
    canvas.width = Math.max(1, Math.floor(width * dpr))
    canvas.height = Math.floor(height * dpr)
    canvas.style.height = `${height}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)
    const peaks = peaksRef.current.length
      ? peaksRef.current
      : Array.from({ length: 160 }, (_, index) => 0.24 + Math.abs(Math.sin(index * 0.31)) * 0.22)
    const ratio = duration > 0 ? Math.min(1, current / duration) : 0
    const barWidth = Math.max(1.5, width / peaks.length - 1.6)
    const theme = document.documentElement.dataset.theme || ''
    const mono = theme.startsWith('mono')
    const styles = getComputedStyle(document.documentElement)
    const accent = styles.getPropertyValue('--accent').trim() || '#a78bfa'
    const accent2 = styles.getPropertyValue('--accent-2').trim() || '#22d3ee'
    const idle = mono
      ? theme === 'mono-light'
        ? 'rgba(0, 0, 0, 0.28)'
        : 'rgba(255, 255, 255, 0.28)'
      : 'rgba(148, 163, 184, 0.28)'
    peaks.forEach((peak, index) => {
      const x = index * (width / peaks.length)
      const barHeight = Math.max(2, peak * (height - 8))
      const y = (height - barHeight) / 2
      const progress = index / peaks.length
      if (progress <= ratio) {
        if (mono) {
          ctx.fillStyle = accent
        } else {
          const gradient = ctx.createLinearGradient(0, y, 0, y + barHeight)
          gradient.addColorStop(0, accent)
          gradient.addColorStop(1, accent2)
          ctx.fillStyle = gradient
        }
      } else {
        ctx.fillStyle = idle
      }
      ctx.beginPath()
      if (mono) {
        ctx.rect(x, y, barWidth, barHeight)
      } else {
        ctx.roundRect(x, y, barWidth, barHeight, barWidth / 2)
      }
      ctx.fill()
    })
  }

  async function toggle(): Promise<void> {
    const audio = audioRef.current
    if (!audio) return
    setError(null)
    if (audio.paused) {
      if (activeAudio && activeAudio !== audio) activeAudio.pause()
      activeAudio = audio
      try {
        await audio.play()
        setPlaying(true)
      } catch (playError) {
        setPlaying(false)
        setError(audio.error?.message || audioErrorMessage(playError))
        if (activeAudio === audio) activeAudio = null
      }
    } else {
      audio.pause()
      setPlaying(false)
    }
  }

  function seek(event: React.MouseEvent<HTMLDivElement>): void {
    const audio = audioRef.current
    const wrapper = wrapRef.current
    if (!audio || !wrapper || !duration) return
    const rect = wrapper.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    audio.currentTime = ratio * duration
    setCurrent(audio.currentTime)
  }

  return (
    <div className={cn('audio-player', compact && 'compact', className)}>
      <button
        className="audio-play"
        onClick={() => void toggle()}
        disabled={!src}
        title={error || (playing ? '暂停' : '播放')}
        aria-label={error || (playing ? '暂停' : '播放')}
      >
        {playing ? <Pause size={compact ? 15 : 17} fill="currentColor" /> : <Play size={compact ? 15 : 17} fill="currentColor" />}
      </button>
      <div className="audio-wave" ref={wrapRef} onClick={seek}>
        <canvas ref={canvasRef} />
      </div>
      <div className="audio-time">
        <span>{formatDuration(current)}</span>
        <span className="audio-total">{formatDuration(duration)}</span>
      </div>
      {error && <span className="audio-error" role="alert">{error}</span>}
      <audio ref={audioRef} src={src || undefined} preload="metadata" />
    </div>
  )
}
