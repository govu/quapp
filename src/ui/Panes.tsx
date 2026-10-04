import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import {
  Archive, Bell, BellSlash, CaretDown, CaretUp, MagnifyingGlass, Phone, Prohibit, PushPin, Star, Trash, VideoCamera, X,
} from '@phosphor-icons/react'
import type { Chat, Message } from '../bridge/types'
import { cx, highlight, spring, timeLabel } from '../lib/util'
import {
  doCreateGroup, doDownload, doFlag, doForward, doLeaveGroup, doStar, jumpTo, loadStarred, requestProfile, searchInChat, setGroupSheet, setPane, toast, useStore,
} from '../store'
import { Avatar, Dialog, DialogButton } from './common'
import { previewOf } from './Bubble'

function BigPhoto({ src }: { src: string }) {
  const [fail, setFail] = useState(false)
  if (fail) return <div className="text-white/60">Photo unavailable</div>
  return <img src={src} alt="" onError={() => setFail(true)} className="max-h-[80vh] max-w-[80vw] rounded-2xl shadow-2xl" />
}

function PaneShell({ children, title, onClose }: { children: React.ReactNode; title: string; onClose: () => void }) {
  return (
    <motion.aside
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={spring.snappy}
      className="chrome hairline-b absolute inset-y-0 right-0 z-30 flex w-[330px] flex-col border-l border-[var(--separator)] bg-[var(--bg)]"
      role="complementary"
      aria-label={title}
    >
      <div className="hairline-b flex h-[56px] shrink-0 items-center gap-3 px-4">
        <button onClick={onClose} className="press rounded-full p-1 text-[var(--label-3)] hover:bg-[var(--fill-2)]" aria-label="Close">
          <X size={18} weight="bold" />
        </button>
        <span className="text-[15px] font-semibold">{title}</span>
      </div>
      {children}
    </motion.aside>
  )
}

// ---------- search within this chat ----------
export const SearchPane = memo(function SearchPane({ chat }: { chat: Chat }) {
  const [q, setQ] = useState('')
  const [cur, setCur] = useState(-1) // index of the match the conversation shows
  const hits = useStore((s) => s.searchHits)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => searchInChat(chat.id, q), 200)
    return () => clearTimeout(timer.current)
  }, [q, chat.id])

  const msgs = useMemo(() => hits ?? [], [hits])
  useEffect(() => setCur(-1), [msgs])

  const go = useCallback(
    (i: number) => {
      if (!msgs.length) return
      const next = ((i % msgs.length) + msgs.length) % msgs.length
      setCur(next)
      void jumpTo(chat.id, msgs[next].id)
    },
    [msgs, chat.id],
  )

  return (
    <PaneShell title="Search messages" onClose={() => setPane(null)}>
      <div className="p-3">
        <div className="flex items-center gap-2 rounded-[10px] bg-[var(--fill-3)] px-2.5 py-[7px] focus-within:ring-2 focus-within:ring-[var(--blue)]/60">
          <MagnifyingGlass size={15} className="shrink-0 text-[var(--label-3)]" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setPane(null)
              else if (e.key === 'Enter') { e.preventDefault(); go(cur + (e.shiftKey ? -1 : 1)) }
            }}
            placeholder="Search in this chat"
            className="w-full bg-transparent text-[14px] outline-none placeholder:text-[var(--label-3)]"
          />
          {msgs.length > 0 && (
            <>
              <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--label-3)]">
                {cur < 0 ? msgs.length : cur + 1} / {msgs.length}
              </span>
              <button className="press grid size-6 place-items-center rounded-full text-[var(--label-2)] hover:bg-[var(--fill-2)]" onClick={() => go(cur < 0 ? msgs.length - 1 : cur - 1)} aria-label="Previous match">
                <CaretUp size={13} weight="bold" />
              </button>
              <button className="press grid size-6 place-items-center rounded-full text-[var(--label-2)] hover:bg-[var(--fill-2)]" onClick={() => go(cur + 1)} aria-label="Next match">
                <CaretDown size={13} weight="bold" />
              </button>
            </>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!q.trim() ? (
          <Hint text="Search for text, captions, and file names in this conversation." />
        ) : msgs.length === 0 ? (
          <Hint text={`No results for “${q}”`} />
        ) : (
          <>
            <div className="px-2 py-1.5 text-[12px] text-[var(--label-3)]">{msgs.length} result{msgs.length === 1 ? '' : 's'} — Enter for next</div>
            {msgs.map((m, i) => (
              <button
                key={m.id}
                onClick={() => go(i)}
                className={cx(
                  'press flex w-full flex-col gap-0.5 rounded-[9px] px-2.5 py-2 text-left',
                  i === cur ? 'bg-[var(--blue)]/12 ring-1 ring-[var(--blue)]/40' : 'hover:bg-[var(--fill-3)]',
                )}
              >
                <span className="text-[11.5px] tabular-nums text-[var(--label-3)]">{timeLabel(m.ts)} · {new Date(m.ts).toLocaleDateString()}</span>
                <span className="line-clamp-2 text-[13.5px] leading-[17px] text-[var(--label)]">
                  {highlight(previewOf(m), q).map((p, i) =>
                    typeof p === 'string' ? <span key={i}>{p}</span> : <mark key={i}>{p.mark}</mark>,
                  )}
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    </PaneShell>
  )
})

function Hint({ text }: { text: string }) {
  return (
    <div className="grid h-40 place-items-center px-8 text-center text-[13px] leading-relaxed text-[var(--label-3)]">{text}</div>
  )
}

// ---------- contact / group info ----------
export const InfoPane = memo(function InfoPane({ chat }: { chat: Chat }) {
  const contacts = useStore((s) => s.contacts)
  const bucket = useStore((s) => s.buckets.get(chat.id))
  const [leaveConfirm, setLeaveConfirm] = useState(false)
  const media = useMemo(() => {
    const out: { id: string; url: string; video?: boolean }[] = []
    if (!bucket) return out
    for (const id of bucket.ids) {
      const m = bucket.map.get(id)!
      if (m.content.kind === 'image') out.push({ id: m.id, url: m.content.url })
      else if (m.content.kind === 'video') out.push({ id: m.id, url: m.content.url, video: true })
      if (out.length >= 12) break
    }
    return out
  }, [bucket])

  const docs = useMemo(() => {
    const out: Message[] = []
    if (!bucket) return out
    for (const id of bucket.ids) {
      const m = bucket.map.get(id)!
      if (m.content.kind === 'document') out.push(m)
      if (out.length >= 8) break
    }
    return out
  }, [bucket])

  const links = useMemo(() => {
    const out: { id: string; lp: NonNullable<Extract<Message['content'], { kind: 'text' }>['linkPreview']>; ts: number }[] = []
    if (!bucket) return out
    for (const id of bucket.ids) {
      const m = bucket.map.get(id)!
      if (m.content.kind === 'text' && m.content.linkPreview) out.push({ id: m.id, lp: m.content.linkPreview, ts: m.ts })
      if (out.length >= 8) break
    }
    return out
  }, [bucket])

  const starred = useMemo(() => {
    const out: Message[] = []
    if (!bucket) return out
    for (const id of bucket.ids) {
      const m = bucket.map.get(id)!
      if (m.starred) out.push(m)
    }
    return out
  }, [bucket])

  const contact = chat.contactId ? contacts.get(chat.contactId) : undefined
  const profile = useStore((s) => s.profiles.get(chat.id))
  const [bigPhoto, setBigPhoto] = useState(false)
  const [subject, setSubject] = useState(chat.title)
  const [blocked, setBlocked] = useState<boolean | null>(null)
  // pull the live profile (about/business) + warm the hi-res pic — dm/saved only
  const isDm = chat.kind === 'dm' || chat.kind === 'saved'
  useEffect(() => {
    if (isDm && chat.id.includes('@')) requestProfile(chat.id)
  }, [chat.id, isDm])
  // blocklist state for the Block row — fetched lazily, not a hot path
  useEffect(() => {
    if (!isDm || chat.id === 'saved') return
    void useStore.getState().adapter?.blocklist?.().then((jids) => {
      setBlocked(jids.some((j) => j === chat.id || chat.id.startsWith(j.split('@')[0] + '@')))
    }).catch(() => setBlocked(false))
  }, [chat.id, isDm])
  const phone = contact?.phone ?? (isDm && chat.id.endsWith('@s.whatsapp.net') ? '+' + chat.id.split('@')[0] : undefined)
  const about = profile?.about ?? contact?.about
  const bigUrl = chat.avatarUrl ? chat.avatarUrl + '&big=1' : undefined

  return (
    <PaneShell title={chat.kind === 'group' ? 'Group info' : chat.kind === 'channel' ? 'Channel info' : 'Contact info'} onClose={() => setPane(null)}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col items-center px-4 pb-5 pt-6 text-center">
          <button
            className="press rounded-full"
            onClick={() => bigUrl && setBigPhoto(true)}
            title={bigUrl ? 'View photo' : undefined}
          >
            <Avatar name={chat.title} hue={chat.avatarHue} url={bigUrl} size={96} />
          </button>
          {bigPhoto && bigUrl && createPortal(
            <div
              className="fixed inset-0 z-[95] grid place-items-center bg-black/70 backdrop-blur-sm"
              onClick={() => setBigPhoto(false)}
            >
              <BigPhoto src={bigUrl} />
            </div>,
            document.body,
          )}
          <div className="mt-3 text-[19px] font-semibold">{chat.kind === 'saved' ? 'You' : chat.title}</div>
          <div className="mt-0.5 text-[13.5px] text-[var(--label-2)]">
            {phone ?? (chat.kind === 'group' ? `Group · ${chat.participants.length} members` : chat.kind === 'channel' ? 'Channel' : '')}
          </div>
          {about
            ? <div className="mt-2 max-w-[260px] text-[13.5px] leading-relaxed text-[var(--label-2)]">{about}</div>
            : isDm && profile === undefined && <div className="mt-2 h-4 w-32 animate-pulse rounded bg-[var(--fill-3)]" />}
          {chat.kind !== 'saved' && chat.kind !== 'channel' && (
            <div className="mt-4 flex gap-6">
              <RoundAction icon={<Phone size={19} />} label="Call" onClick={() => toast('Calls open in WhatsApp on your phone', 'info')} />
              <RoundAction icon={<VideoCamera size={20} />} label="Video" onClick={() => toast('Calls open in WhatsApp on your phone', 'info')} />
              <RoundAction icon={<MagnifyingGlass size={19} />} label="Search" onClick={() => setPane('search')} />
            </div>
          )}
        </div>

        {profile?.biz && (
          <Section title={profile.biz.category ?? 'Business'}>
            <div className="px-4 pb-2">
              {profile.biz.description && <div className="text-[13.5px] leading-relaxed">{profile.biz.description}</div>}
              {profile.biz.website?.filter(Boolean).map((w) => (
                <a key={w} href={w.startsWith('http') ? w : `https://${w}`} target="_blank" rel="noreferrer"
                  className="mt-1 block truncate text-[13px] text-[var(--blue)] no-underline">{w}</a>
              ))}
              {profile.biz.email && <div className="mt-1 text-[13px] text-[var(--label-2)]">{profile.biz.email}</div>}
              {profile.biz.address && <div className="mt-1 text-[13px] text-[var(--label-3)]">{profile.biz.address}</div>}
            </div>
          </Section>
        )}

        {media.length > 0 && (
          <Section title={`Media · ${media.length}`}>
            <div className="grid grid-cols-3 gap-[3px] px-3 pb-2">
              {media.map((m) => (
                <button key={m.id} onClick={() => void jumpTo(chat.id, m.id)} className="press relative aspect-square overflow-hidden rounded-[6px] bg-[var(--fill-3)]">
                  {m.video
                    ? <video src={m.url} className="size-full object-cover" preload="metadata" muted />
                    : <img src={m.url} alt="" className="size-full object-cover" loading="lazy" decoding="async" />}
                  {m.video && <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[9px] font-semibold text-white">VID</span>}
                </button>
              ))}
            </div>
          </Section>
        )}

        {links.length > 0 && (
          <Section title={`Links · ${links.length}`}>
            <div className="px-3 pb-2">
              {links.map((l) => (
                <a
                  key={l.id}
                  href={l.lp.url}
                  target="_blank"
                  rel="noreferrer"
                  className="press flex w-full flex-col gap-0.5 rounded-[9px] px-2 py-2 text-left no-underline hover:bg-[var(--fill-3)]"
                >
                  <span className="truncate text-[13.5px] font-medium text-[var(--blue)]">{l.lp.title || l.lp.url}</span>
                  <span className="truncate text-[12px] text-[var(--label-3)]">{l.lp.url}</span>
                </a>
              ))}
            </div>
          </Section>
        )}

        {docs.length > 0 && (
          <Section title={`Documents · ${docs.length}`}>
            <div className="px-3 pb-2">
              {docs.map((m) => {
                const d = m.content as Extract<Message['content'], { kind: 'document' }>
                return (
                  <button
                    key={m.id}
                    onClick={() => void doDownload(m)}
                    className="press flex w-full items-center gap-3 rounded-[9px] px-2 py-2 text-left hover:bg-[var(--fill-3)]"
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-[var(--blue)]/12 text-[var(--blue)]">
                      <Archive size={15} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-medium text-[var(--label)]">{d.name}</span>
                      <span className="block text-[12px] text-[var(--label-3)]">{timeLabel(m.ts)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </Section>
        )}

        {starred.length > 0 && (
          <Section title={`Starred · ${starred.length}`}>
            <div className="px-3 pb-2">
              {starred.map((m) => (
                <button
                  key={m.id}
                  onClick={() => jumpTo(chat.id, m.id)}
                  className="press flex w-full flex-col gap-0.5 rounded-[9px] px-2 py-2 text-left hover:bg-[var(--fill-3)]"
                >
                  <span className="text-[11.5px] tabular-nums text-[var(--label-3)]">{timeLabel(m.ts)}</span>
                  <span className="line-clamp-2 text-[13.5px] leading-[17px]">{previewOf(m)}</span>
                </button>
              ))}
            </div>
          </Section>
        )}

        {chat.kind === 'group' && chat.youAdmin && (
          <Section title="Group name">
            <div className="px-4 pb-2">
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && subject.trim() && subject !== chat.title) {
                    void useStore.getState().adapter?.groupEdit?.(chat.id, { subject: subject.trim() })
                  }
                }}
                onBlur={() => {
                  if (subject.trim() && subject !== chat.title) void useStore.getState().adapter?.groupEdit?.(chat.id, { subject: subject.trim() })
                }}
                aria-label="Group name"
                className="w-full rounded-[9px] bg-[var(--fill-3)] px-3 py-2 text-[14px] outline-none focus:ring-2 focus:ring-[var(--blue)]/50"
              />
            </div>
          </Section>
        )}

        {chat.kind === 'group' && (
          <Section title={`${chat.participants.length} members`}>
            <div className="px-3 pb-2">
              {chat.participants.map((pid) => {
                const c = contacts.get(pid)
                const name = c?.name ?? (pid.includes('@') ? '+' + pid.split('@')[0] : pid)
                return (
                  <div key={pid} className="flex items-center gap-3 rounded-[9px] px-2 py-[7px]">
                    <Avatar name={name} hue={c?.avatarHue ?? Math.abs([...pid].reduce((a, ch) => a + ch.charCodeAt(0), 0)) % 360} url={c?.avatarUrl} size={36} />
                    <div className="min-w-0">
                      <div className="truncate text-[14.5px]">{name}</div>
                      {c?.about && <div className="truncate text-[12px] text-[var(--label-3)]">{c.about}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          </Section>
        )}

        <Section title="">
          <div className="px-3 pb-3">
            <InfoRow
              icon={chat.muted ? <BellSlash size={17} /> : <Bell size={17} />}
              label={chat.muted ? 'Unmute' : 'Mute'}
              onClick={() => doFlag(chat.id, 'muted', !chat.muted)}
            />
            <InfoRow
              icon={chat.pinned ? <PushPin size={17} /> : <PushPin size={17} />}
              label={chat.pinned ? 'Unpin chat' : 'Pin chat'}
              onClick={() => doFlag(chat.id, 'pinned', !chat.pinned)}
            />
            <InfoRow
              icon={<Star size={17} />}
              label={chat.favorite ? 'Remove from favorites' : 'Add to favorites'}
              onClick={() => doFlag(chat.id, 'favorite', !chat.favorite)}
            />
            <InfoRow icon={<Archive size={17} />} label="Archive chat" onClick={() => doFlag(chat.id, 'archived', true)} />
            {isDm && chat.id !== 'saved' && blocked !== null && (
              <InfoRow
                icon={<Prohibit size={17} />}
                label={blocked ? `Unblock ${chat.title}` : `Block ${chat.title}`}
                destructive={!blocked}
                onClick={() => {
                  void useStore.getState().adapter?.block?.(chat.id, !blocked)
                  setBlocked(!blocked)
                }}
              />
            )}
            {chat.kind === 'group' && (
              <InfoRow icon={<Trash size={17} />} label="Leave group" destructive onClick={() => setLeaveConfirm(true)} />
            )}
            {createPortal(
              <Dialog open={leaveConfirm} onClose={() => setLeaveConfirm(false)} title={`Leave "${chat.title}"?`}
                actions={<>
                  <DialogButton destructive onClick={() => { setLeaveConfirm(false); void doLeaveGroup(chat.id) }}>Leave</DialogButton>
                  <DialogButton onClick={() => setLeaveConfirm(false)}>Cancel</DialogButton>
                </>}>
                You'll be removed from the group and won't be able to send or receive its messages here.
              </Dialog>,
              document.body,
            )}
          </div>
        </Section>
      </div>
    </PaneShell>
  )
})

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="hairline-t py-2">
      {title && <div className="px-4 pb-1 pt-1 text-[12px] font-semibold uppercase tracking-wide text-[var(--label-3)]">{title}</div>}
      {children}
    </div>
  )
}

function RoundAction({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="press flex flex-col items-center gap-1.5">
      <span className="grid size-[46px] place-items-center rounded-full bg-[var(--fill-3)] text-[var(--blue)]">{icon}</span>
      <span className="text-[11.5px] text-[var(--label-2)]">{label}</span>
    </button>
  )
}

// ---------- starred messages across all chats ----------
export const StarredPane = memo(function StarredPane() {
  const list = useStore((s) => s.starredList)
  const chats = useStore((s) => s.chats)
  useEffect(() => { void loadStarred() }, [])
  const starred = list && list !== 'loading' ? list : []
  return (
    <PaneShell title="Starred" onClose={() => setPane(null)}>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {list === 'loading' && <div className="grid h-24 place-items-center text-[13px] text-[var(--label-3)]">Loading…</div>}
        {list !== 'loading' && starred.length === 0 && (
          <div className="grid h-40 place-items-center px-6 text-center text-[13.5px] leading-relaxed text-[var(--label-3)]">
            Star messages and they'll appear here — tap and hold a message, or use the ⋯ menu.
          </div>
        )}
        {starred.map((m) => {
          const c = chats.get(m.chatId)
          return (
            <div key={m.id} className="group relative">
              <button
                onClick={() => { setPane(null); void jumpTo(m.chatId, m.id) }}
                className="press flex w-full items-center gap-3 rounded-[10px] px-2 py-2.5 text-left hover:bg-[var(--fill-3)]"
              >
                <Avatar name={c?.title ?? '?'} hue={c?.avatarHue ?? 0} url={c?.avatarUrl} size={38} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-[14px] font-semibold">{c?.kind === 'saved' ? 'You' : (c?.title ?? 'Chat')}</span>
                    <span className="ml-auto shrink-0 text-[11.5px] tabular-nums text-[var(--label-3)]">{timeLabel(m.ts)}</span>
                  </span>
                  <span className="mt-[1px] block truncate text-[13px] text-[var(--label-2)]">
                    {m.from === 'me' ? 'You: ' : c?.kind === 'group' && m.fromName ? `${m.fromName}: ` : ''}{previewOf(m)}
                  </span>
                </span>
              </button>
              <button
                onClick={() => doStar(m.chatId, [m.id], false)}
                title="Unstar"
                className="absolute right-2 top-2 hidden rounded-full p-1.5 text-[var(--label-3)] hover:bg-[var(--fill-2)] group-hover:block"
              >
                <Star size={14} weight="fill" />
              </button>
            </div>
          )
        })}
      </div>
    </PaneShell>
  )
})

function InfoRow({ icon, label, onClick, destructive }: { icon: React.ReactNode; label: string; onClick?: () => void; destructive?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cx('press flex w-full items-center gap-3 rounded-[9px] px-2 py-[9px] text-left text-[14.5px] hover:bg-[var(--fill-3)]', destructive && 'text-[var(--red)]')}
    >
      <span className={destructive ? 'text-[var(--red)]' : 'text-[var(--label-2)]'}>{icon}</span>
      {label}
    </button>
  )
}

// ---------- forward picker ----------
export function ForwardSheet() {
  const msgs = useStore((s) => s.forwarding)
  const chats = useStore((s) => s.chats)
  const order = useStore((s) => s.order)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  if (!msgs) return null
  const list = order
    .map((id) => chats.get(id)!)
    .filter((c) => !c.archived && c.kind !== 'channel' && (!q || c.title.toLowerCase().includes(q.toLowerCase())))
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[70] grid place-items-center"
    >
      <div className="absolute inset-0 bg-black/30" onClick={() => useStore.setState({ forwarding: null })} />
      <motion.div
        initial={{ scale: 0.94, y: 12, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
        transition={spring.pop}
        className="menu-material relative flex h-[480px] w-[360px] flex-col rounded-2xl p-3"
      >
        <div className="px-1 pb-2 text-[15px] font-semibold">Forward to…</div>
        <div className="flex items-center gap-2 rounded-[10px] bg-[var(--fill-3)] px-2.5 py-[6px]">
          <MagnifyingGlass size={14} className="text-[var(--label-3)]" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="w-full bg-transparent text-[14px] outline-none placeholder:text-[var(--label-3)]" />
        </div>
        <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
          {list.map((c) => {
            const on = picked.has(c.id)
            return (
              <button
                key={c.id}
                onClick={() => setPicked((p) => { const n = new Set(p); if (on) n.delete(c.id); else n.add(c.id); return n })}
                className="flex w-full items-center gap-3 rounded-[9px] px-2 py-[7px] text-left hover:bg-[var(--fill-3)]"
              >
                <Avatar name={c.title} hue={c.avatarHue} size={34} />
                <span className="flex-1 truncate text-[14.5px]">{c.kind === 'saved' ? 'You' : c.title}</span>
                <span className={cx('grid size-[20px] place-items-center rounded-full border-[1.5px]', on ? 'border-[var(--blue)] bg-[var(--blue)]' : 'border-[var(--label-3)]')}>
                  {on && <span className="text-[11px] font-bold text-white">✓</span>}
                </span>
              </button>
            )
          })}
        </div>
        <button
          disabled={!picked.size}
          onClick={() => doForward([...picked], msgs)}
          className={cx('press mt-2 rounded-[10px] py-2 text-[15px] font-semibold', picked.size ? 'bg-[var(--blue)] text-white' : 'bg-[var(--fill-3)] text-[var(--label-3)]')}
        >
          Forward{picked.size > 1 ? ` to ${picked.size} chats` : ''}
        </button>
      </motion.div>
    </motion.div>
  )
}

// ---------- new-group picker ----------
export function GroupSheet() {
  const contacts = useStore((s) => s.contacts)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const list = [...contacts.values()]
    .filter((c) => c.id.includes('@') && (!q || c.name.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 300)
  const ready = name.trim().length > 0 && picked.size > 0
  const create = () => {
    if (!ready || busy) return
    setBusy(true)
    void doCreateGroup(name.trim(), [...picked]).finally(() => {
      setBusy(false)
      setGroupSheet(false)
    })
  }
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[70] grid place-items-center"
    >
      <div className="absolute inset-0 bg-black/30" onClick={() => setGroupSheet(false)} />
      <motion.div
        initial={{ scale: 0.94, y: 12, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
        transition={spring.pop}
        className="menu-material relative flex h-[500px] w-[360px] flex-col rounded-2xl p-3"
      >
        <div className="px-1 pb-2 text-[15px] font-semibold">New group</div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 100))}
          placeholder="Group name"
          aria-label="Group name"
          className="mb-2 rounded-[10px] bg-[var(--fill-3)] px-3 py-2 text-[14.5px] outline-none placeholder:text-[var(--label-3)] focus:ring-2 focus:ring-[var(--blue)]/50"
        />
        <div className="flex items-center gap-2 rounded-[10px] bg-[var(--fill-3)] px-2.5 py-[6px]">
          <MagnifyingGlass size={14} className="text-[var(--label-3)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts" className="w-full bg-transparent text-[14px] outline-none placeholder:text-[var(--label-3)]" />
        </div>
        <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
          {list.map((c) => {
            const on = picked.has(c.id)
            return (
              <button
                key={c.id}
                onClick={() => setPicked((p) => { const n = new Set(p); if (on) n.delete(c.id); else n.add(c.id); return n })}
                className="flex w-full items-center gap-3 rounded-[9px] px-2 py-[7px] text-left hover:bg-[var(--fill-3)]"
              >
                <Avatar name={c.name} hue={c.avatarHue} url={c.avatarUrl} size={34} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px]">{c.name}</span>
                  {c.phone && <span className="block truncate text-[12px] text-[var(--label-3)]">{c.phone}</span>}
                </span>
                <span className={cx('grid size-[20px] place-items-center rounded-full border-[1.5px]', on ? 'border-[var(--blue)] bg-[var(--blue)]' : 'border-[var(--label-3)]')}>
                  {on && <span className="text-[11px] font-bold text-white">✓</span>}
                </span>
              </button>
            )
          })}
        </div>
        <button
          disabled={!ready || busy}
          onClick={create}
          className={cx('press mt-2 rounded-[10px] py-2 text-[15px] font-semibold', ready && !busy ? 'bg-[var(--blue)] text-white' : 'bg-[var(--fill-3)] text-[var(--label-3)]')}
        >
          {busy ? 'Creating…' : `Create${picked.size ? ` · ${picked.size} member${picked.size > 1 ? 's' : ''}` : ''}`}
        </button>
      </motion.div>
    </motion.div>
  )
}
