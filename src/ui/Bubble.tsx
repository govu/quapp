import { memo, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import {
  ArrowBendUpLeft, ArrowClockwise, ArrowCounterClockwise,
  Check, Checks, Clock, Copy, DotsThree, FileText, Image as ImageIcon, PushPin, Share, MapPin,
  PencilSimple, Play, SelectionAll, Smiley, Star, Trash, X,
} from '@phosphor-icons/react'
import type { Chat, Message } from '../bridge/types'
import { cx, durationLabel, fileSize, isEmojiOnly, renderMarkup, spring, timeLabel } from '../lib/util'
import {
  doDelete, doPinMessage, doReact, doStar, doVote, jumpTo, setEditing, setForwarding, setReplyTo, startSelection, toggleSelect, useStore,
} from '../store'
import { Avatar } from './common'
import { showContextMenu } from './Menu'
import { WaveformPlayer } from './Voice'

const SENDER_COLORS = ['#0a84ff', '#30d158', '#ff9f0a', '#ff375f', '#bf5af2', '#64d2ff', '#ffd60a', '#ff6482']
export const senderColor = (id: string) => {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return SENDER_COLORS[h % SENDER_COLORS.length]
}

// iMessage tail paths (viewBox 0 0 22 20)
const TAIL_R = 'M0 0 C 4 6, 6 13, 11 17 C 15.5 19.5, 19 20, 22 20 C 15 17.5, 12 10, 10 0 Z'
const TAIL_L = 'M22 0 C 18 6, 16 13, 11 17 C 6.5 19.5, 3 20, 0 20 C 7 17.5, 10 10, 12 0 Z'

function Tail({ out }: { out: boolean }) {
  return (
    <svg
      width="13" height="12" viewBox="0 0 22 20" preserveAspectRatio="none"
      className={cx('absolute bottom-[1px]', out ? 'tail-out -right-[8px]' : 'tail-in -left-[8px]')}
      aria-hidden
    >
      <path d={out ? TAIL_R : TAIL_L} fill="currentColor" />
    </svg>
  )
}

function Ticks({ m }: { m: Message }) {
  if (m.from !== 'me' || !m.delivery) return null
  const cls = 'ml-[3px] inline-block shrink-0 align-[-2px]'
  switch (m.delivery) {
    case 'pending': return <Clock size={11} className={cls} />
    case 'sent': return <Check size={13} className={cls} />
    case 'delivered': return <Checks size={14} className={cls} />
    case 'read': return <Checks size={14} className={cx(cls, 'text-[#9ee0ff]')} />
    case 'failed': return <ArrowClockwise size={12} weight="bold" className={cx(cls, 'text-[#ffb3ae]')} />
  }
  return null
}

/** inline meta: floats right inside the last line of text/caption */
function Meta({ m, out }: { m: Message; out: boolean }) {
  return (
    <span className={cx('float-right mb-[-2px] ml-2 mt-[8px] inline-flex translate-y-[2px] items-center whitespace-nowrap text-[11px] tabular-nums', out ? 'text-[var(--bubble-meta-out)]' : 'text-[var(--bubble-meta-in)]')}>
      {m.edited && <span className="mr-1 italic">edited</span>}
      {m.starred && <Star size={10} weight="fill" className="mr-[3px]" />}
      {timeLabel(m.ts)}
      <Ticks m={m} />
    </span>
  )
}

/** meta chip floating on the image itself — only used when there is no caption */
function MetaOverlay({ m }: { m: Message }) {
  return (
    <div className="pointer-events-none absolute bottom-[7px] right-[7px] rounded-[7px] bg-black/35 px-[5px] py-[2.5px] backdrop-blur-[3px]">
      <span className="inline-flex items-center text-[11px] tabular-nums leading-none text-white">
        {m.edited && <span className="mr-1 italic">edited</span>}
        {timeLabel(m.ts)}
        <Ticks m={m} />
      </span>
    </div>
  )
}

function Quote({ m, out, chatId }: { m: NonNullable<Message['replyTo']>; out: boolean; chatId: string }) {
  return (
    <div
      onClick={() => void jumpTo(chatId, m.id)}
      className={cx(
        'mb-1.5 flex cursor-pointer gap-2 overflow-hidden rounded-[10px] py-1.5 pl-2.5 pr-3 text-[13px]',
        out ? 'bg-white/[0.16] hover:bg-white/[0.22]' : 'bg-black/[0.05] hover:bg-black/[0.08] dark:bg-white/[0.07] dark:hover:bg-white/[0.11]',
      )}
      style={{ borderLeft: `3px solid ${out ? 'rgba(255,255,255,0.75)' : 'var(--blue)'}` }}
    >
      <div className="min-w-0">
        <div className={cx('truncate text-[12.5px] font-semibold', out ? 'text-white' : 'text-[var(--blue)]')}>
          {m.fromName}
        </div>
        <div className={cx('truncate', out ? 'text-white/75' : 'text-[var(--label-2)]')}>{m.preview}</div>
      </div>
    </div>
  )
}

function Reactions({ m, out }: { m: Message; out: boolean }) {
  if (!m.reactions?.length) return null
  const groups = new Map<string, number>()
  for (const r of m.reactions) groups.set(r.emoji, (groups.get(r.emoji) ?? 0) + 1)
  return (
    <div className={cx('absolute -bottom-3 z-10 flex gap-0.5', out ? 'right-2' : 'left-2')}>
      {[...groups].map(([e, n]) => (
        <button
          key={e}
          onClick={() => doReact(m.chatId, m.id, m.reactions?.some((r) => r.by === 'me' && r.emoji === e) ? null : e)}
          className="menu-material press flex items-center gap-[3px] rounded-full px-[7px] py-[2px] text-[13px] leading-[18px]"
        >
          {e}
          {n > 1 && <span className="text-[10px] font-semibold text-[var(--label-2)]">{n}</span>}
        </button>
      ))}
    </div>
  )
}

// ---------- lightbox ----------
function Lightbox({ url, caption, onClose }: { url: string; caption?: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      className="fixed inset-0 z-[95] grid place-items-center bg-black/70 backdrop-blur-md"
      onClick={onClose}
    >
      <motion.img
        src={url}
        alt={caption ?? ''}
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
        transition={spring.pop}
        className="max-h-[86vh] max-w-[88vw] rounded-[10px] object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      {caption && (
        <div className="pointer-events-none absolute bottom-8 left-1/2 max-w-[70vw] -translate-x-1/2 rounded-full bg-black/50 px-4 py-1.5 text-center text-[13.5px] text-white/90 backdrop-blur-sm">
          {caption}
        </div>
      )}
      <button
        onClick={onClose}
        className="press absolute right-5 top-5 grid size-9 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"
        aria-label="Close"
      >
        <X size={18} weight="bold" />
      </button>
    </motion.div>,
    document.body,
  )
}

function safeHost(url: string): string {
  try { return new URL(url).hostname } catch { return url.slice(0, 40) }
}

// ---------- content renderers ----------
function TextContent({ m, out }: { m: Message; out: boolean }) {
  const c = m.content as Extract<Message['content'], { kind: 'text' }>
  const bigEmoji = isEmojiOnly(c.text) && !c.linkPreview
  return (
    <>
      <span
        className={cx('select-text whitespace-pre-wrap break-words', bigEmoji && 'emoji-xl')}
        dangerouslySetInnerHTML={{ __html: renderMarkup(c.text) }}
      />
      {c.linkPreview && (
        <a
          href={c.linkPreview.url}
          target="_blank"
          rel="noreferrer"
          className={cx('mt-1.5 block overflow-hidden rounded-[10px] no-underline', out ? 'bg-white/[0.14]' : 'bg-black/[0.05] dark:bg-white/[0.07]')}
        >
          <div className={cx('px-3 py-2 text-[13px]', out ? 'text-white' : '')} style={{ borderLeft: '3px solid var(--green)' }}>
            <div className="font-semibold">{c.linkPreview.title}</div>
            {c.linkPreview.description && <div className={cx('line-clamp-2', out ? 'text-white/75' : 'text-[var(--label-2)]')}>{c.linkPreview.description}</div>}
            <div className={cx('mt-0.5 text-[11px] uppercase tracking-wide', out ? 'text-white/60' : 'text-[var(--label-3)]')}>{c.linkPreview.site ?? safeHost(c.linkPreview.url)}</div>
          </div>
        </a>
      )}
    </>
  )
}

/** caption row shared by image/video: text selectable, meta inline at the end */
function MediaCaption({ m, caption }: { m: Message; caption: string }) {
  return (
    <div className="px-[7px] pb-[3px] pt-[7px]">
      <Meta m={m} out={m.from === 'me'} />
      <span className="select-text whitespace-pre-wrap break-words" dangerouslySetInnerHTML={{ __html: renderMarkup(caption) }} />
    </div>
  )
}

function ImageContent({ m }: { m: Message }) {
  const c = m.content as Extract<Message['content'], { kind: 'image' }>
  const [open, setOpen] = useState(false)
  const [fail, setFail] = useState(0) // 0 = loading, 1 = auto-retry once, 2 = unavailable
  // w/h=0 (history rows without dims) → NaN would collapse the bubble to a sliver
  const ar = c.w > 0 && c.h > 0 ? Math.min(Math.max(c.w / c.h, 0.5), 2.2) : 4 / 3
  return (
    <div>
      <button
        onClick={() => { if (fail < 2 && !useStore.getState().selection) setOpen(true) }}
        className="relative block overflow-hidden rounded-[10px] bg-[var(--fill-3)]"
        style={{ aspectRatio: ar, width: '100%', maxWidth: 320 }}
        aria-label="Open image"
      >
        {fail < 2 && (
          <img
            src={c.url + (fail ? `&r=${fail}` : '')}
            alt=""
            className="absolute inset-0 size-full object-cover transition-transform duration-300 ease-out hover:scale-[1.02]"
            loading="lazy"
            decoding="async"
            onError={() => {
              // first miss may just be an expired CDN url mid-reupload —
              // one quiet retry, then the honest unavailable state
              if (fail === 0) setTimeout(() => setFail(1), 4000)
              else setFail(2)
            }}
          />
        )}
        {fail === 2 && (
          <span className="absolute inset-0 grid place-items-center p-4 text-center">
            <span>
              <ImageIcon size={26} className="mx-auto text-[var(--label-3)]" />
              <span className="mt-2 block text-[12px] font-medium text-[var(--label-3)]">Media unavailable</span>
              <span className="mt-0.5 block text-[11px] text-[var(--label-3)]">Open WhatsApp on your phone to restore it</span>
            </span>
          </span>
        )}
        {!c.caption && <MetaOverlay m={m} />}
      </button>
      {c.caption && <MediaCaption m={m} caption={c.caption} />}
      <AnimatePresence>{open && <Lightbox url={c.url} caption={c.caption} onClose={() => setOpen(false)} />}</AnimatePresence>
    </div>
  )
}

function VideoContent({ m }: { m: Message }) {
  const c = m.content as Extract<Message['content'], { kind: 'video' }>
  const [playing, setPlaying] = useState(false)
  const ar = c.w && c.h ? Math.min(Math.max(c.w / c.h, 0.6), 2.2) : 16 / 9
  return (
    <div>
      <div className="relative overflow-hidden rounded-[10px] bg-black" style={{ aspectRatio: ar, maxWidth: 320 }}>
        {playing ? (
          <video
            src={c.url}
            controls
            autoPlay
            playsInline
            className="absolute inset-0 size-full object-contain"
          />
        ) : (
          <button
            onClick={() => setPlaying(true)}
            className="press absolute inset-0 grid place-items-center"
            aria-label="Play video"
          >
            {c.poster && <img src={c.poster} alt="" className="absolute inset-0 size-full object-cover" loading="lazy" />}
            <span className="relative grid size-12 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm">
              <Play size={22} weight="fill" className="translate-x-[1px]" />
            </span>
          </button>
        )}
        <span className="absolute left-1.5 top-1.5 rounded-[7px] bg-black/55 px-[5px] py-[2px] text-[11px] font-medium tabular-nums text-white">
          {durationLabel(c.duration ?? 0)}
        </span>
        {!playing && !c.caption && <MetaOverlay m={m} />}
      </div>
      {c.caption && <MediaCaption m={m} caption={c.caption} />}
    </div>
  )
}

function DocContent({ m, out }: { m: Message; out: boolean }) {
  const c = m.content as Extract<Message['content'], { kind: 'document' }>
  const ext = c.name.includes('.') ? c.name.split('.').pop()!.slice(0, 5).toUpperCase() : 'FILE'
  return (
    <a
      href={c.url ?? '#'}
      download={c.name}
      onClick={(e) => { if (!c.url) e.preventDefault() }}
      className={cx('press flex w-[250px] items-center gap-3 rounded-[10px] p-2.5 no-underline', out ? 'bg-white/[0.14]' : 'bg-black/[0.04] dark:bg-white/[0.06]')}
    >
      <span className={cx('relative grid size-11 shrink-0 place-items-center rounded-[10px]', out ? 'bg-white/20 text-white' : 'bg-[var(--blue)]/12 text-[var(--blue)]')}>
        <FileText size={22} />
        <span className="absolute bottom-[3px] rounded-[3px] bg-current/0 px-[2px] text-[7px] font-bold tracking-wide" style={{ color: 'inherit' }}>{ext}</span>
      </span>
      <div className="min-w-0 flex-1">
        <div className={cx('truncate text-[14px] font-medium', out ? 'text-white' : 'text-[var(--label)]')}>{c.name}</div>
        <div className={cx('text-[12px]', out ? 'text-white/70' : 'text-[var(--label-2)]')}>
          {fileSize(c.size)}{c.pages ? ` · ${c.pages} pages` : ''} · {ext}
        </div>
      </div>
    </a>
  )
}

function PollContent({ m, out }: { m: Message; out: boolean }) {
  const c = m.content as Extract<Message['content'], { kind: 'poll' }>
  const total = c.options.reduce((a, o) => a + o.votes, 0)
  const [picked, setPicked] = useState<number[]>(c.voted ?? [])
  const voted = !!c.voted?.length
  const toggle = (i: number) => {
    const next = c.multi
      ? picked.includes(i) ? picked.filter((x) => x !== i) : [...picked, i]
      : [i]
    setPicked(next)
    if (!c.multi) doVote(m.chatId, m.id, next)
  }
  return (
    <div className="w-[250px]">
      <div className="mb-1 text-[15px] font-semibold">{c.question}</div>
      <div className={cx('mb-2 text-[12px]', out ? 'text-white/70' : 'text-[var(--label-2)]')}>
        {c.multi ? 'Select one or more' : 'Select one'}
      </div>
      <div className="flex flex-col gap-1.5">
        {c.options.map((o, i) => {
          const mine = picked.includes(i)
          const pct = total ? Math.round((o.votes / total) * 100) : 0
          return (
            <button
              key={i}
              onClick={() => toggle(i)}
              className={cx(
                'press relative overflow-hidden rounded-[10px] px-3 py-2 text-left text-[14px]',
                out ? 'bg-white/[0.14]' : 'bg-black/[0.04] dark:bg-white/[0.06]',
              )}
            >
              {voted && (
                <span
                  className={cx('absolute inset-y-0 left-0', out ? 'bg-white/20' : 'bg-[var(--blue)]/15')}
                  style={{ width: `${pct}%` }}
                />
              )}
              <span className="relative flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span className={cx('grid size-[18px] place-items-center rounded-full border-[1.5px]', mine ? 'border-[var(--blue)] bg-[var(--blue)]' : out ? 'border-white/50' : 'border-[var(--label-3)]')}>
                    {mine && <Check size={11} weight="bold" className="text-white" />}
                  </span>
                  {o.text}
                </span>
                {voted && <span className={cx('text-[12px] tabular-nums', out ? 'text-white/70' : 'text-[var(--label-2)]')}>{pct}%</span>}
              </span>
            </button>
          )
        })}
      </div>
      {c.multi && !voted && picked.length > 0 && (
        <button
          onClick={() => doVote(m.chatId, m.id, picked)}
          className="press mt-2 w-full rounded-[10px] bg-[var(--blue)] py-1.5 text-[14px] font-semibold text-white"
        >
          Vote
        </button>
      )}
    </div>
  )
}

function StickerContent({ m }: { m: Message }) {
  const c = m.content as Extract<Message['content'], { kind: 'sticker' }>
  const [failed, setFailed] = useState(false)
  if (failed || !c.url) return <div className="select-text text-[64px] leading-none">{c.emoji}</div>
  return (
    <img
      src={c.url}
      alt={c.emoji}
      className="size-[120px] select-none object-contain drop-shadow-sm"
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}

function LocationContent({ m, out }: { m: Message; out: boolean }) {
  const c = m.content as Extract<Message['content'], { kind: 'location' }>
  return (
    <div className="w-[240px]">
      <div className={cx('relative grid h-[110px] place-items-center overflow-hidden rounded-[10px]', out ? 'bg-white/[0.14]' : 'bg-black/[0.05] dark:bg-white/[0.07]')}>
        <MapPin size={30} weight="fill" className={out ? 'text-white' : 'text-[var(--red)]'} />
      </div>
      <div className="mt-1.5 text-[14px] font-medium">{c.name}</div>
      {c.address && <div className={cx('text-[12px]', out ? 'text-white/70' : 'text-[var(--label-2)]')}>{c.address}</div>}
    </div>
  )
}

function Content({ m, out }: { m: Message; out: boolean }) {
  switch (m.content.kind) {
    case 'text': return <TextContent m={m} out={out} />
    case 'image': return <ImageContent m={m} />
    case 'video': return <VideoContent m={m} />
    case 'audio': return <WaveformPlayer m={m} out={out} />
    case 'document': return <DocContent m={m} out={out} />
    case 'poll': return <PollContent m={m} out={out} />
    case 'location': return <LocationContent m={m} out={out} />
    case 'sticker': return <StickerContent m={m} />
    case 'deleted':
      return (
        <span className="flex items-center gap-1.5 italic opacity-60">
          <ArrowCounterClockwise size={14} /> This message was deleted
        </span>
      )
    case 'system': return <span className="text-[12.5px]">{m.content.text}</span>
  }
}

const QUICK_REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏']

export interface RowCtx {
  /** show sender name (group, first of group) */
  first: boolean
  /** last of the group — tail/avatar */
  last: boolean
  chat: Chat
  /** arrived after the list mounted → plays the live-enter animation */
  live?: boolean
}

/** hover quick-actions: reply · react · more — sits beside the bubble, toward center */
function QuickActions({ m, out, chat, onMenu }: { m: Message; out: boolean; chat: Chat; onMenu: (e: React.MouseEvent) => void }) {
  const [reactOpen, setReactOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!reactOpen) return
    const close = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setReactOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [reactOpen])

  return (
    <div
      ref={wrapRef}
      className={cx(
        'relative mb-[3px] flex shrink-0 items-center gap-[2px] self-end rounded-full p-[2px] opacity-0 transition-opacity duration-100',
        'bg-[var(--bg)] shadow-[0_1px_4px_rgba(0,0,0,0.08),0_0_0_0.5px_var(--separator)] group-hover:opacity-100',
      )}
    >
      <QaBtn
        label="Reply"
        onClick={() => setReplyTo({ id: m.id, from: m.from, fromName: out ? 'You' : m.fromName ?? chat.title, preview: previewOf(m), kind: m.content.kind })}
      >
        <ArrowBendUpLeft size={15} />
      </QaBtn>
      <QaBtn label="React" onClick={() => setReactOpen((v) => !v)} active={reactOpen}>
        <Smiley size={15} />
      </QaBtn>
      <QaBtn label="More" onClick={onMenu}>
        <DotsThree size={16} weight="bold" />
      </QaBtn>
      <AnimatePresence>
        {reactOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.85, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 4, transition: { duration: 0.08 } }}
            transition={spring.pop}
            style={{ transformOrigin: out ? 'bottom right' : 'bottom left' }}
            className={cx('menu-material absolute bottom-[calc(100%+6px)] z-50 flex items-center gap-[1px] rounded-full p-1', out ? 'right-0' : 'left-0')}
          >
            {QUICK_REACTIONS.map((e) => (
              <button
                key={e}
                className="press rounded-full p-[6px] text-[20px] leading-none hover:bg-[var(--fill-2)]"
                onClick={() => { doReact(m.chatId, m.id, e); setReactOpen(false) }}
              >
                {e}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function QaBtn({ children, label, onClick, active }: { children: React.ReactNode; label: string; onClick?: (e: React.MouseEvent) => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cx('press grid size-[26px] place-items-center rounded-full', active ? 'text-[var(--blue)]' : 'text-[var(--label-3)] hover:bg-[var(--fill-2)] hover:text-[var(--label-2)]')}
      aria-label={label}
      tabIndex={-1}
    >
      {children}
    </button>
  )
}

export const MessageRow = memo(function MessageRow({ id, ctx }: { id: string; ctx: RowCtx }) {
  const m = useStore((s) => s.buckets.get(ctx.chat.id)?.map.get(id))
  const selecting = useStore((s) => s.selection !== null)
  const selected = useStore((s) => s.selection?.has(id) ?? false)
  const flashing = useStore((s) => s.flashId === id)
  if (!m) return null
  const out = m.from === 'me'
  const isSystem = m.content.kind === 'system'
  const hasMedia = m.content.kind === 'image' || m.content.kind === 'video' || m.content.kind === 'sticker'
  const isDeleted = m.content.kind === 'deleted'
  const caption = m.content.kind === 'image' || m.content.kind === 'video' ? m.content.caption : undefined

  const menu = (e: React.MouseEvent) => {
    if (selecting || isSystem) return
    const copyable = m.content.kind === 'text'
    showContextMenu(
      e,
      [
        { label: 'Reply', icon: <ArrowBendUpLeft size={16} />, onClick: () => setReplyTo({ id: m.id, from: m.from, fromName: out ? 'You' : m.fromName ?? ctx.chat.title, preview: previewOf(m), kind: m.content.kind }) },
        { label: 'Copy', icon: <Copy size={16} />, disabled: !copyable, onClick: () => { if (m.content.kind === 'text') navigator.clipboard.writeText(m.content.text) } },
        { label: 'Forward…', icon: <Share size={16} />, onClick: () => setForwarding([m]) },
        { label: m.starred ? 'Unstar' : 'Star', icon: <Star size={16} />, onClick: () => doStar(m.chatId, [m.id], !m.starred) },
        { label: 'Edit', icon: <PencilSimple size={16} />, disabled: !out || m.content.kind !== 'text', onClick: () => setEditing(m) },
        { label: 'Pin in chat', icon: <PushPin size={16} />, onClick: () => doPinMessage(m.chatId, m.id, true) },
        { label: 'Select', icon: <SelectionAll size={16} />, onClick: () => startSelection(id), separatorAbove: true },
        { label: 'Delete', icon: <Trash size={16} />, destructive: true, separatorAbove: true, onClick: () => doDelete(m.chatId, [m.id], false) },
        { label: 'Delete for everyone', icon: <Trash size={16} />, destructive: true, hidden: !out || isDeleted, onClick: () => doDelete(m.chatId, [m.id], true) },
      ],
      { list: QUICK_REACTIONS, onPick: (e) => doReact(m.chatId, m.id, e) },
    )
  }

  if (isSystem) {
    return (
      <div className="my-2 grid place-items-center px-10">
        <span className="pill rounded-full px-3 py-1 text-center text-[12px] text-[var(--label-2)]">{m.content.kind === 'system' ? m.content.text : ''}</span>
      </div>
    )
  }

  return (
    <motion.div
      data-msgid={id}
      initial={ctx.live ? { opacity: 0, y: 12, scale: 0.985 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={spring.snappy}
      className={cx(
        'group relative flex w-full items-end gap-[6px] px-3',
        out ? 'justify-end' : 'justify-start',
        ctx.last ? 'mb-[7px]' : 'mb-[2px]',
        m.reactions?.length && ctx.last ? 'mb-[19px]' : '',
        selected && 'bg-[var(--blue)]/8',
        flashing && 'msg-flash',
      )}
      onContextMenu={menu}
      onClick={() => selecting && toggleSelect(id)}
    >
      {/* selection check column */}
      {selecting && (
        <span className={cx('mb-2 mr-1 grid size-[20px] shrink-0 place-items-center rounded-full border-[1.5px] transition-colors', selected ? 'border-[var(--blue)] bg-[var(--blue)]' : 'border-[var(--label-3)]')}>
          {selected && <Check size={12} weight="bold" className="text-white" />}
        </span>
      )}

      {/* hover actions — incoming: right of bubble (rendered after); outgoing: left (rendered first via order) */}
      {out && !selecting && !isDeleted && <QuickActions m={m} out={out} chat={ctx.chat} onMenu={menu} />}

      {/* avatar column for incoming groups */}
      {!out && ctx.chat.kind === 'group' && (
        <div className="w-7 shrink-0">
          {ctx.last && <Avatar name={m.fromName ?? '?'} hue={senderHue(m)} size={26} />}
        </div>
      )}

      <div className={cx('relative max-w-[68%]', out && 'flex justify-end')}>
        <div
          className={cx(
            'relative text-[15px] leading-[19.5px] shadow-[0_0.5px_1px_rgba(0,0,0,0.04)]',
            out ? 'bubble-out' : 'bubble-in',
            hasMedia || m.content.kind === 'sticker' ? 'p-[5px]' : 'px-[13px] py-[7px]',
            m.content.kind === 'sticker' && '!bg-transparent !shadow-none',
            isDeleted && 'opacity-80',
          )}
          style={{
            borderRadius: 18,
            borderBottomRightRadius: out && ctx.last ? 4 : undefined,
            borderBottomLeftRadius: !out && ctx.last ? 4 : undefined,
          }}
        >
          {ctx.last && !isDeleted && <Tail out={out} />}

          {!out && ctx.first && ctx.chat.kind === 'group' && (
            <div className={cx('text-[13px] font-semibold', hasMedia ? 'px-2 pt-1' : 'mb-0.5')} style={{ color: senderColor(m.from) }}>
              {m.fromName}
            </div>
          )}
          {m.forwarded && (
            <div className={cx('flex items-center gap-1 text-[12px] italic', out ? 'text-white/75' : 'text-[var(--label-3)]', hasMedia ? 'px-2 pt-1' : 'mb-0.5')}>
              <Share size={12} /> Forwarded
            </div>
          )}
          {m.replyTo && (
            <div className={hasMedia ? 'px-[3px] pt-[3px]' : undefined}>
              <Quote m={m.replyTo} out={out} chatId={m.chatId} />
            </div>
          )}

          <div className={cx((hasMedia && m.content.kind !== 'sticker') || caption ? 'relative' : '')}>
            <Content m={m} out={out} />
          </div>

          {/* inline meta only for pure text-like bubbles; media handles its own */}
          {!hasMedia && m.content.kind !== 'sticker' && <Meta m={m} out={out} />}
        </div>
        <Reactions m={m} out={out} />
      </div>

      {!out && !selecting && !isDeleted && <QuickActions m={m} out={out} chat={ctx.chat} onMenu={menu} />}
    </motion.div>
  )
}, (prev, next) =>
  prev.id === next.id &&
  prev.ctx.first === next.ctx.first &&
  prev.ctx.last === next.ctx.last &&
  prev.ctx.live === next.ctx.live &&
  // field-level chat compare: a message arriving bumps chat.lastActivity and
  // hands every visible row a fresh ctx.chat reference — rows only render
  // id/title/kind, so lastActivity/unread churn must not re-render bubbles
  prev.ctx.chat.id === next.ctx.chat.id &&
  prev.ctx.chat.title === next.ctx.chat.title &&
  prev.ctx.chat.kind === next.ctx.chat.kind &&
  prev.ctx.chat.pinnedMessageId === next.ctx.chat.pinnedMessageId,
)

function senderHue(m: Message) {
  let h = 0
  for (let i = 0; i < m.from.length; i++) h = (h * 31 + m.from.charCodeAt(i)) >>> 0
  return (h % 9) * 40
}

export function previewOf(m: Message): string {
  const c = m.content
  switch (c.kind) {
    case 'text': return c.text.slice(0, 90)
    case 'image': return '📷 Photo'
    case 'video': return '🎬 Video'
    case 'audio': return c.voice ? '🎤 Voice message' : '🎵 Audio'
    case 'document': return `📄 ${c.name}`
    case 'sticker': return `Sticker ${c.emoji}`
    case 'poll': return `📊 ${c.question}`
    case 'location': return '📍 Location'
    case 'deleted': return 'This message was deleted'
    case 'system': return c.text
  }
}
