import { useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import {
  Archive, ArrowUp, BellSlash, Checks, Copy, MagnifyingGlass, Phone, PushPin,
  Share, Trash, User, VideoCamera, X,
} from '@phosphor-icons/react'
import type { Chat } from '../bridge/types'
import { cx, listTime, sameDay, spring, timeLabel } from '../lib/util'
import {
  clearSelection, confirmClearChat, confirmDeleteChat, doCallHandoff, doDelete, doFlag, doMarkUnread, sendFiles, setForwarding, setPane, useStore,
} from '../store'
import { Avatar } from './common'
import { MessageList } from './MessageList'
import { Composer } from './Composer'
import { SearchPane, InfoPane, StarredPane } from './Panes'
import { showContextMenu } from './Menu'

export function Conversation() {
  const activeChat = useStore((s) => s.activeChat)
  const chat = useStore((s) => (s.activeChat ? s.chats.get(s.activeChat) : undefined))
  const pane = useStore((s) => s.pane)
  const selection = useStore((s) => s.selection !== null)
  const wallpaper = useStore((s) => s.settings.wallpaper)
  // captured at open-time before markRead zeroed the badge — keeps the
  // "Unread messages" divider anchored
  const openUnread = useStore((s) => s.openUnread)
  // drag-enter counter — nested children each fire enter/leave, so a bool
  // flickers; counting stays solid while files are over the chat
  const [drag, setDrag] = useState(0)

  if (!chat || !activeChat) {
    return (
      <div className="relative flex min-w-0 flex-1 flex-col">
        <EmptyState />
        <AnimatePresence>{pane === 'starred' && <StarredPane key="st" />}</AnimatePresence>
      </div>
    )
  }

  return (
    <div
      className="relative flex min-w-0 flex-1 flex-col"
      onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag((d) => d + 1) } }}
      onDragLeave={() => setDrag((d) => Math.max(0, d - 1))}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDrag(0)
        sendFiles(chat.id, e.dataTransfer.files)
      }}
    >
      {selection ? <SelectionBar chat={chat} /> : <Header chat={chat} />}

      <div className={cx('relative min-h-0 flex-1', wallClass(wallpaper))}>
        <MessageList key={chat.id} chat={chat} initialUnread={openUnread} />
      </div>

      <Composer chat={chat} />

      <AnimatePresence>
        {pane === 'search' && <SearchPane key="sp" chat={chat} />}
        {pane === 'info' && <InfoPane key="ip" chat={chat} />}
        {pane === 'starred' && <StarredPane key="st" />}
      </AnimatePresence>

      {/* drop target — WhatsApp Web style */}
      <AnimatePresence>
        {drag > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="pointer-events-none absolute inset-0 z-40 grid place-items-center bg-[var(--bg)]/80 p-6 backdrop-blur-sm"
          >
            <div className="grid w-full max-w-sm place-items-center gap-3 rounded-[20px] border-2 border-dashed border-[var(--blue)] bg-[var(--blue)]/5 py-10">
              <span className="grid size-14 place-items-center rounded-full bg-[var(--blue)] text-white">
                <ArrowUp size={26} weight="bold" />
              </span>
              <span className="text-[15px] font-medium">Drop files to send to {chat.title}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function wallClass(w: string) {
  switch (w) {
    case 'pattern': return 'wall-pattern'
    case 'dusk': return 'wall-dusk'
    case 'none': return 'wall-none'
    default: return 'wall-default'
  }
}

function Header({ chat }: { chat: Chat }) {
  const pane = useStore((s) => s.pane)
  const typing = useStore((s) => s.typing.get(chat.id))
  const online = useStore((s) => s.online.get(chat.id))

  const menu = (e: React.MouseEvent) => {
    showContextMenu(e, [
      { label: 'Chat info', icon: <User size={16} />, onClick: () => setPane('info') },
      { label: 'Search in chat', icon: <MagnifyingGlass size={16} />, onClick: () => setPane('search') },
      { label: 'Unmute', icon: <BellSlash size={16} />, onClick: () => doFlag(chat.id, 'muted', false), separatorAbove: true, hidden: !chat.muted },
      { label: 'Mute · 8 hours', icon: <BellSlash size={16} />, onClick: () => doFlag(chat.id, 'muted', true, 8 * 3600e3), separatorAbove: true, hidden: chat.muted },
      { label: 'Mute · 1 week', icon: <BellSlash size={16} />, onClick: () => doFlag(chat.id, 'muted', true, 7 * 86400e3), hidden: chat.muted },
      { label: 'Mute always', icon: <BellSlash size={16} />, onClick: () => doFlag(chat.id, 'muted', true), hidden: chat.muted },
      { label: chat.pinned ? 'Unpin' : 'Pin', icon: <PushPin size={16} />, onClick: () => doFlag(chat.id, 'pinned', !chat.pinned) },
      { label: 'Mark as unread', icon: <Checks size={16} />, onClick: () => doMarkUnread(chat.id, true) },
      { label: 'Archive', icon: <Archive size={16} />, onClick: () => doFlag(chat.id, 'archived', true), separatorAbove: true },
      { label: 'Clear chat', icon: <Trash size={16} />, onClick: () => confirmClearChat(chat.id), separatorAbove: true, hidden: chat.kind === 'saved' },
      { label: 'Delete chat', icon: <Trash size={16} />, destructive: true, onClick: () => confirmDeleteChat(chat.id), hidden: chat.kind === 'saved' },
    ])
  }

  const subtitle = typing?.length
    ? chat.kind === 'group' ? `${typing.join(', ')} typing…` : 'typing…'
    : online
      ? 'online'
      : chat.kind === 'group'
        ? `${chat.participants.length} members`
        : chat.kind === 'channel'
          ? 'Channel'
          : chat.kind === 'saved'
            ? 'Message yourself'
            : chat.lastSeen
              ? `last seen ${sameDay(chat.lastSeen, Date.now()) ? timeLabel(chat.lastSeen) : listTime(chat.lastSeen)}`
              : ''

  return (
    <div className="chrome hairline-b caption-inset drag z-20 flex h-[56px] shrink-0 items-center gap-3 px-4">
      <button onClick={() => setPane(pane === 'info' ? null : 'info')} className="press no-drag flex min-w-0 items-center gap-3 rounded-lg py-1 pr-2 text-left" onContextMenu={menu}>
        <Avatar name={chat.title} hue={chat.avatarHue} url={chat.avatarUrl} size={36} />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold leading-[19px]">{chat.kind === 'saved' ? 'You' : chat.title}</div>
          <div className={cx('truncate text-[12px] leading-[15px]', typing?.length || online ? 'text-[var(--green)]' : 'text-[var(--label-3)]')}>
            {subtitle}
          </div>
        </div>
      </button>
      <div className="no-drag ml-auto flex items-center gap-0.5">
        {chat.kind !== 'channel' && chat.kind !== 'saved' && (
          <>
            <IconBtn label="Voice call" onClick={() => doCallHandoff(chat.id, false)}><Phone size={19} /></IconBtn>
            <IconBtn label="Video call" onClick={() => doCallHandoff(chat.id, true)}><VideoCamera size={21} /></IconBtn>
          </>
        )}
        <IconBtn label="Search in chat" active={pane === 'search'} onClick={() => setPane(pane === 'search' ? null : 'search')}>
          <MagnifyingGlass size={19} />
        </IconBtn>
      </div>
    </div>
  )
}

function IconBtn({ children, label, onClick, active }: { children: React.ReactNode; label: string; onClick?: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={cx(
        'press focus-ring grid size-[34px] place-items-center rounded-full',
        active ? 'bg-[var(--blue)]/15 text-[var(--blue)]' : 'text-[var(--label-2)] hover:bg-[var(--fill-2)]',
      )}
    >
      {children}
    </button>
  )
}

function SelectionBar({ chat }: { chat: Chat }) {
  const selection = useStore((s) => s.selection)!
  const bucket = useStore((s) => s.buckets.get(chat.id))
  const msgs = useMemo(
    () => [...selection].map((id) => bucket?.map.get(id)).filter(Boolean) as import('../bridge/types').Message[],
    [selection, bucket],
  )
  const allMine = msgs.every((m) => m.from === 'me')
  return (
    <motion.div
      initial={{ y: -56 }}
      animate={{ y: 0 }}
      transition={spring.snappy}
      className="chrome hairline-b caption-inset drag z-20 flex h-[56px] shrink-0 items-center gap-2 px-4"
    >
      <span className="text-[15px] font-semibold tabular-nums">{selection.size} selected</span>
      <div className="ml-auto flex items-center gap-1">
        <IconBtn label="Copy" onClick={() => {
          navigator.clipboard.writeText(msgs.map((m) => (m.content.kind === 'text' ? m.content.text : '')).join('\n'))
          clearSelection()
        }}>
          <Copy size={18} />
        </IconBtn>
        <IconBtn label="Forward" onClick={() => setForwarding(msgs)}>
          <Share size={18} />
        </IconBtn>
        <IconBtn label="Delete" onClick={() => doDelete(chat.id, [...selection], false)}>
          <Trash size={18} />
        </IconBtn>
        {allMine && (
          <button
            onClick={() => doDelete(chat.id, [...selection], true)}
            className="press rounded-full px-3 py-1.5 text-[13.5px] font-medium text-[var(--red)] hover:bg-[var(--red)]/10"
          >
            Delete for everyone
          </button>
        )}
        <IconBtn label="Cancel" onClick={clearSelection}>
          <X size={18} weight="bold" />
        </IconBtn>
      </div>
    </motion.div>
  )
}

function EmptyState() {
  return (
    <div className="wall-none relative grid flex-1 place-items-center">
      {/* window drag strip under the caption overlay */}
      <div className="drag absolute inset-x-0 top-0 h-[56px]" />
      <div className="flex flex-col items-center text-center">
        <div className="grid size-[84px] place-items-center rounded-[24px] bg-[var(--fill-3)]">
          <svg width="42" height="42" viewBox="0 0 64 64" aria-hidden>
            <defs>
              <linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--blue)" />
                <stop offset="1" stopColor="#0a5ce0" />
              </linearGradient>
            </defs>
            <path d="M32 12C20.4 12 11 20.4 11 30c0 5.2 2.7 10 7 13.1L16.5 52l8.6-2.7c2.2.6 4.5.9 6.9.9 11.6 0 21-8.4 21-18.2S43.6 12 32 12z" fill="url(#eg)" />
          </svg>
        </div>
        <div className="mt-5 text-[22px] font-semibold tracking-[-0.01em]">Quapp</div>
        <div className="mt-1 max-w-[280px] text-[14px] leading-[19px] text-[var(--label-2)]">
          Pick a conversation, or press <b>Ctrl+K</b> to search.
        </div>
      </div>
    </div>
  )
}
