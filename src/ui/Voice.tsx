import { memo, useEffect, useRef, useState } from 'react'
import { Play, Pause } from '@phosphor-icons/react'
import type { Message } from '../bridge/types'
import { cx, durationLabel } from '../lib/util'

/**
 * Voice/audio bubble — simulated playback progress over the real duration.
 * The real bridge streams opus; the UI contract is identical.
 */
export const WaveformPlayer = memo(function WaveformPlayer({ m, out }: { m: Message; out: boolean }) {
  const c = m.content as Extract<Message['content'], { kind: 'audio' }>
  const [pos, setPos] = useState(0)
  const [playing, setPlaying] = useState(false)
  const raf = useRef(0)
  const started = useRef(0)

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const toggle = () => {
    if (playing) {
      setPlaying(false)
      cancelAnimationFrame(raf.current)
      return
    }
    setPlaying(true)
    started.current = performance.now() - pos * 1000
    const tick = () => {
      const p = (performance.now() - started.current) / 1000
      if (p >= c.duration) {
        setPlaying(false)
        setPos(0)
        return
      }
      setPos(p)
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }

  const bars = c.waveform
  const frac = c.duration ? pos / c.duration : 0
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
      <div className="flex h-[30px] flex-1 items-center gap-[2.5px]">
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
        {durationLabel(pos > 0 ? pos : c.duration)}
      </span>
    </div>
  )
})
