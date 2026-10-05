import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import {
  ArrowLeft, Camera, CaretLeft, CaretRight, CircleDashed, PaperPlaneTilt, Plus, X,
} from '@phosphor-icons/react'
import type { Id, Message, StatusUpdate } from '../bridge/types'
import { cx, listTime, timeLabel } from '../lib/util'
import { closeStatus, openStatus, postStatus, send, setStatusCompose, setStatusOpen, stepStatus, useStore } from '../store'
import { Avatar } from './common'

// WhatsApp's segmented status ring — one segment per status, accent for
// unseen, gray once viewed. Solid ring for a single status.
function StatusRing({ count, unseen, children, size = 48 }: { count: number; unseen: boolean; children: React.ReactNode; size?: number }) {
  const segs = Math.max(count, 1)
  const gap = segs > 1 ? 6 : 0
  const deg = 360 / segs - gap
  const color = unseen ? 'var(--green)' : 'var(--label-4, #8e8e93)'
  const stops: string[] = []
  for (let i = 0; i < segs; i++) {
    const a = i * (360 / segs)
    stops.push(`${color} ${a}deg ${a + deg}deg`, `transparent ${a + deg}deg ${a + deg + gap}deg`)
  }
  return (
    <div
      className="grid shrink-0 place-items-center rounded-full"
      style={{ width: size + 4, height: size + 4, background: `conic-gradient(${stops.join(', ')})` }}
    >
      <div className="grid place-items-center rounded-full bg-[var(--material)]" style={{ width: size + 1, height: size + 1 }}>
        {children}
      </div>
    </div>
  )
}

const Row = memo(function Row({ g, onOpen, trailing }: { g: StatusUpdate; onOpen: () => void; trailing?: React.ReactNode }) {
  return (
    <button onClick={onOpen} className="press focus-ring flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left hover:bg-[var(--fill-2)]">
      <StatusRing count={g.msgs.length} unseen={g.unseen > 0}>
        <Avatar name={g.name} hue={g.avatarHue} url={g.avatarUrl} size={42} />
      </StatusRing>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium">{g.name}</div>
        <div className="truncate text-[12px] text-[var(--label-2)]">
          {listTime(g.latest)}
        </div>
      </div>
      {trailing}
    </button>
  )
})

/** Sidebar list — WhatsApp's "Updates" surface: my status + recent/viewed */
export function StatusPane() {
  const statuses = useStore((s) => s.statuses)
  const [recent, viewed, mine] = useMemo(() => {
    const all = [...statuses.values()]
    return [
      all.filter((g) => !g.mine && g.unseen > 0),
      all.filter((g) => !g.mine && g.unseen === 0),
      all.find((g) => g.mine),
    ]
  }, [statuses])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="no-drag flex items-center gap-1 px-3 pb-1 pt-1">
        <button
          className="press focus-ring grid size-8 place-items-center rounded-full text-[var(--label-2)] hover:bg-[var(--fill-2)]"
          onClick={() => setStatusOpen(false)}
          aria-label="Back to chats"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="text-[15px] font-semibold">Status</div>
        <div className="flex-1" />
        <button
          className="press focus-ring grid size-8 place-items-center rounded-full text-[var(--label-2)] hover:bg-[var(--fill-2)]"
          onClick={() => setStatusCompose(true)}
          aria-label="Add status"
        >
          <Plus size={19} />
        </button>
      </div>
      <div className="no-drag min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {/* My status — own ring or a "+" affordance to post the first one */}
        <div className="mb-1 mt-1">
          {mine ? (
            <Row
              g={mine}
              onOpen={() => openStatus('me')}
              trailing={
                <button
                  className="press focus-ring grid size-8 place-items-center rounded-full bg-[var(--accent)] text-white"
                  onClick={(e) => { e.stopPropagation(); setStatusCompose(true) }}
                  aria-label="Add to my status"
                >
                  <Plus size={16} weight="bold" />
                </button>
              }
            />
          ) : (
            <button onClick={() => setStatusCompose(true)} className="press focus-ring flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left hover:bg-[var(--fill-2)]">
              <div className="relative">
                <Avatar name="My status" hue={210} size={42} />
                <span className="absolute -bottom-0.5 -right-0.5 grid size-[18px] place-items-center rounded-full bg-[var(--accent)] text-white ring-2 ring-[var(--dot-ring)]">
                  <Plus size={11} weight="bold" />
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium">My status</div>
                <div className="text-[12px] text-[var(--label-2)]">Add to my status updates</div>
              </div>
            </button>
          )}
        </div>

        {!recent.length && !viewed.length && (
          <div className="mx-4 mt-10 text-center text-[13px] text-[var(--label-3)]">
            <CircleDashed size={34} className="mx-auto mb-3 text-[var(--label-4)]" />
            No status updates yet.
            <div className="mt-1 text-[12px]">Statuses your contacts post in the last 24 hours appear here.</div>
          </div>
        )}
        {recent.length > 0 && (
          <>
            <div className="px-3 pb-1 pt-3 text-[12px] font-semibold uppercase tracking-wide text-[var(--label-3)]">Recent updates</div>
            {recent.map((g) => <Row key={g.jid} g={g} onOpen={() => openStatus(g.jid)} />)}
          </>
        )}
        {viewed.length > 0 && (
          <>
            <div className="px-3 pb-1 pt-3 text-[12px] font-semibold uppercase tracking-wide text-[var(--label-3)]">Viewed updates</div>
            {viewed.map((g) => <Row key={g.jid} g={g} onOpen={() => openStatus(g.jid)} />)}
          </>
        )}
      </div>
    </div>
  )
}

// argb int from the wire → css; missing/low alpha reads as the WhatsApp green fallback
function argbToCss(argb: number | undefined): string | undefined {
  if (!argb) return undefined
  const u = argb >>> 0
  const a = (u >>> 24) & 0xff, r = (u >>> 16) & 0xff, g = (u >>> 8) & 0xff, b = u & 0xff
  if (a === 0 && r === 0 && g === 0 && b === 0) return undefined
  return `rgb(${r} ${g} ${b} / ${(a / 255).toFixed(2)})`
}

function StatusBody({ msg }: { msg: Message }) {
  const c = msg.content
  const [err, setErr] = useState(false)
  const dur = c.kind === 'video' ? Math.min(c.duration || 30, 30) : 5
  useEffect(() => {
    const t = setTimeout(() => stepStatus(1), dur * 1000)
    return () => clearTimeout(t)
  }, [msg.id, dur])

  if (c.kind === 'image') {
    return err
      ? <div className="text-[15px] text-white/60">Media unavailable</div>
      : <img src={c.url} alt="" onError={() => setErr(true)} className="max-h-[78vh] max-w-[92vw] rounded-xl object-contain shadow-2xl" draggable={false} />
  }
  if (c.kind === 'video') {
    return err
      ? <div className="text-[15px] text-white/60">Media unavailable</div>
      : <video
          key={msg.id} src={c.url} autoPlay playsInline
          className={cx('max-h-[78vh] max-w-[92vw] object-contain shadow-2xl', c.round ? 'size-[min(70vh,80vw)] rounded-full' : 'rounded-xl')}
          onEnded={() => stepStatus(1)} onError={() => setErr(true)}
        />
  }
  if (c.kind === 'audio') {
    return (
      <div className="flex items-center gap-3 rounded-2xl bg-white/10 px-5 py-4">
        <audio key={msg.id} src={c.url ?? c.file} autoPlay onEnded={() => stepStatus(1)} onError={() => setErr(true)} controls className="h-10 w-64" />
      </div>
    )
  }
  if (c.kind === 'sticker') {
    return <img src={c.url} alt={c.emoji} className="size-56 object-contain" draggable={false} />
  }
  // text statuses ride extendedTextMessage.backgroundColor (argb); fall back to
  // the WhatsApp status green when the sender didn't set one
  const text = c.kind === 'text' ? c.text : 'Status'
  const bg = c.kind === 'text' ? argbToCss(c.bg) : undefined
  return (
    <div
      className="grid max-h-[78vh] w-full max-w-[760px] place-items-center overflow-y-auto px-10 py-16"
      style={{ background: bg ?? '#1d8a64' }}
    >
      <div className="whitespace-pre-wrap text-center text-[clamp(20px,3.2vw,34px)] font-medium leading-snug text-white" style={{ textShadow: '0 1px 6px rgb(0 0 0 / 0.25)' }}>
        {text}
      </div>
    </div>
  )
}

/** full-screen viewer — progress segments, tap zones, auto-advance, reply */
export function StatusViewer() {
  const view = useStore((s) => s.statusView)
  const g = useStore((s) => (s.statusView ? s.statuses.get(s.statusView.jid) : undefined))
  const [reply, setReply] = useState('')
  const msg = g?.msgs[view?.index ?? 0]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeStatus()
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); stepStatus(1) }
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepStatus(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!view || !g || !msg) return null

  const sendReply = () => {
    const text = reply.trim()
    if (!text || g.mine) return
    const kindLabel = { image: 'Photo', video: 'Video', audio: 'Voice message', sticker: 'Sticker' }[msg.content.kind as string] ?? 'Status'
    const preview = msg.content.kind === 'text' ? msg.content.text.slice(0, 80) : kindLabel
    void send(g.jid, { kind: 'text', text }, {
      id: msg.id, from: g.jid, fromName: `${g.name}'s status`, preview, kind: msg.content.kind,
    })
    setReply('')
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
      className="fixed inset-0 z-[70] flex flex-col bg-black"
      role="dialog" aria-label={`${g.name}'s status`}
    >
      {/* progress segments */}
      <div className="absolute inset-x-0 top-0 z-10 flex gap-1 px-3 pt-3">
        {g.msgs.map((m, i) => (
          <div key={m.id} className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/25">
            {i < (view.index ?? 0) && <div className="h-full w-full bg-white/90" />}
            {i === view.index && (
              <motion.div
                key={msg.id}
                className="h-full bg-white/90"
                initial={{ width: '0%' }}
                animate={{ width: '100%' }}
                transition={{ duration: msg.content.kind === 'video' ? Math.min(msg.content.duration || 30, 30) : 5, ease: 'linear' }}
              />
            )}
          </div>
        ))}
      </div>
      {/* header */}
      <div className="absolute inset-x-0 top-6 z-10 flex items-center gap-3 px-4">
        <Avatar name={g.name} hue={g.avatarHue} url={g.avatarUrl} size={38} />
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-white">{g.name}</div>
          <div className="text-[12px] text-white/60">{timeLabel(msg.ts)}</div>
        </div>
        <div className="flex-1" />
        <button onClick={closeStatus} className="press grid size-9 place-items-center rounded-full text-white/80 hover:bg-white/10" aria-label="Close">
          <X size={22} />
        </button>
      </div>
      {/* body + tap zones */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center" onClick={(e) => stepStatus(e.clientX < window.innerWidth / 2 ? -1 : 1)}>
        <StatusBody key={msg.id} msg={msg} />
        <button className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full p-2 text-white/50 hover:text-white" onClick={(e) => { e.stopPropagation(); stepStatus(-1) }} aria-label="Previous"><CaretLeft size={26} /></button>
        <button className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full p-2 text-white/50 hover:text-white" onClick={(e) => { e.stopPropagation(); stepStatus(1) }} aria-label="Next"><CaretRight size={26} /></button>
      </div>
      {/* caption + reply */}
      {msg.content.kind !== 'text' && 'caption' in msg.content && msg.content.caption && (
        <div className="mx-auto max-w-[720px] px-4 pb-2 text-center text-[14px] text-white/85">{msg.content.caption}</div>
      )}
      <div className="relative z-10 mx-auto flex w-full max-w-[720px] items-center gap-2 px-4 pb-5 pt-2" onClick={(e) => e.stopPropagation()}>
        {g.mine ? (
          <div className="mx-auto pb-1 text-[12px] text-white/40">Your status</div>
        ) : (
          <>
            <input
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') sendReply() }}
              placeholder={`Reply to ${g.name}…`}
              className="quiet-input h-10 flex-1 rounded-full bg-white/10 px-4 text-[14px] text-white placeholder:text-white/40"
            />
            <button onClick={sendReply} disabled={!reply.trim()} className="press grid size-10 place-items-center rounded-full bg-[var(--green)] text-white disabled:opacity-40" aria-label="Send reply">
              <PaperPlaneTilt size={18} weight="fill" />
            </button>
          </>
        )}
      </div>
    </motion.div>
  )
}

const STATUS_COLORS = ['#1d8a64', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff9f0a', '#30b0c7', '#48484a']

/** post a status — text on a WhatsApp-style color field, or media + caption */
export function StatusComposer() {
  const open = useStore((s) => s.statusCompose)
  const [mode, setMode] = useState<'text' | 'media'>('text')
  const [text, setText] = useState('')
  const [bg, setBg] = useState(0)
  const [file, setFile] = useState<{ url: string; kind: 'image' | 'video'; w: number; h: number } | null>(null)
  const [caption, setCaption] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (open) { setMode('text'); setText(''); setBg(0); setFile(null); setCaption('') } }, [open])
  if (!open) return null

  const pick = (f: File) => {
    const url = URL.createObjectURL(f)
    const kind = f.type.startsWith('video') ? 'video' as const : 'image' as const
    if (kind === 'image') {
      const img = new Image()
      img.onload = () => setFile({ url, kind, w: img.naturalWidth, h: img.naturalHeight })
      img.src = url
    } else {
      const v = document.createElement('video')
      v.onloadedmetadata = () => setFile({ url, kind, w: v.videoWidth, h: v.videoHeight })
      v.src = url
    }
  }

  const toDataUrl = (blobUrl: string) => fetch(blobUrl).then((r) => r.blob()).then((b) => new Promise<string>((res) => {
    const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.readAsDataURL(b)
  }))

  const post = async () => {
    if (mode === 'text') {
      const t = text.trim()
      if (!t) return
      await postStatus({ kind: 'text', text: t, bg: 0xff000000 + parseInt(STATUS_COLORS[bg].slice(1), 16) })
    } else if (file) {
      const dataUrl = await toDataUrl(file.url)
      await postStatus({ kind: file.kind, url: dataUrl, w: file.w, h: file.h, caption: caption || undefined })
    }
  }

  return (
    <motion.div className="fixed inset-0 z-[72] grid place-items-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="absolute inset-0 bg-black/45" onClick={() => setStatusCompose(false)} />
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }}
        transition={{ type: 'spring', duration: 0.32, bounce: 0.2 }}
        className="menu-material relative w-[min(560px,92vw)] overflow-hidden rounded-2xl"
        role="dialog" aria-label="Add status"
      >
        <div className="flex items-center gap-1 border-b border-[var(--separator)] px-4 py-2.5">
          <div className="text-[15px] font-semibold">Add status</div>
          <div className="flex-1" />
          {(['text', 'media'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cx('press rounded-full px-3.5 py-1 text-[13px] font-medium capitalize', mode === m ? 'bg-[var(--accent)] text-white' : 'text-[var(--label-2)] hover:bg-[var(--fill-2)]')}
            >
              {m === 'text' ? 'Text' : 'Photo / video'}
            </button>
          ))}
          <button onClick={() => setStatusCompose(false)} className="press ml-1 grid size-8 place-items-center rounded-full text-[var(--label-2)] hover:bg-[var(--fill-2)]" aria-label="Close"><X size={17} /></button>
        </div>

        {mode === 'text' ? (
          <div className="p-4">
            <div
              className="grid h-56 place-items-center rounded-xl p-6 transition-colors duration-200"
              style={{ background: STATUS_COLORS[bg] }}
            >
              <textarea
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type a status"
                className="quiet-input max-h-full w-full resize-none bg-transparent text-center text-[22px] font-medium text-white placeholder:text-white/50"
                maxLength={700}
              />
            </div>
            <div className="mt-3 flex items-center gap-2">
              {STATUS_COLORS.map((c, i) => (
                <button
                  key={c}
                  onClick={() => setBg(i)}
                  aria-label={`Background ${i + 1}`}
                  className={cx('press size-7 rounded-full ring-2 ring-inset transition-transform', bg === i ? 'ring-[var(--accent)] scale-110' : 'ring-black/10')}
                  style={{ background: c }}
                />
              ))}
              <div className="flex-1" />
              <button
                onClick={post}
                disabled={!text.trim()}
                className="press rounded-full bg-[var(--accent)] px-4 py-1.5 text-[14px] font-semibold text-white disabled:opacity-40"
              >
                Post
              </button>
            </div>
          </div>
        ) : (
          <div className="p-4">
            <input ref={fileRef} type="file" accept="image/*,video/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f) }} />
            {file ? (
              <div className="grid place-items-center rounded-xl bg-black/80 p-2">
                {file.kind === 'image'
                  ? <img src={file.url} alt="" className="max-h-64 rounded-lg object-contain" />
                  : <video src={file.url} className="max-h-64 rounded-lg" controls />}
              </div>
            ) : (
              <button onClick={() => fileRef.current?.click()} className="press focus-ring grid h-48 w-full place-items-center rounded-xl border-2 border-dashed border-[var(--separator-strong)] text-[var(--label-2)] hover:bg-[var(--fill-3)]">
                <div className="text-center">
                  <Camera size={30} className="mx-auto mb-2 text-[var(--label-3)]" />
                  <div className="text-[14px] font-medium">Choose a photo or video</div>
                </div>
              </button>
            )}
            <div className="mt-3 flex items-center gap-2">
              {file && (
                <button onClick={() => fileRef.current?.click()} className="press rounded-full bg-[var(--fill-3)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--label-2)] hover:bg-[var(--fill-2)]">Replace</button>
              )}
              <input
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Add a caption…"
                className="quiet-input h-9 flex-1 rounded-full bg-[var(--fill-3)] px-3.5 text-[13.5px] placeholder:text-[var(--label-3)]"
              />
              <button onClick={post} disabled={!file} className="press rounded-full bg-[var(--accent)] px-4 py-1.5 text-[14px] font-semibold text-white disabled:opacity-40">Post</button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}
