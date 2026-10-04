import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import {
  ChatCircle, Checks, CircleHalf, Gear, MagnifyingGlass, Moon, Sun, User, X,
} from '@phosphor-icons/react'
import type { Message } from '../bridge/types'
import { cx, highlight, spring, timeLabel } from '../lib/util'
import {
  closeChat, jumpTo, markAllRead, openChat, openContactChat, setPalette, setPane, setSettingsOpen,
  updateSettings, useStore,
} from '../store'
import { Avatar } from './common'
import { previewOf } from './Bubble'

interface Item {
  key: string
  section: string
  icon: React.ReactNode
  title: React.ReactNode
  sub?: React.ReactNode
  trailing?: React.ReactNode
  run: () => void
}

const K = (s: string) => (
  <kbd className="rounded-[5px] border border-[var(--separator-strong)] bg-[var(--fill-4)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--label-3)]">{s}</kbd>
)

export const Palette = memo(function Palette() {
  const open = useStore((s) => s.paletteOpen)
  const chats = useStore((s) => s.chats)
  const order = useStore((s) => s.order)
  const contacts = useStore((s) => s.contacts)
  const theme = useStore((s) => s.settings.theme)
  const adapter = useStore((s) => s.adapter)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const [prevQ, setPrevQ] = useState('')
  const [hits, setHits] = useState<Message[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // reset the active row when the query changes (render-time adjustment)
  if (prevQ !== q) {
    setPrevQ(q)
    setIdx(0)
  }

  // reset + focus on open
  useEffect(() => {
    if (open) {
      setQ('')
      setIdx(0)
      setHits([])
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // cross-chat message search, debounced
  useEffect(() => {
    if (!open || q.trim().length < 2 || !adapter) { setHits([]); return }
    const t = setTimeout(() => {
      adapter.searchAll(q).then((r) => { if (useStore.getState().paletteOpen) setHits(r.slice(0, 5)) })
    }, 140)
    return () => clearTimeout(t)
  }, [q, open, adapter])

  const items = useMemo<Item[]>(() => {
    const l = q.trim().toLowerCase()
    const out: Item[] = []
    const close = () => setPalette(false)

    // actions — always available, filtered by query
    const actions: { name: string; icon: React.ReactNode; kbd?: string; run: () => void }[] = [
      {
        name: theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
        icon: theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />,
        run: () => updateSettings({ theme: theme === 'dark' ? 'light' : 'dark' }),
      },
      { name: 'Mark all as read', icon: <Checks size={17} />, run: markAllRead },
      { name: 'Search in this chat', icon: <MagnifyingGlass size={17} />, kbd: 'Ctrl+F', run: () => setPane('search') },
      { name: 'Open settings', icon: <Gear size={17} />, kbd: 'Ctrl+,', run: () => setSettingsOpen(true) },
      { name: 'Close active chat', icon: <CircleHalf size={17} />, run: closeChat },
    ]
    for (const a of actions) {
      if (l && !a.name.toLowerCase().includes(l)) continue
      out.push({
        key: `act-${a.name}`, section: 'Actions', icon: a.icon,
        title: a.name, trailing: a.kbd ? K(a.kbd) : undefined,
        run: () => { a.run(); close() },
      })
    }

    // chats
    const chatList = order
      .map((id) => chats.get(id)!)
      .filter((c) => c && !c.archived && (!l || c.title.toLowerCase().includes(l)))
      .slice(0, l ? 8 : 5)
    for (const c of chatList) {
      out.push({
        key: `chat-${c.id}`, section: 'Chats',
        icon: <Avatar name={c.title} hue={c.avatarHue} url={c.avatarUrl} size={30} />,
        title: l ? <Hl text={c.kind === 'saved' ? 'You' : c.title} q={q} /> : c.kind === 'saved' ? 'You' : c.title,
        trailing: c.unread > 0 ? (
          <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-[var(--blue)] px-[5px] text-[10.5px] font-semibold text-white">{c.unread}</span>
        ) : undefined,
        run: () => { openChat(c.id); close() },
      })
    }

    // contacts without an open chat → start one
    if (l) {
      const inChats = new Set([...chats.values()].map((c) => c.contactId))
      const cl = [...contacts.values()]
        .filter((c) => !inChats.has(c.id) && c.name.toLowerCase().includes(l))
        .slice(0, 4)
      for (const c of cl) {
        out.push({
          key: `ct-${c.id}`, section: 'New chat',
          icon: <Avatar name={c.name} hue={c.avatarHue} url={c.avatarUrl} size={30} />,
          title: <Hl text={c.name} q={q} />,
          sub: c.phone,
          trailing: <ChatCircle size={15} className="text-[var(--label-3)]" />,
          run: () => { void openContactChat(c.id); close() },
        })
      }
    }

    // messages across all chats
    for (const m of hits) {
      const c = chats.get(m.chatId)
      out.push({
        key: `msg-${m.id}`, section: 'Messages',
        icon: <Avatar name={c?.title ?? '?'} hue={c?.avatarHue ?? 0} size={30} />,
        title: <Hl text={previewOf(m)} q={q} />,
        sub: `${c?.title ?? ''} · ${timeLabel(m.ts)}`,
        run: () => { openChat(m.chatId); jumpTo(m.chatId, m.id); close() },
      })
    }
    return out
  }, [q, chats, order, contacts, hits, theme])

  useEffect(() => {
    // keep the active row in view
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.key === 'j' && e.ctrlKey)) { e.preventDefault(); setIdx((i) => Math.min(i + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp' || (e.key === 'k' && e.ctrlKey)) { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); items[idx]?.run() }
    else if (e.key === 'Escape') { e.preventDefault(); setPalette(false) }
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-[75] flex items-start justify-center pt-[14vh]"
          onClick={() => setPalette(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -6, transition: { duration: 0.1 } }}
            transition={spring.pop}
            className="menu-material flex max-h-[62vh] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-[16px]"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Command palette"
          >
            <div className="flex items-center gap-3 border-b border-[var(--separator)] px-4">
              <MagnifyingGlass size={18} className="shrink-0 text-[var(--label-3)]" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKey}
                placeholder="Search chats, messages, people, actions…"
                className="h-[52px] w-full bg-transparent text-[17px] outline-none placeholder:text-[var(--label-3)]"
                aria-label="Command palette"
              />
              <button onClick={() => setPalette(false)} className="press rounded-full p-1 text-[var(--label-3)] hover:bg-[var(--fill-2)]" aria-label="Close">
                <X size={16} weight="bold" />
              </button>
            </div>
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {items.length === 0 ? (
                <div className="grid h-28 place-items-center text-[13.5px] text-[var(--label-3)]">
                  No results for “{q}”
                </div>
              ) : (
                items.map((it, i) => (
                  <div key={it.key}>
                    {(i === 0 || items[i - 1].section !== it.section) && (
                      <div className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--label-3)]">
                        {it.section}
                      </div>
                    )}
                    <button
                      data-idx={i}
                      onMouseEnter={() => setIdx(i)}
                      onClick={it.run}
                      className={cx(
                        'flex w-full items-center gap-3 rounded-[9px] px-3 py-[7px] text-left',
                        i === idx ? 'bg-[var(--blue)] text-white' : 'hover:bg-[var(--fill-3)]',
                      )}
                    >
                      <span className={cx('grid size-[30px] shrink-0 place-items-center', i === idx && 'text-white')}>{it.icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className={cx('block truncate text-[14.5px]', i === idx && '[&_mark]:bg-white/30 [&_mark]:text-white')}>{it.title}</span>
                        {it.sub && <span className={cx('block truncate text-[12px]', i === idx ? 'text-white/70' : 'text-[var(--label-3)]')}>{it.sub}</span>}
                      </span>
                      {it.trailing}
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="flex items-center gap-3 border-t border-[var(--separator)] px-4 py-2 text-[11px] text-[var(--label-3)]">
              <span className="flex items-center gap-1">{K('↑↓')} navigate</span>
              <span className="flex items-center gap-1">{K('↵')} open</span>
              <span className="flex items-center gap-1">{K('esc')} close</span>
              <span className="ml-auto flex items-center gap-1"><User size={12} /> contacts start new chats</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
})

function Hl({ text, q }: { text: string; q: string }) {
  return (
    <>
      {highlight(text, q.trim()).map((p, i) =>
        typeof p === 'string' ? <span key={i}>{p}</span> : <mark key={i}>{p.mark}</mark>,
      )}
    </>
  )
}
