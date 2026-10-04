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
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const barsRef = useRef<HTMLDivElement>(null)

  const audio = () => {
    if (!audioRef.current) {
      const a = new Audio(c.url ?? c.file)
      a.preload = 'metadata'
      a.addEventListener('loadedmetadata', () => setDur(a.duration && isFinite(a.duration) ? a.duration : c.duration))
      a.addEventListener('timeupdate', () => setPos(a.currentTime))
      a.addEventListener('ended', () => { setPlaying(false); setPos(0) })
      a.addEventListener('error', () => { setPlaying(false) })
      audioRef.current = a
    }
    return audioRef.current
  }

  useEffect(() => () => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ''; audioRef.current = null }
  }, [])

  const toggle = () => {
    const a = audio()
    if (playing) a.pause()
    else void a.play()
    setPlaying(!playing)
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

  const bars = c.waveform?.length ? c.waveform : [6, 10, 14, 18, 12, 9, 15, 20, 8, 11]
  const frac = dur ? pos / dur : 0
  return (
    <div className="flex w-[230px] items-center gap-2.5 py-0.5">
      <button
        onClick={toggle}
        className={cx(
          'press grid size-[38px] shrink-0 place-items-center rounded-full',
          out ? 'bg-white/25 text-white' : 'bg-[var(--blue)] text-white',
        )}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" className="translate-x-[1px]" />}
      </button>
      <div
        ref={barsRef}
        onClick={seek}
        className="flex h-[30px] flex-1 cursor-pointer items-center gap-[2.5px]"
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
              className={cx('w-[3px] rounded-full', played ? (out ? 'bg-white' : 'bg-[var(--blue)]') : out ? 'bg-white/40' : 'bg-[var(--label-4)]')}
              style={{ height: Math.max(4, v * 1.5) }}
            />
          )
        })}
      </div>
      <span className={cx('shrink-0 text-[11.5px] tabular-nums', out ? 'text-white/75' : 'text-[var(--label-2)]')}>
        {durationLabel(pos > 0 && playing ? pos : dur)}
      </span>
    </div>
  )
})
