import type { Transition } from 'motion/react'

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ')

// ---- Apple-style springs (damping≈1 default, slight bounce only for momentum-y UI) ----
export const spring = {
  /** default UI settle, critically damped */
  snappy: { type: 'spring', duration: 0.32, bounce: 0 } as Transition,
  /** drawers/sheets */
  sheet: { type: 'spring', duration: 0.45, bounce: 0.12 } as Transition,
  /** small popovers/menus — fast, tiny overshoot */
  pop: { type: 'spring', duration: 0.28, bounce: 0.18 } as Transition,
  /** playful, only where momentum is implied */
  bouncy: { type: 'spring', duration: 0.5, bounce: 0.3 } as Transition,
}

export const easeOut = [0.23, 1, 0.32, 1] as const

// ---- seeded rng for deterministic demo data ----
export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

let uidCounter = 0
export const uid = () => `m${Date.now().toString(36)}${(uidCounter++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`

// ---- time ----
export const DAY = 86400000

export function sameDay(a: number, b: number) {
  const da = new Date(a), db = new Date(b)
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate()
}

export function dayLabel(ts: number, now = Date.now()) {
  if (sameDay(ts, now)) return 'Today'
  if (sameDay(ts, now - DAY)) return 'Yesterday'
  const d = new Date(ts)
  if (now - ts < 6 * DAY) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' })
}

export function timeLabel(ts: number) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** chat list timestamp: time today, weekday within a week, date older */
export function listTime(ts: number, now = Date.now()) {
  if (sameDay(ts, now)) return timeLabel(ts)
  if (sameDay(ts, now - DAY)) return 'Yesterday'
  if (now - ts < 6 * DAY) return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' })
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'numeric', year: '2-digit' })
}

export function durationLabel(sec: number) {
  const m = Math.floor(sec / 60), s = Math.round(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function fileSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** "+573012345678" → "+57 301 234 5678" — country code + last 10 in 3-3-4.
 *  Names that aren't bare phone numbers pass through untouched. */
export function formatPhone(title: string): string {
  const m = /^\+(\d{7,15})$/.exec(title)
  if (!m) return title
  const d = m[1]
  const cc = d.slice(0, Math.max(1, d.length - 10))
  const rest = d.slice(-10)
  return `+${cc} ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`
}

// WhatsApp-style markup: *bold* _italic_ ~strike~ `code`
export function renderMarkup(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  let h = esc(text)
  h = h.replace(/`([^`]+)`/g, '<code class="font-mono text-[0.85em] bg-black/10 dark:bg-white/10 rounded px-1 py-0.5">$1</code>')
  h = h.replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
  h = h.replace(/_([^_\n]+)_/g, '<i>$1</i>')
  h = h.replace(/~([^~\n]+)~/g, '<s>$1</s>')
  h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>')
  h = h.replace(/\n/g, '<br>')
  return h
}

export const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\uFE0F|\u200D|\s){1,24}$/u
export const isEmojiOnly = (t: string) => EMOJI_ONLY.test(t.trim()) && t.trim().length <= 46

/** highlight `q` in `text` -> React nodes with <mark> */
export function highlight(text: string, q: string): (string | { mark: string })[] {
  if (!q) return [text]
  const out: (string | { mark: string })[] = []
  const low = text.toLowerCase(), lq = q.toLowerCase()
  let i = 0
  for (;;) {
    const j = low.indexOf(lq, i)
    if (j < 0) { out.push(text.slice(i)); break }
    if (j > i) out.push(text.slice(i, j))
    out.push({ mark: text.slice(j, j + q.length) })
    i = j + q.length
  }
  return out
}
