import { create } from 'zustand'
import type {
  Account, Chat, ClientAdapter, Contact, Id, Message, MsgContent, OutContent, ReplyRef, ServerEvent,
} from './bridge/types'

export type Filter = 'all' | 'unread' | 'favorites' | 'groups'
export type Pane = 'search' | 'info' | null

export interface Toast {
  id: number
  text: string
  icon?: 'check' | 'error' | 'info'
}

export type Accent = 'blue' | 'green' | 'purple' | 'pink' | 'orange' | 'teal'

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  wallpaper: 'default' | 'pattern' | 'dusk' | 'none'
  accent: Accent
  enterToSend: boolean
  readReceipts: boolean
  linkPreviews: boolean
  animLevel: 'full' | 'reduced'
  /** desktop notifications + sound */
  notifications: boolean
  notifPreview: boolean
  notifSound: boolean
  autoDlPhotos: boolean
  autoDlDocs: boolean
  /** WhatsApp-side privacy values, mirrored to the phone on change */
  privLastSeen: 'everyone' | 'contacts' | 'nobody'
  privPhoto: 'everyone' | 'contacts' | 'nobody'
  privGroups: 'everyone' | 'contacts' | 'nobody'
}

interface ChatBucket {
  ids: Id[]
  map: Map<Id, Message>
  hasMore: boolean
  loaded: boolean
}

interface State {
  phase: 'linking' | 'ready'
  account: Account | null
  adapter: ClientAdapter | null
  chats: Map<Id, Chat>
  order: Id[]
  contacts: Map<Id, Contact>
  /** live history-sync counters while chunks stream in */
  syncing: { chats: number; contacts: number; messages: number; progress?: number } | null
  buckets: Map<Id, ChatBucket>
  typing: Map<Id, string[]>
  activeChat: Id | null
  pane: Pane
  query: string
  filter: Filter
  showArchived: boolean
  selection: Set<Id> | null
  replyTo: ReplyRef | null
  editing: Message | null
  flashId: Id | null
  searchHits: Message[] | null
  toasts: Toast[]
  settingsOpen: boolean
  settings: Settings
  forwarding: Message[] | null
  online: Map<Id, boolean>
  /** unsent composer text per chat */
  drafts: Map<Id, string>
  paletteOpen: boolean
  /** pairing QR payload pushed by a real bridge (null in demo / once linked) */
  qrString: string | null
  bridgeStatus: 'idle' | 'connecting' | 'ready' | 'error'
  demoMode: boolean
  /** confirm sheet: link a different account (replaces current session) */
  relinkPrompt: boolean
  /** unread count captured when the active chat was opened — survives markRead */
  openUnread: number
}

let toastId = 0

const sortChats = (chats: Map<Id, Chat>): Id[] =>
  [...chats.values()]
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
      return b.lastActivity - a.lastActivity
    })
    .map((c) => c.id)

const SETTINGS_KEY = 'quapp.settings.v1'

function loadSettings(): Settings {
  const base: Settings = {
    theme: 'system',
    wallpaper: 'pattern',
    accent: 'blue',
    enterToSend: true,
    readReceipts: true,
    linkPreviews: true,
    animLevel: 'full',
    notifications: true,
    notifPreview: true,
    notifSound: true,
    autoDlPhotos: true,
    autoDlDocs: false,
    privLastSeen: 'contacts',
    privPhoto: 'everyone',
    privGroups: 'contacts',
  }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? { ...base, ...JSON.parse(raw) } : base
  } catch {
    return base
  }
}

export const useStore = create<State>(() => ({
  phase: 'linking',
  account: null,
  adapter: null,
  chats: new Map(),
  order: [],
  contacts: new Map(),
  syncing: null,
  buckets: new Map(),
  typing: new Map(),
  activeChat: null,
  pane: null,
  query: '',
  filter: 'all',
  showArchived: false,
  selection: null,
  replyTo: null,
  editing: null,
  flashId: null,
  searchHits: null,
  toasts: [],
  settingsOpen: false,
  forwarding: null,
  online: new Map(),
  drafts: new Map(),
  paletteOpen: false,
  qrString: null,
  bridgeStatus: 'idle',
  demoMode: true,
  relinkPrompt: false,
  openUnread: 0,
  settings: loadSettings(),
}))

const set = useStore.setState
const get = useStore.getState

const patch = (p: Partial<State>) => set(p)

export function toast(text: string, icon: Toast['icon'] = 'info') {
  const id = ++toastId
  set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, icon }] }))
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3200)
}

// ---------- desktop notifications ----------

let notifAllowed: NotificationPermission | 'unsupported' = 'default'
function ensureNotifPermission() {
  if (typeof Notification === 'undefined') { notifAllowed = 'unsupported'; return }
  if (notifAllowed !== 'granted' && notifAllowed !== 'denied')
    void Notification.requestPermission().then((p) => { notifAllowed = p })
}

let audioCtx: AudioContext | null = null
function notifBlip() {
  try {
    audioCtx ??= new AudioContext()
    const t = audioCtx.currentTime
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(1046, t) // C6 — short two-tone blip
    osc.frequency.setValueAtTime(1318, t + 0.07)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.08, t + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
    osc.connect(gain).connect(audioCtx.destination)
    osc.start(t); osc.stop(t + 0.24)
  } catch { /* no audio device */ }
}

function notifyMessage(msg: Message) {
  const { settings, activeChat, chats } = get()
  if (!settings.notifications || notifAllowed === 'denied' || notifAllowed === 'unsupported') return
  const chat = chats.get(msg.chatId)
  if (chat?.muted) return
  const focused = document.hasFocus() && activeChat === msg.chatId
  if (!focused && settings.notifSound) notifBlip()
  if (focused || notifAllowed !== 'granted') return
  const sender = chat?.kind === 'group' && msg.fromName ? `${chat.title} — ${msg.fromName}` : (chat?.title ?? msg.fromName ?? 'Quapp')
  const preview = settings.notifPreview ? previewText(msg) : 'New message'
  const n = new Notification(sender, { body: preview, tag: `quapp-${msg.chatId}`, icon: chat?.avatarUrl })
  n.onclick = () => { window.focus(); openChat(msg.chatId) }
}

function previewText(m: Message): string {
  const c = m.content
  switch (c.kind) {
    case 'text': return c.text.slice(0, 140)
    case 'image': return c.caption ? `📷 ${c.caption}` : '📷 Photo'
    case 'video': return '🎬 Video'
    case 'audio': return c.voice ? '🎤 Voice message' : '🎵 Audio'
    case 'document': return `📄 ${c.name}`
    case 'sticker': return `Sticker ${c.emoji}`
    case 'poll': return `📊 ${c.question}`
    case 'location': return '📍 Location'
    default: return 'New message'
  }
}

// unread badge in the window title — updates whenever the chat map changes
function updateTitle(chats: Map<Id, Chat>) {
  const n = [...chats.values()].reduce((a, c) => a + (!c.archived && !c.muted ? c.unread + (c.markedUnread ? 1 : 0) : 0), 0)
  document.title = n ? `(${n}) Quapp` : 'Quapp'
}
useStore.subscribe((s, prev) => {
  if (s.chats !== prev.chats) updateTitle(s.chats)
})

// ---------- event application ----------
//
// The daemon can emit thousands of events per second during history replay.
// Applying each one through set() cloned every bucket+chat map per message
// (O(n²)) and re-rendered the whole chat list per event. Events now queue
// and flush once per macrotask: draft maps are cloned lazily once per
// touched chat and committed in a single set() — ZapFast's "event-driven,
// coalesce per frame" model.

let eventQueue: ServerEvent[] = []
let flushScheduled = false
let bootTimer: ReturnType<typeof setTimeout> | null = null

function applyEvent(e: ServerEvent) {
  eventQueue.push(e)
  if (flushScheduled) return
  flushScheduled = true
  setTimeout(() => { flushScheduled = false; flushEvents() }, 0)
}

function scheduleBoot() {
  if (bootTimer) return
  bootTimer = setTimeout(() => { bootTimer = null; retryBoot() }, 300)
}

function flushEvents() {
  const events = eventQueue
  eventQueue = []
  if (!events.length) return

  const s = get()
  const chats = new Map(s.chats)
  const buckets = new Map(s.buckets)
  const typing = new Map(s.typing)
  const online = new Map(s.online)
  const settings = s.settings
  const activeChat = s.activeChat
  let chatsTouched = false
  let bucketsTouched = false
  let typingTouched = false
  let onlineTouched = false
  let activeTouched: Id | null | undefined

  // lazily-cloned per-chat message maps — each chat's map clones at most once
  // per flush no matter how many events touch it
  const drafts = new Map<Id, Map<Id, Message>>()
  const draft = (chatId: Id): Map<Id, Message> | null => {
    let d = drafts.get(chatId)
    if (d) return d
    const b = buckets.get(chatId)
    if (!b) return null
    d = new Map(b.map)
    drafts.set(chatId, d)
    return d
  }
  const commitDraft = (chatId: Id) => {
    const d = drafts.get(chatId)
    if (!d) return
    const b = buckets.get(chatId)
    if (b) buckets.set(chatId, { ...b, map: d })
    drafts.delete(chatId)
    bucketsTouched = true
  }

  const upsert = (msg: Message, backfill: boolean) => {
    const b = buckets.get(msg.chatId)
    if (b) {
      const map = draft(msg.chatId)!
      const prev = map.get(msg.id)
      map.set(msg.id, { ...msg, v: (prev?.v ?? 0) + 1 })
      if (!prev) buckets.set(msg.chatId, { ...b, map, ids: [...b.ids, msg.id] })
    } else {
      buckets.set(msg.chatId, { ids: [msg.id], map: new Map([[msg.id, { ...msg, v: 1 }]]), hasMore: false, loaded: true })
    }
    bucketsTouched = true
    if (!chats.get(msg.chatId)) {
      const isGroup = msg.chatId.endsWith('@g.us')
      chats.set(msg.chatId, {
        id: msg.chatId, kind: isGroup ? 'group' : 'dm', title: msg.chatId.split('@')[0],
        avatarHue: Math.abs([...msg.chatId].reduce((a, c) => a + c.charCodeAt(0), 0)) % 360,
        participants: [], pinned: false, muted: false, archived: false, favorite: false,
        unread: 0, markedUnread: false, lastActivity: msg.ts,
      })
      chatsTouched = true
    }
    const c = chats.get(msg.chatId)
    if (c && msg.ts >= c.lastActivity) {
      const inc = msg.from !== 'me' && activeChat !== msg.chatId && !backfill ? 1 : 0
      chats.set(msg.chatId, { ...c, lastActivity: msg.ts, unread: c.unread + inc })
      chatsTouched = true
    }
  }

  for (const e of events) {
    switch (e.type) {
      case 'message': {
        upsert(e.msg, !!e.backfill)
        if (!e.backfill && e.msg.from !== 'me') notifyMessage(e.msg)
        break
      }
      case 'message_update': {
        const map = draft(e.msg.chatId)
        if (!map) break
        const prev = map.get(e.msg.id)
        map.set(e.msg.id, { ...prev, ...e.msg, v: (prev?.v ?? 0) + 1 })
        break
      }
      case 'messages_removed': {
        const map = draft(e.chatId)
        const b = buckets.get(e.chatId)
        if (!map || !b) break
        for (const id of e.ids) map.delete(id)
        buckets.set(e.chatId, { ...b, map, ids: b.ids.filter((i) => map.has(i)) })
        bucketsTouched = true
        break
      }
      case 'delivery': {
        const map = draft(e.chatId)
        if (!map) break
        for (const id of e.ids) {
          const m = map.get(id)
          if (m && m.delivery) {
            const d = e.delivery === 'read' && !settings.readReceipts ? 'delivered' : e.delivery
            map.set(id, { ...m, delivery: d, v: (m.v ?? 0) + 1 })
          }
        }
        break
      }
      case 'chat_update': {
        chats.set(e.chat.id, e.chat)
        chatsTouched = true
        break
      }
      case 'chat_removed': {
        chats.delete(e.chatId)
        buckets.delete(e.chatId)
        drafts.delete(e.chatId)
        chatsTouched = true
        bucketsTouched = true
        if (activeChat === e.chatId) activeTouched = null
        break
      }
      case 'chat_cleared': {
        const b = buckets.get(e.chatId)
        if (b) { buckets.set(e.chatId, { ...b, ids: [], map: new Map(), hasMore: b.hasMore }); bucketsTouched = true }
        drafts.delete(e.chatId)
        break
      }
      case 'typing': {
        if (e.names.length) typing.set(e.chatId, e.names)
        else typing.delete(e.chatId)
        typingTouched = true
        break
      }
      case 'presence': {
        online.set(e.chatId, e.online)
        onlineTouched = true
        break
      }
      case 'linked': {
        set({ account: e.account, qrString: null })
        if (get().phase === 'linking') scheduleBoot()
        break
      }
      case 'qr': {
        if (get().phase === 'ready') {
          patch({ phase: 'linking', account: null, chats: new Map(), order: [], buckets: new Map(), activeChat: null })
        }
        set({ qrString: e.qr })
        break
      }
      case 'connection': {
        if (e.state === 'closed') {
          set({ bridgeStatus: 'connecting' })
          if (get().phase === 'linking') setTimeout(retryBoot, 2500)
        } else if (e.state === 'open' && get().phase === 'ready' && !get().demoMode) {
          scheduleBoot()
        }
        break
      }
      case 'history_done': {
        scheduleBoot()
        break
      }
      case 'older_result': {
        const b = buckets.get(e.chatId)
        if (b) {
          buckets.set(e.chatId, { ...b, hasMore: e.hasMore })
          bucketsTouched = true
        }
        break
      }
      case 'sync_progress': {
        patch({ syncing: e.done ? null : { chats: e.chats, contacts: e.contacts, messages: e.messages, progress: e.progress ?? undefined } })
        break
      }
      case 'bridge_error': {
        toast(e.message, 'error')
        break
      }
    }
  }

  // commit any draft message maps still pending (message_update/delivery touch
  // drafts without rewriting the bucket entry themselves)
  for (const chatId of [...drafts.keys()]) commitDraft(chatId)

  const next: Record<string, unknown> = {}
  if (chatsTouched) { next.chats = chats; next.order = sortChats(chats) }
  if (bucketsTouched) next.buckets = buckets
  if (typingTouched) next.typing = typing
  if (onlineTouched) next.online = online
  if (activeTouched !== undefined) next.activeChat = activeTouched
  if (Object.keys(next).length) set(next)
}


// ---------- public actions ----------

let booting = false
let offEvents: (() => void) | null = null

export async function boot(adapter: ClientAdapter) {
  if (booting) { setTimeout(retryBoot, 400); return }
  booting = true
  patch({ adapter, bridgeStatus: 'connecting', demoMode: !!adapter.isDemo })
  offEvents?.() // re-boots (daemon restart) must not double-subscribe events
  const off = adapter.onEvent(applyEvent)
  offEvents = off
  let snap
  try {
    snap = await adapter.connect()
  } catch {
    off()
    booting = false
    patch({ bridgeStatus: 'error' })
    return undefined
  }
  // daemon answered before pairing finished — stay on the QR screen
  if (snap.linked === false) {
    booting = false
    patch({ bridgeStatus: 'connecting' })
    return off
  }
  const chats = new Map(snap.chats.map((c) => [c.id, c]))
  // merge, never replace: a re-boot during history replay must not discard
  // buckets the user already deep-scrolled or chats still syncing in
  const prevBuckets = get().buckets
  const buckets = new Map<Id, ChatBucket>(prevBuckets)
  for (const [chatId, msgs] of Object.entries(snap.topMessages)) {
    const prev = prevBuckets.get(chatId)
    if (!prev) {
      buckets.set(chatId, {
        ids: msgs.map((m) => m.id),
        map: new Map(msgs.map((m) => [m.id, { ...m, v: 1 }])),
        hasMore: true,
        loaded: true,
      })
      continue
    }
    const map = new Map(prev.map)
    const known = new Set(prev.ids)
    const extra: Id[] = []
    for (const m of msgs) {
      if (known.has(m.id)) continue
      known.add(m.id)
      extra.push(m.id)
      map.set(m.id, { ...m, v: 1 })
    }
    if (extra.length) {
      const ids = [...prev.ids, ...extra].sort((a, b) => {
        const ma = map.get(a)!, mb = map.get(b)!
        return ma.ts - mb.ts || (a < b ? -1 : 1)
      })
      buckets.set(chatId, { ...prev, map, ids })
    }
  }
  const contacts = new Map(snap.contacts.map((c) => [c.id, c]))
  const order = sortChats(chats)
  const current = get().activeChat
  const first = current && chats.has(current) ? current : (order[0] ?? null)
  patch({
    phase: 'ready', account: snap.account, chats, order, buckets, contacts,
    activeChat: first, bridgeStatus: 'ready', qrString: null,
    openUnread: first ? (chats.get(first)?.unread ?? 0) : 0,
  })
  ensureNotifPermission()
  if (first) adapter.markRead(first)
  booting = false
  return off
}

export function retryBoot() {
  const { adapter } = get()
  if (adapter) void boot(adapter)
}

/** unlink this device: daemon wipes the session and pushes a fresh QR */
export function logout() {
  const { adapter } = get()
  patch({
    phase: 'linking', account: null, chats: new Map(), order: [], buckets: new Map(),
    contacts: new Map(), activeChat: null, qrString: null, bridgeStatus: 'connecting',
    selection: null, replyTo: null, editing: null, settingsOpen: false, syncing: null,
  })
  adapter?.logout()
}

export function openChat(chatId: Id) {
  const { adapter, chats } = get()
  // snapshot the unread count BEFORE markRead zeroes it — the unread divider
  // in MessageList anchors on this value
  const openUnread = chats.get(chatId)?.unread ?? 0
  patch({ activeChat: chatId, openUnread, replyTo: null, editing: null, selection: null, showArchived: false })
  adapter?.markRead(chatId)
}

export function closeChat() {
  patch({ activeChat: null, pane: null, replyTo: null, editing: null, selection: null })
}

export function nextChat(dir: 1 | -1) {
  const { order, activeChat, chats, showArchived } = get()
  const visible = order.filter((id) => {
    const c = chats.get(id)!
    return c.archived === showArchived
  })
  const i = visible.indexOf(activeChat ?? '')
  const next = visible[(i + dir + visible.length) % visible.length]
  if (next) openChat(next)
}

export async function loadOlder(chatId: Id) {
  const { adapter, buckets } = get()
  const b = buckets.get(chatId)
  if (!adapter || !b || !b.hasMore || !b.ids.length) return
  const first = b.map.get(b.ids[0])
  if (!first) return
  const page = await adapter.loadOlder(chatId, first.ts, 60).catch(() => null)
  if (!page) return 0
  const nb = new Map(get().buckets)
  const map = new Map(b.map)
  const ids = page.messages.map((m) => { map.set(m.id, { ...m, v: 1 }); return m.id })
  nb.set(chatId, { ...b, map, ids: [...ids, ...b.ids], hasMore: page.hasMore })
  set({ buckets: nb })
  return page.messages.length
}

/** WhatsApp-style message id — the daemon passes it as messageId so the
 *  send echo reconciles with the optimistic row by id, no fuzzy matching */
function newMsgId() {
  const b = crypto.getRandomValues(new Uint8Array(9))
  return '3EB0' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()
}

function optimisticContent(c: OutContent): MsgContent {
  switch (c.kind) {
    case 'text': return { kind: 'text', text: c.text }
    case 'audio': return { kind: 'audio', duration: c.duration, waveform: c.waveform, voice: c.voice, url: c.url ?? c.dataUrl }
    case 'document': return { kind: 'document', name: c.name, size: c.size, mime: c.mime, url: c.url ?? c.dataUrl }
    case 'image': return { kind: 'image', url: c.url, w: c.w, h: c.h, caption: c.caption }
    case 'video': return { kind: 'video', url: c.url, w: c.w, h: c.h, caption: c.caption, duration: 0 }
    case 'poll': return { kind: 'poll', question: c.question, options: c.options, multi: c.multi }
  }
}

export function send(chatId: Id, content: OutContent) {
  const { adapter, replyTo } = get()
  const id = newMsgId()
  // optimistic insert — the daemon's echo arrives under the same id and
  // upgrades this row; a failure lands as delivery:'failed'
  applyEvent({
    type: 'message',
    msg: {
      id, chatId, from: 'me', ts: Math.floor(Date.now() / 1000),
      delivery: 'pending', replyTo: replyTo ?? undefined,
      content: optimisticContent(content), v: 1,
    },
  })
  adapter?.send(chatId, content, replyTo ?? undefined, id)
  patch({ replyTo: null })
}

/** shared file-send path — composer picker, drag-drop and paste all land here */
export function sendFiles(chatId: Id, files: Iterable<File>, forceDoc = false) {
  for (const f of files) sendFile(chatId, f, forceDoc)
}

export function sendFile(chatId: Id, f: File, forceDoc = false) {
  if (f.size > 256 * 1024 * 1024) { toast(`"${f.name}" is too large (256 MB max)`, 'error'); return }
  const rd = new FileReader()
  rd.onload = () => {
    const url = String(rd.result)
    if (forceDoc || !/^(image|video)\//.test(f.type)) {
      send(chatId, { kind: 'document', name: f.name, size: f.size, mime: f.type || 'application/octet-stream', url })
      return
    }
    if (f.type.startsWith('video/')) {
      const v = document.createElement('video')
      v.preload = 'metadata'
      v.onloadedmetadata = () => send(chatId, { kind: 'video', url, w: v.videoWidth, h: v.videoHeight })
      v.onerror = () => send(chatId, { kind: 'video', url, w: 0, h: 0 })
      v.src = url
      return
    }
    const img = new Image()
    img.onload = () => send(chatId, { kind: 'image', url, w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => send(chatId, { kind: 'image', url, w: 0, h: 0 })
    img.src = url
  }
  rd.readAsDataURL(f)
}

export function setReplyTo(r: ReplyRef | null) { patch({ replyTo: r, editing: null }) }
export function setEditing(m: Message | null) { patch({ editing: m, replyTo: null }) }
export function setPane(p: Pane) { patch({ pane: p, searchHits: null }) }
export function setQuery(q: string) { patch({ query: q }) }
export function setFilter(f: Filter) { patch({ filter: f, showArchived: false }) }
export function setShowArchived(v: boolean) { patch({ showArchived: v }) }
export function setSettingsOpen(v: boolean) { patch({ settingsOpen: v }) }
export function setRelinkPrompt(v: boolean) { patch({ relinkPrompt: v }) }
export function setForwarding(msgs: Message[] | null) { patch({ forwarding: msgs }) }
export function updateSettings(p: Partial<Settings>) {
  set((s) => ({ settings: { ...s.settings, ...p } }))
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(get().settings))
  } catch { /* storage unavailable */ }
}

export async function searchInChat(chatId: Id, q: string) {
  const { adapter } = get()
  if (!adapter || !q.trim()) { patch({ searchHits: null }); return }
  try {
    patch({ searchHits: await adapter.searchMessages(chatId, q) })
  } catch {
    patch({ searchHits: [] })
  }
}

/** scroll to a message — loads older pages from the phone if it isn't local yet */
export async function jumpTo(chatId: Id, messageId: Id) {
  if (get().activeChat !== chatId) openChat(chatId)
  patch({ flashId: null })
  const has = () => get().buckets.get(chatId)?.map.has(messageId)
  for (let i = 0; i < 20 && !has(); i++) {
    const n = await loadOlder(chatId)
    if (!n) break // no older messages local — daemon may still be fetching
  }
  requestAnimationFrame(() => patch({ flashId: messageId }))
  // flashDone in MessageList clears it after the highlight; if the id never
  // landed the flash is a no-op — tell the user instead of silently failing
  setTimeout(() => {
    if (!has() && get().flashId === messageId) toast('Message is still syncing from your phone', 'info')
  }, 1200)
}

export function flashDone() { patch({ flashId: null }) }

// message-level actions — every mutation renders optimistically through the
// same event path the daemon echoes back into, so the UI feels instant and
// the wire result reconciles by id
export function doEdit(chatId: Id, id: Id, text: string) {
  const prev = get().buckets.get(chatId)?.map.get(id)
  if (prev?.content.kind === 'text') {
    applyEvent({ type: 'message_update', msg: { ...prev, content: { ...prev.content, text }, edited: true } })
  }
  get().adapter?.edit(chatId, id, text)
  patch({ editing: null })
}
export function doDelete(chatId: Id, ids: Id[], forEveryone: boolean) {
  if (forEveryone) {
    for (const id of ids) {
      const prev = get().buckets.get(chatId)?.map.get(id)
      if (prev) applyEvent({ type: 'message_update', msg: { ...prev, content: { kind: 'deleted' }, reactions: undefined } })
    }
  } else {
    applyEvent({ type: 'messages_removed', chatId, ids })
  }
  get().adapter?.delete(chatId, ids, forEveryone)
  patch({ selection: null })
}
export function doReact(chatId: Id, id: Id, emoji: string | null) {
  const prev = get().buckets.get(chatId)?.map.get(id)
  if (prev) {
    const rest = (prev.reactions ?? []).filter((r) => r.by !== 'me')
    applyEvent({ type: 'message_update', msg: { ...prev, reactions: emoji ? [...rest, { by: 'me', emoji }] : rest } })
  }
  get().adapter?.react(chatId, id, emoji)
}
export function doForward(toIds: Id[], msgs: Message[]) {
  get().adapter?.forward(toIds, msgs.map((m) => m.id))
  patch({ forwarding: null, selection: null })
  toast(toIds.length > 1 ? `Forwarded to ${toIds.length} chats` : 'Forwarded', 'check')
}
export function doFlag(chatId: Id, flag: 'pinned' | 'muted' | 'archived' | 'favorite', v: boolean) {
  const c = get().chats.get(chatId)
  if (c) applyEvent({ type: 'chat_update', chat: { ...c, [flag]: v } })
  get().adapter?.setChatFlag(chatId, flag, v)
}
export function doMarkUnread(chatId: Id, v: boolean) {
  const c = get().chats.get(chatId)
  if (c) applyEvent({ type: 'chat_update', chat: { ...c, markedUnread: v } })
  get().adapter?.markUnread(chatId, v)
}
export function doMarkRead(chatId: Id) {
  const c = get().chats.get(chatId)
  if (c) applyEvent({ type: 'chat_update', chat: { ...c, unread: 0, markedUnread: false } })
  get().adapter?.markRead(chatId)
}
export function doVote(chatId: Id, id: Id, idxs: number[]) {
  get().adapter?.vote(chatId, id, idxs)
}
export function doStar(chatId: Id, ids: Id[], v: boolean) {
  for (const id of ids) {
    const prev = get().buckets.get(chatId)?.map.get(id)
    if (prev) applyEvent({ type: 'message_update', msg: { ...prev, starred: v } })
  }
  get().adapter?.star(chatId, ids, v)
}
export function doPinMessage(chatId: Id, id: Id, pin: boolean) {
  get().adapter?.pinMessage?.(chatId, id, pin)
}
export async function doLeaveGroup(chatId: Id) {
  const a = get().adapter
  if (!a?.leaveGroup) return
  try {
    await a.leaveGroup(chatId)
    closeChat()
  } catch {
    toast("Couldn't leave — try again", 'error')
  }
}
export async function openContactChat(contactId: Id) {
  const { adapter, chats } = get()
  for (const c of chats.values()) {
    if (c.contactId === contactId) { openChat(c.id); return }
  }
  const chat = await adapter?.openChat(contactId)
  if (chat) {
    if (!get().chats.has(chat.id)) {
      const nc = new Map(get().chats)
      nc.set(chat.id, chat)
      set({ chats: nc, order: sortChats(nc) })
    }
    openChat(chat.id)
  }
}
export function markAllRead() {
  const { adapter, chats } = get()
  for (const c of chats.values()) if (c.unread > 0 || c.markedUnread) adapter?.markRead(c.id)
}
export function setDraft(chatId: Id, text: string) {
  const d = new Map(get().drafts)
  if (text) d.set(chatId, text)
  else d.delete(chatId)
  set({ drafts: d })
}
export function setPalette(v: boolean) { patch({ paletteOpen: v }) }
export function setTypingNotify(chatId: Id, v: boolean) {
  get().adapter?.setTyping(chatId, v)
}

// selection
export function startSelection(id: Id) { patch({ selection: new Set([id]) }) }
export function toggleSelect(id: Id) {
  const sel = get().selection
  if (!sel) return
  const n = new Set(sel)
  if (n.has(id)) n.delete(id)
  else n.add(id)
  patch({ selection: n.size ? n : null })
}
export function clearSelection() { patch({ selection: null }) }

// selectors
export const selectChat = (id: Id) => (s: State) => s.chats.get(id)
export const selectMessage = (chatId: Id, id: Id) => (s: State) => s.buckets.get(chatId)?.map.get(id)
