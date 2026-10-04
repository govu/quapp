import { memo, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { motion, AnimatePresence } from 'motion/react'
import {
  Archive, BellSlash, Checks, Check, Clock, Gear, MagnifyingGlass, PencilSimple,
  PushPin, Plus, Users, Star, ArrowLeft, X,
} from '@phosphor-icons/react'
import type { Chat, Id } from '../bridge/types'
import { cx, highlight, listTime } from '../lib/util'
import {
  doFlag, doMarkRead, doMarkUnread, openChat, setFilter, setPalette, setQuery, setRelinkPrompt,
  setSettingsOpen, setShowArchived, useStore, type Filter,
} from '../store'
import { Avatar } from './common'
import { showContextMenu } from './Menu'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'favorites', label: 'Favorites' },
  { id: 'groups', label: 'Groups' },
]

function previewText(chat: Chat, lastMsg: { content: import('../bridge/types').MsgContent; from: Id | 'me'; fromName?: string } | undefined, typing: string[] | undefined): { text: string; icon?: 'checks' | 'check' | 'clock' | 'checks-read' } {
  if (typing?.length) return { text: chat.kind === 'group' ? `${typing.join(', ')} typing…` : 'typing…' }
  if (!lastMsg) return { text: '' }
  const c = lastMsg.content
  let body = ''
  switch (c.kind) {
    case 'text': body = c.text; break
    case 'image': body = c.caption ? `📷 ${c.caption}` : 'Photo'; break
    case 'video': body = c.caption ? `🎬 ${c.caption}` : 'Video'; break
    case 'audio': body = c.voice ? 'Voice message' : 'Audio'; break
    case 'document': body = c.name; break
    case 'sticker': body = `Sticker ${c.emoji}`; break
    case 'poll': body = `Poll: ${c.question}`; break
    case 'location': body = 'Location'; break
    case 'deleted': body = 'This message was deleted'; break
    case 'system': body = c.text; break
  }
  let prefix = ''
  if (lastMsg.from === 'me' && chat.kind !== 'saved') prefix = 'You: '
  else if (chat.kind === 'group' && lastMsg.fromName) prefix = `${lastMsg.fromName}: `
  let icon: 'checks' | 'check' | 'clock' | 'checks-read' | undefined
  if (lastMsg.from === 'me') {
    const d = (lastMsg as { delivery?: string }).delivery
    icon = d === 'read' ? 'checks-read' : d === 'delivered' ? 'checks' : d === 'sent' ? 'check' : 'clock'
  }
  return { text: prefix + body, icon }
}

// Row subscribes only to its own chat + last message — new messages elsewhere don't re-render it.
const ChatRow = memo(function ChatRow({ id, active }: { id: Id; active: boolean }) {
  const chat = useStore((s) => s.chats.get(id))
  const typing = useStore((s) => s.typing.get(id))
  const query = useStore((s) => s.query)
  const draft = useStore((s) => s.drafts.get(id))
  const lastMsg = useStore((s) => {
    const b = s.buckets.get(id)
    if (!b || !b.ids.length) return undefined
    return b.map.get(b.ids[b.ids.length - 1])
  })
  if (!chat) return null
  const pv = previewText(chat, lastMsg, typing)
  const isTyping = !!typing?.length
  const menu = (e: React.MouseEvent) => {
    showContextMenu(e, [
      { label: chat.pinned ? 'Unpin' : 'Pin', icon: <PushPin size={16} />, onClick: () => doFlag(id, 'pinned', !chat.pinned) },
      { label: chat.muted ? 'Unmute' : 'Mute', icon: <BellSlash size={16} />, onClick: () => doFlag(id, 'muted', !chat.muted) },
      { label: chat.markedUnread ? 'Mark as read' : 'Mark as unread', icon: <Checks size={16} />, onClick: () => doMarkUnread(id, !chat.markedUnread) },
      { label: chat.favorite ? 'Remove from favorites' : 'Add to favorites', icon: <Star size={16} />, onClick: () => doFlag(id, 'favorite', !chat.favorite), disabled: chat.kind === 'channel' },
      { label: chat.archived ? 'Unarchive' : 'Archive', icon: <Archive size={16} />, onClick: () => doFlag(id, 'archived', !chat.archived), separatorAbove: true },
      { label: 'Mark as read', icon: <Checks size={16} />, onClick: () => doMarkRead(id), hidden: !(chat.unread > 0 || chat.markedUnread) },
    ])
  }
  return (
    <button
      onClick={() => openChat(id)}
      onContextMenu={menu}
      className={cx(
        'mx-2 flex w-[calc(100%-16px)] items-center gap-3 rounded-[10px] px-2 py-[7px] text-left transition-colors duration-100',
        active ? 'bg-[var(--row-selected)]' : 'hover:bg-[var(--row-hover)]',
      )}
    >
      <div className="relative">
        <Avatar name={chat.title} hue={chat.avatarHue} url={chat.avatarUrl} size={42} />
        {chat.kind === 'group' && (
          <span className="absolute -bottom-0.5 -right-0.5 grid size-[18px] place-items-center rounded-full bg-[var(--fill)] text-[var(--label-2)] ring-2 ring-[var(--sidebar-solid)]">
            <Users size={11} weight="fill" />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[15px] font-semibold leading-[19px]">
            {chat.kind === 'saved' ? 'You' : query ? <Hl text={chat.title} q={query} /> : chat.title}
          </span>
          <span className={cx('ml-auto shrink-0 text-[12px] tabular-nums', chat.unread > 0 && !chat.muted ? 'text-[var(--blue)] font-medium' : 'text-[var(--label-3)]')}>
            {lastMsg ? listTime(lastMsg.ts) : ''}
          </span>
        </div>
        <div className="mt-[1px] flex items-center gap-1.5">
          {pv.icon === 'checks' && <Checks size={14} className="shrink-0 text-[var(--label-3)]" />}
          {pv.icon === 'check' && <Check size={14} className="shrink-0 text-[var(--label-3)]" />}
          {pv.icon === 'clock' && <Clock size={13} className="shrink-0 text-[var(--label-3)]" />}
          {pv.icon === 'checks-read' && <Checks size={14} className="shrink-0 text-[var(--tick-read)]" />}
          <span className={cx('truncate text-[13.5px] leading-[17px]', isTyping ? 'text-[var(--green)] font-medium' : 'text-[var(--label-2)]')}>
            {draft && !isTyping ? (
              <><span className="text-[var(--red)]">Draft: </span>{draft}</>
            ) : query ? <Hl text={pv.text} q={query} /> : pv.text}
          </span>
          {(chat.pinned || chat.muted || chat.markedUnread || chat.unread > 0) && (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {chat.muted && <BellSlash size={13} weight="fill" className="text-[var(--label-3)]" />}
              {chat.pinned && <PushPin size={12} weight="fill" className="rotate-45 text-[var(--label-3)]" />}
              {chat.markedUnread && <span className="size-[10px] rounded-full bg-[var(--blue)]" />}
              {chat.unread > 0 && !chat.markedUnread && (
                <span className={cx(
                  'grid h-[19px] min-w-[19px] place-items-center rounded-full px-[5px] text-[11px] font-semibold tabular-nums',
                  chat.muted ? 'bg-[var(--fill)] text-[var(--label-2)]' : 'bg-[var(--blue)] text-white',
                )}>
                  {chat.unread > 99 ? '99+' : chat.unread}
                </span>
              )}
            </span>
          )}
        </div>
      </div>
    </button>
  )
})

function Hl({ text, q }: { text: string; q: string }) {
  return (
    <>
      {highlight(text, q).map((p, i) =>
        typeof p === 'string' ? <span key={i}>{p}</span> : <mark key={i}>{p.mark}</mark>,
      )}
    </>
  )
}

function matchQuery(chat: Chat, q: string) {
  if (!q) return true
  const l = q.toLowerCase()
  return chat.title.toLowerCase().includes(l)
}

export function Sidebar() {
  const order = useStore((s) => s.order)
  const chats = useStore((s) => s.chats)
  const query = useStore((s) => s.query)
  const filter = useStore((s) => s.filter)
  const showArchived = useStore((s) => s.showArchived)
  const activeChat = useStore((s) => s.activeChat)
  const account = useStore((s) => s.account)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [accountOpen, setAccountOpen] = useState(false)

  const visible = useMemo(() => {
    const v = order.filter((id) => {
      const c = chats.get(id)!
      if (c.archived !== showArchived) return false
      if (!matchQuery(c, query)) return false
      switch (filter) {
        case 'all': return true
        case 'unread': return c.unread > 0 || c.markedUnread
        case 'favorites': return c.favorite
        case 'groups': return c.kind === 'group' || c.kind === 'channel'
      }
    })
    return v
  }, [order, chats, query, filter, showArchived])

  const archivedCount = useMemo(() => [...chats.values()].filter((c) => c.archived).length, [chats])

  // per-chip unread totals — one pass over the map, recomputed only when chats change
  const chipUnread = useMemo(() => {
    const m = { all: 0, unread: 0, favorites: 0, groups: 0 }
    for (const c of chats.values()) {
      if (c.archived) continue
      m.all += c.unread
      if (c.favorite) m.favorites += c.unread
      if (c.kind === 'group' || c.kind === 'channel') m.groups += c.unread
    }
    return m
  }, [chats])

  const virt = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58,
    overscan: 12,
    getItemKey: (i) => visible[i],
  })

  return (
    <aside className="vibrancy hairline-r flex w-[300px] shrink-0 flex-col" role="navigation" aria-label="Chats">
      {/* header: account switcher + actions */}
      <div className="flex items-center gap-2 px-3 pb-1 pt-3">
        <div className="relative">
          <button
            className="press focus-ring relative rounded-full"
            onClick={() => setAccountOpen((v) => !v)}
            aria-label="Accounts"
          >
            <Avatar name={account?.name ?? 'You'} hue={account?.avatarHue ?? 210} size={36} />
            <span className="absolute -bottom-0.5 -right-0.5 size-[9px] rounded-full bg-[var(--blue)] ring-2 ring-[var(--sidebar-solid)]" />
          </button>
          <AnimatePresence>
            {accountOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setAccountOpen(false)} />
                <motion.div
                  initial={{ opacity: 0, scale: 0.9, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ type: 'spring', duration: 0.28, bounce: 0.18 }}
                  style={{ transformOrigin: 'top left' }}
                  className="menu-material absolute left-0 top-11 z-50 w-64 rounded-[13px] p-1.5"
                >
                  <div className="flex items-center gap-3 rounded-[9px] bg-[var(--fill-3)] px-3 py-2.5">
                    <Avatar name={account?.name ?? 'You'} hue={account?.avatarHue ?? 210} size={38} />
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-semibold">{account?.name}</div>
                      <div className="truncate text-[12px] text-[var(--label-2)]">{account?.phone}</div>
                    </div>
                    <Check size={16} weight="bold" className="ml-auto text-[var(--blue)]" />
                  </div>
                  <button
                    className="press mt-1 flex w-full items-center gap-2.5 rounded-[9px] px-3 py-2 text-left text-[14px] hover:bg-[var(--fill-2)]"
                    onClick={() => { setAccountOpen(false); setRelinkPrompt(true) }}
                  >
                    <span className="grid size-[26px] place-items-center rounded-full bg-[var(--fill)]"><Plus size={15} /></span>
                    Add account
                  </button>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
        <div className="flex-1" />
        <button
          className="press focus-ring grid size-8 place-items-center rounded-full text-[var(--label-2)] hover:bg-[var(--fill-2)]"
          onClick={() => setPalette(true)}
          aria-label="New chat"
        >
          <PencilSimple size={19} />
        </button>
        <button
          className="press focus-ring grid size-8 place-items-center rounded-full text-[var(--label-2)] hover:bg-[var(--fill-2)]"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
        >
          <Gear size={19} />
        </button>
      </div>

      {/* search */}
      <div className="px-3 pb-2 pt-1">
        <div className="flex items-center gap-2 rounded-[10px] bg-[var(--fill-3)] px-2.5 py-[6px] focus-within:bg-[var(--fill-2)] focus-within:ring-2 focus-within:ring-[var(--blue)]/60">
          <MagnifyingGlass size={15} className="shrink-0 text-[var(--label-3)]" />
          <input
            type="search"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-transparent text-[14px] outline-none placeholder:text-[var(--label-3)] [&::-webkit-search-cancel-button]:hidden"
            aria-label="Search chats"
          />
          {query && (
            <button onClick={() => setQuery('')} className="press rounded-full text-[var(--label-3)] hover:text-[var(--label-2)]" aria-label="Clear search">
              <X size={14} weight="bold" />
            </button>
          )}
          <kbd className="hidden shrink-0 text-[11px] text-[var(--label-3)] md:block">Ctrl+K</kbd>
        </div>
      </div>

      {/* filter chips */}
      <div className="flex gap-1.5 overflow-x-auto px-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {FILTERS.map((f) => {
          const active = filter === f.id && !showArchived
          const unreadIn = f.id === 'unread' ? 0 : chipUnread[f.id]
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cx(
                'press shrink-0 rounded-full px-3 py-[5px] text-[13px] font-medium',
                active ? 'bg-[var(--blue)] text-white' : 'bg-[var(--fill-3)] text-[var(--label-2)] hover:bg-[var(--fill-2)]',
              )}
            >
              {f.label}
              {unreadIn > 0 && <span className={cx('ml-1.5 tabular-nums', active ? 'text-white/80' : 'text-[var(--label-3)]')}>{unreadIn}</span>}
            </button>
          )
        })}
      </div>

      {/* archived row */}
      {!showArchived && archivedCount > 0 && !query && (
        <button
          onClick={() => setShowArchived(true)}
          className="mx-2 mb-1 flex items-center gap-3 rounded-[10px] px-2 py-2 text-left hover:bg-[var(--row-hover)]"
        >
          <span className="grid size-[42px] place-items-center rounded-full bg-[var(--fill-3)] text-[var(--label-2)]">
            <Archive size={19} />
          </span>
          <span className="text-[15px] font-semibold">Archived</span>
          <span className="ml-auto text-[13px] tabular-nums text-[var(--label-3)]">{archivedCount}</span>
        </button>
      )}

      {showArchived && (
        <button onClick={() => setShowArchived(false)} className="mx-2 mb-1 flex items-center gap-3 rounded-[10px] px-2 py-2 hover:bg-[var(--row-hover)]">
          <ArrowLeft size={18} className="text-[var(--blue)]" />
          <span className="text-[15px] font-semibold">Archived</span>
        </button>
      )}

      {/* chat list — virtualized */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pb-2" role="listbox" aria-label="Conversations">
        {visible.length === 0 ? (
          <div className="grid h-full place-items-center px-6 text-center">
            <div>
              <div className="text-[15px] font-medium text-[var(--label-2)]">
                {query ? 'No results' : filter === 'unread' ? 'No unread chats' : 'No chats here'}
              </div>
              <div className="mt-1 text-[13px] text-[var(--label-3)]">
                {query ? `Nothing matches “${query}”` : 'Chats will appear here'}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((vi) => (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virt.measureElement}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                role="option"
                aria-selected={activeChat === visible[vi.index]}
              >
                <ChatRow id={visible[vi.index]} active={activeChat === visible[vi.index]} />
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
