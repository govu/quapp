import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { motion, AnimatePresence } from 'motion/react'
import { ArrowDown, LockSimple } from '@phosphor-icons/react'
import type { Chat, Id, Message } from '../bridge/types'
import { dayLabel, sameDay, spring } from '../lib/util'
import { flashDone, loadOlder, useStore } from '../store'
import { MessageRow, type RowCtx } from './Bubble'

type Item =
  | { t: 'msg'; id: Id; ctx: RowCtx }
  | { t: 'day'; key: string; label: string }
  | { t: 'unread'; key: string }
  | { t: 'more'; key: string }
  | { t: 'start'; key: string }
  | { t: 'e2e'; key: string }

const GROUP_GAP = 5 * 60 * 1000

function buildItems(chat: Chat, ids: Id[], map: Map<Id, Message>, hasMore: boolean, unreadIdx: number | null, loaded: boolean, liveMount: number): Item[] {
  const items: Item[] = []
  if (hasMore || !loaded) items.push({ t: 'more', key: 'more' })
  else {
    items.push({ t: 'start', key: 'start' }) // full history on this device
    if (chat.kind === 'dm') items.push({ t: 'e2e', key: 'e2e' })
  }
  let prev: Message | null = null
  const isFirst: boolean[] = []
  const isLast: boolean[] = []
  for (let i = 0; i < ids.length; i++) {
    const m = map.get(ids[i])!
    const n = map.get(ids[i + 1])
    const sys = m.content.kind === 'system'
    isFirst.push(
      !prev || prev.from !== m.from || m.ts - prev.ts > GROUP_GAP || sys ||
      !sameDay(prev.ts, m.ts) || !!m.replyTo,
    )
    isLast.push(
      !n || n.from !== m.from || n.ts - m.ts > GROUP_GAP || n.content.kind === 'system' ||
      !sameDay(m.ts, n.ts) || !!n.replyTo || sys,
    )
    prev = m
  }
  for (let i = 0; i < ids.length; i++) {
    const m = map.get(ids[i])!
    if (i === 0 || !sameDay(map.get(ids[i - 1])!.ts, m.ts)) {
      items.push({ t: 'day', key: `d-${m.id}`, label: dayLabel(m.ts) })
    }
    if (unreadIdx !== null && i === unreadIdx) items.push({ t: 'unread', key: `u-${chat.id}` })
    items.push({ t: 'msg', id: m.id, ctx: { first: isFirst[i], last: isLast[i], chat, live: m.ts > liveMount } })
  }
  return items
}

export const MessageList = memo(function MessageList({ chat, initialUnread }: { chat: Chat; initialUnread: number }) {
  const ids = useStore((s) => s.buckets.get(chat.id)?.ids ?? EMPTY)
  const map = useStore((s) => s.buckets.get(chat.id)?.map)
  const hasMore = useStore((s) => s.buckets.get(chat.id)?.hasMore ?? false)
  const loaded = useStore((s) => s.buckets.get(chat.id)?.loaded ?? false)
  const flashId = useStore((s) => s.flashId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const loadingOlder = useRef(false)
  const mountTs = useRef(Date.now()) // backfill older than mount never counts as "new"
  const prevFirstId = useRef<Id | undefined>(undefined)
  const prevLastId = useRef<Id | undefined>(undefined)
  const prevCount = useRef(0)
  const [away, setAway] = useState(false)
  const [pending, setPending] = useState(0)
  const [scrolled, setScrolled] = useState(false)

  // the unread divider anchors on the count captured when the chat was
  // opened — markRead zeroes chat.unread but the divider must stay put
  const [anchorUnread] = useState(initialUnread)
  const unreadIdx = anchorUnread > 0 && anchorUnread < ids.length ? ids.length - anchorUnread : null

  const items = useMemo(
    () => (map ? buildItems(chat, ids, map, hasMore, unreadIdx, loaded, mountTs.current) : []),
    [chat, ids, map, hasMore, unreadIdx, loaded],
  )

  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const it = items[i]
      return it.t === 'day' || it.t === 'unread' || it.t === 'e2e' ? 44 : it.t === 'more' || it.t === 'start' ? 48 : 42
    },
    overscan: 14,
    getItemKey: (i) => (items[i].t === 'msg' ? items[i].id : items[i].key),
  })

  // initial position: bottom, or the unread divider when there is one
  useEffect(() => {
    atBottom.current = unreadIdx === null
    prevFirstId.current = ids[0]
    prevLastId.current = ids[ids.length - 1]
    const target = unreadIdx !== null ? Math.max(0, ids.length - initialUnread) : items.length - 1
    if (items.length) {
      virt.scrollToIndex(Math.min(target, items.length - 1), { align: unreadIdx !== null ? 'start' : 'end' })
      requestAnimationFrame(() =>
        virt.scrollToIndex(Math.min(target, items.length - 1), { align: unreadIdx !== null ? 'start' : 'end' }),
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // stay pinned to bottom when the tail changes; count arrivals while scrolled away
  useEffect(() => {
    const last = ids[ids.length - 1]
    if (prevLastId.current !== last) {
      const lastMsg = map?.get(last)
      // only genuinely-new messages (arriving after this list mounted) bump the pill —
      // history merges and on-demand fetches grow the list but aren't "new"
      const isNew = !!lastMsg && lastMsg.ts > mountTs.current - 1000
      if (atBottom.current && items.length) {
        requestAnimationFrame(() => virt.scrollToIndex(items.length - 1, { align: 'end' }))
      } else if (isNew && prevLastId.current) {
        setPending((p) => p + 1)
      }
      prevLastId.current = last
    }
    prevCount.current = ids.length
  }, [ids, items.length, virt, map])

  // when the first id changes (older page prepended), keep the previous first row anchored
  useEffect(() => {
    const first = ids[0]
    if (prevFirstId.current && first !== prevFirstId.current) {
      const idx = items.findIndex((it) => it.t === 'msg' && it.id === prevFirstId.current)
      if (idx >= 0) virt.scrollToIndex(idx, { align: 'start' })
    }
    prevFirstId.current = first
  }, [ids, items, virt])

  // jump-to-result: scroll + flash
  useEffect(() => {
    if (!flashId) return
    const idx = items.findIndex((it) => it.t === 'msg' && it.id === flashId)
    if (idx >= 0) {
      virt.scrollToIndex(idx, { align: 'center', behavior: 'smooth' })
      const t = setTimeout(flashDone, 1700)
      return () => clearTimeout(t)
    }
    flashDone()
  }, [flashId, items, virt])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atB = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    atBottom.current = atB
    setAway(!atB)
    setScrolled(el.scrollTop > 30)
    if (atB) setPending((p) => (p ? 0 : p))
    if (el.scrollTop < 300 && hasMore && !loadingOlder.current) {
      loadingOlder.current = true
      loadOlder(chat.id).finally(() => { loadingOlder.current = false })
    }
  }, [chat.id, hasMore])

  const jumpDown = () => {
    virt.scrollToIndex(items.length - 1, { align: 'end', behavior: 'smooth' })
    setPending(0)
  }

  // floating date: the day owning the first visible row — O(1), no walk
  const firstVis = items[virt.getVirtualItems()[0]?.index ?? 0]
  const floatLabel =
    firstVis?.t === 'day' ? firstVis.label
    : firstVis?.t === 'msg' ? dayLabel(map!.get(firstVis.id)!.ts)
    : null

  return (
    <div className="absolute inset-0">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="absolute inset-0 overflow-y-auto overscroll-contain py-2"
        role="log"
        aria-label="Messages"
      >
      <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
        {virt.getVirtualItems().map((vi) => {
          const it = items[vi.index]
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virt.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
            >
              {it.t === 'day' && (
                <div className="my-2 grid place-items-center">
                  <span className="pill rounded-full px-3 py-[5px] text-[12px] font-medium text-[var(--label-2)]">{it.label}</span>
                </div>
              )}
              {it.t === 'more' && <LoadingRow done={false} />}
              {it.t === 'start' && <LoadingRow done />}
              {it.t === 'unread' && (
                <div className="my-2 grid place-items-center">
                  <span className="pill rounded-full px-3 py-[5px] text-[12px] font-medium text-[var(--blue)]">Unread messages</span>
                </div>
              )}
              {it.t === 'e2e' && (
                <div className="mb-3 grid place-items-center px-8">
                  <span className="pill flex items-center gap-1.5 rounded-full px-3 py-[6px] text-[11.5px] font-medium text-[var(--label-2)]">
                    <LockSimple size={12} weight="bold" className="text-[var(--green)]" />
                    Messages are end-to-end encrypted
                  </span>
                </div>
              )}
              {it.t === 'msg' && <MessageRow id={it.id} ctx={it.ctx} />}
            </div>
          )
        })}
      </div>
      </div>

      {/* floating day pill — tracks the topmost visible date while scrolling */}
      <AnimatePresence>
        {scrolled && floatLabel && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
            className="pointer-events-none absolute left-1/2 top-2.5 z-20 -translate-x-1/2"
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={floatLabel}
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.08 } }}
                className="menu-material block rounded-full px-3 py-[5px] text-[12px] font-medium text-[var(--label-2)]"
              >
                {floatLabel}
              </motion.span>
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* jump-to-latest pill — appears when scrolled away from the tail */}
      <AnimatePresence>
        {away && items.length > 0 && (
          <motion.button
            initial={{ opacity: 0, scale: 0.85, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 8, transition: { duration: 0.1 } }}
            transition={spring.pop}
            onClick={jumpDown}
            className="menu-material absolute bottom-3 right-4 z-20 flex items-center gap-1.5 rounded-full py-[7px] pl-[9px] pr-[11px] text-[var(--label-2)]"
            aria-label="Jump to latest messages"
          >
            <ArrowDown size={15} weight="bold" />
            {pending > 0 && (
              <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-[var(--blue)] px-[5px] text-[10.5px] font-semibold tabular-nums text-white">
                {pending > 99 ? '99+' : pending}
              </span>
            )}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
})

const EMPTY: Id[] = []

function LoadingRow({ done }: { done: boolean }) {
  return (
    <div className="grid place-items-center py-3">
      {done ? (
        <span className="text-[12px] text-[var(--label-3)]">Beginning of conversation</span>
      ) : (
        <span className="size-5 animate-spin rounded-full border-2 border-[var(--fill)] border-t-[var(--label-3)]" />
      )}
    </div>
  )
}
