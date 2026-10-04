import { memo, useEffect, useRef, useState } from 'react'
import { Play, Pause } from '@phosphor-icons/react'
import type { Message } from '../bridge/types'
import { cx, durationLabel } from '../lib/util'

/**
 * Voice/audio bubble — real playback via a lazily-created <audio> element fed
 * by the bridge media server. Clicking the waveform seeks.
 */
export const WaveformPlayer = memo(function WaveformPlayer({ m, out }: { m: Message; out: boolean }) {
  const c = m.content as Extract<Message['content'], { kind: 'audio' }>
  const [pos, setPos] = useState(0)
  const [dur, setDur] = useState(c.duration || 0)
  const [playing, setPlaying] = useState(false)
  const [fail, setFail] = useState(0) // 0 ok · 1 retrying · 2 dead
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const barsRef = useRef<HTMLDivElement>(null)

  const audio = (fresh = false) => {
    if (fresh && audioRef.current) { audioRef.current.src = ''; audioRef.current = null }
    if (!audioRef.current) {
      const a = new Audio(c.url ?? c.file)
      a.preload = 'metadata'
      a.addEventListener('loadedmetadata', () => { setFail(0); setDur(a.duration && isFinite(a.duration) ? a.duration : c.duration) })
      a.addEventListener('timeupdate', () => setPos(a.currentTime))
      a.addEventListener('ended', () => { setPlaying(false); setPos(0) })
      a.addEventListener('error', () => {
        setPlaying(false)
        if (fail === 0) {
          setFail(1)
          setTimeout(() => { const a2 = audio(true); void a2.play().then(() => setPlaying(true)).catch(() => setFail(2)) }, 2500)
        } else setFail(2)
      })
      audioRef.current = a
    }
    return audioRef.current
  }

  useEffect(() => () => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ''; audioRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = () => {
    if (fail === 2) return
    const a = audio()
    if (playing) { a.pause(); setPlaying(false) }
    else { void a.play().then(() => setPlaying(true)).catch(() => setFail(2)) }
  }

  const seek = (e: React.MouseEvent) => {
    const el = barsRef.current
    const a = audioRef.current
    if (!el || !a || !dur) return
    const r = el.getBoundingClientRect()
    const frac = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1)
    a.currentTime = frac * dur
    setPos(frac * dur)
  }

  // WhatsApp ships ~64 samples normalized 0..1; more than ~48 bars can't fit
  // the bubble width — resample by averaging so flex layout never overflows
  const src = c.waveform?.length ? c.waveform : [0.2, 0.4, 0.6, 0.8, 0.5, 0.35, 0.65, 0.9, 0.3, 0.45]
  const raw = src.map((v) => (v > 1 ? v / 255 : v))
  const MAX_BARS = 48
  const bars = raw.length <= MAX_BARS
    ? raw
    : Array.from({ length: MAX_BARS }, (_, i) => {
        const a = (i * raw.length) / MAX_BARS
        const b = ((i + 1) * raw.length) / MAX_BARS
        let s = 0
        for (let j = Math.floor(a); j < Math.floor(b); j++) s += raw[j]
        return s / Math.max(1, Math.floor(b) - Math.floor(a))
      })
  const frac = dur ? pos / dur : 0
  return (
    <div className="flex w-[230px] items-center gap-2.5 py-0.5">
      <button
        onClick={toggle}
        disabled={fail === 2}
        className={cx(
          'press grid size-[38px] shrink-0 place-items-center rounded-full',
          out ? 'bg-white/25 text-white' : 'bg-[var(--blue)] text-white',
          (fail === 2 || fail === 1) && 'opacity-40'
        )}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {fail === 2 ? <Play size={17} weight="fill" className="translate-x-[1px]" /> : playing ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" className="translate-x-[1px]" />}
      </button>
      <div
        ref={barsRef}
        onClick={seek}
        className="flex h-[30px] min-w-0 flex-1 cursor-pointer items-center gap-[2.5px] overflow-hidden"
        role="slider"
        aria-valuemin={0}
        aria-valuemax={dur}
        aria-valuenow={pos}
        aria-label="Seek"
      >
        {bars.map((v, i) => {
          const played = i / bars.length <= frac
          return (
            <span
              key={i}
              className={cx('min-w-[2px] flex-1 rounded-full', played ? (out ? 'bg-white' : 'bg-[var(--blue)]') : out ? 'bg-white/40' : 'bg-[var(--label-4)]')}
              style={{ height: 4 + Math.min(1, Math.max(0, v)) * 22, maxWidth: 3 }}
            />
          )
        })}
      </div>
      <span className={cx('shrink-0 text-[11.5px] tabular-nums', out ? 'text-white/75' : 'text-[var(--label-2)]')}>
        {fail === 2 ? 'n/a' : fail === 1 ? '…' : durationLabel(pos > 0 && playing ? pos : dur)}
      </span>
    </div>
  )
})
