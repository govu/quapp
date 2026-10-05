import { create } from 'zustand'
import type {
  Account, CallInfo, Chat, ClientAdapter, Contact, Id, Message, MsgContent, OutContent, ReplyRef, ServerEvent,
} from './bridge/types'

export type Filter = 'all' | 'unread' | 'favorites' | 'groups'
export type Pane = 'search' | 'info' | 'starred' | null

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
  /** rich contact profiles fetched on demand (info pane) */
  profiles: Map<Id, import('./bridge/types').ProfileInfo>
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
  /** generic destructive-confirm dialog — context menus can't host one */
  confirm: { title: string; body?: string; ok?: string; run: () => void } | null
  /** global starred-message list (loaded lazily when the pane opens) */
  starredList: Message[] | 'loading' | null
  /** new-group picker sheet */
  groupSheet: boolean
  /** a live incoming call — set on 'offer', cleared on terminate/timeout */
  incomingCall: CallInfo | null
  /** status rings by sender jid ('me' = ours) — live <24h */
  statuses: Map<Id, import('./bridge/types').StatusUpdate>
  /** sidebar shows the status list instead of chats */
  statusOpen: boolean
  /** full-screen status viewer — sender + current index */
  statusView: { jid: Id; index: number } | null
  /** status composer sheet */
  statusCompose: boolean
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
const DRAFTS_KEY = 'quapp-drafts'

function loadDrafts(): Map<Id, string> {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY)
    if (raw) return new Map(JSON.parse(raw) as [Id, string][])
  } catch { /* corrupted */ }
  return new Map()
}

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
  profiles: new Map(),
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
  drafts: loadDrafts(),
  paletteOpen: false,
  qrString: null,
  bridgeStatus: 'idle',
  demoMode: true,
  relinkPrompt: false,
  openUnread: 0,
  confirm: null,
  starredList: null,
  groupSheet: false,
  incomingCall: null,
  statuses: new Map(),
  statusOpen: false,
  statusView: null,
  statusCompose: false,
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
  const contacts = new Map(s.contacts)
  const profiles = new Map(s.profiles)
  const statuses = new Map(s.statuses)
  const settings = s.settings
  const activeChat = s.activeChat
  let chatsTouched = false
  let bucketsTouched = false
  let typingTouched = false
  let onlineTouched = false
  let contactsTouched = false
  let profilesTouched = false
  let statusesTouched = false
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

  // new ids accumulate per chat and merge ONCE at commit — appending
  // [...b.ids, id] per message was O(n²) in a backfill burst, and blindly
  // appending scrambled order when replayed rows arrive older than the tail
  const addedIds = new Map<Id, Id[]>()
  const upsert = (msg: Message, backfill: boolean) => {
    const b = buckets.get(msg.chatId)
    if (b) {
      const map = draft(msg.chatId)!
      const prev = map.get(msg.id)
      map.set(msg.id, { ...msg, v: (prev?.v ?? 0) + 1 })
      if (!prev) {
        let a = addedIds.get(msg.chatId)
        if (!a) addedIds.set(msg.chatId, (a = []))
        a.push(msg.id)
        bucketsTouched = true
      }
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
        if (!prev) break // an update for an unloaded message must not create a phantom map-only entry
        map.set(e.msg.id, { ...prev, ...e.msg, v: (prev.v ?? 0) + 1 })
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
        const prev = chats.get(e.chat.id)
        // never regress lastActivity — an echo of an older snapshot would
        // bounce the chat down the list
        chats.set(e.chat.id, prev && e.chat.lastActivity < prev.lastActivity
          ? { ...e.chat, lastActivity: prev.lastActivity }
          : e.chat)
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
        set({ account: e.account, qrString: null, bridgeStatus: 'ready' })
        if (get().phase === 'linking') scheduleBoot()
        break
      }
      case 'qr': {
        if (get().phase === 'ready') {
          // clear the local clones too — later events in this same flush would
          // otherwise commit pre-reset chats/buckets over the wipe
          chats.clear(); buckets.clear(); drafts.clear()
          chatsTouched = bucketsTouched = true
          patch({ phase: 'linking', account: null, chats: new Map(), order: [], buckets: new Map(), activeChat: null })
        }
        set({ qrString: e.qr })
        break
      }
      case 'connection': {
        if (e.state === 'closed') {
          // a dead socket leaves typing dots/online/sync banner frozen —
          // clear the local clones too or the flush commit restores them
          typing.clear(); typingTouched = true
          online.clear(); onlineTouched = true
          set({ bridgeStatus: 'connecting', syncing: null })
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
        // seed a bucket for chats outside the snapshot's top-60 — without it
        // the spinner shows forever and deeper history can never load
        buckets.set(e.chatId, {
          ids: b?.ids ?? [], map: b?.map ?? new Map(),
          hasMore: e.hasMore, loaded: true,
        })
        bucketsTouched = true
        break
      }
      case 'profile': {
        const p = e.profile
        profiles.set(p.jid, p)
        profilesTouched = true
        if (p.about) {
          const c = contacts.get(p.jid)
          if (c && c.about !== p.about) { contacts.set(p.jid, { ...c, about: p.about }); contactsTouched = true }
        }
        break
      }
      case 'sync_progress': {
        patch({ syncing: e.done ? null : { chats: e.chats, contacts: e.contacts, messages: e.messages, progress: e.progress ?? undefined } })
        break
      }
      case 'status_update': {
        if (e.status) statuses.set(e.status.jid, e.status)
        else if (e.jid) statuses.delete(e.jid)
        statusesTouched = true
        break
      }
      case 'call': {
        const c = e.call
        if (c.status === 'offer' && !c.offline) {
          patch({ incomingCall: c })
          const chat = chats.get(c.chatId)
          if (get().settings.notifications && notifAllowed === 'granted' && !document.hasFocus()) {
            const n = new Notification(chat?.title ?? 'Quapp', { body: c.video ? 'Incoming video call' : 'Incoming voice call', tag: `quapp-call-${c.id}`, icon: chat?.avatarUrl })
            n.onclick = () => { window.focus(); openChat(c.chatId) }
          } else if (get().settings.notifSound) notifBlip()
        } else if (['timeout', 'terminate', 'reject', 'accept'].includes(c.status)) {
          const cur = get().incomingCall
          if (cur?.id === c.id) patch({ incomingCall: null })
        }
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

  // merge newly-added ids once per touched chat — fast path is a plain append
  // when every new row is newer than the tail; only out-of-order backfill pays
  // for a sort
  for (const [chatId, added] of addedIds) {
    const b = buckets.get(chatId)
    if (!b) continue
    const map = b.map
    const tailId = b.ids[b.ids.length - 1]
    const tail = tailId ? map.get(tailId) : undefined
    let ids: Id[]
    if (!tail || added.every((id) => (map.get(id)?.ts ?? 0) >= tail.ts)) {
      ids = [...b.ids, ...added]
    } else {
      ids = [...b.ids, ...added]
      ids.sort((x, y) => (map.get(x)?.ts ?? 0) - (map.get(y)?.ts ?? 0) || (x < y ? -1 : 1))
    }
    buckets.set(chatId, { ...b, ids })
  }

  const next: Record<string, unknown> = {}
  if (chatsTouched) { next.chats = chats; next.order = sortChats(chats) }
  if (bucketsTouched) next.buckets = buckets
  if (typingTouched) next.typing = typing
  if (onlineTouched) next.online = online
  if (contactsTouched) next.contacts = contacts
  if (profilesTouched) next.profiles = profiles
  if (statusesTouched) next.statuses = statuses
  if (activeTouched !== undefined) next.activeChat = activeTouched
  if (Object.keys(next).length) set(next)
}


// ---------- public actions ----------

let booting = false
let offEvents: (() => void) | null = null

let bootRetryQueued = false
export async function boot(adapter: ClientAdapter) {
  // at most ONE deferred boot — every call while booting used to chain
  // another 400ms retry forever
  if (booting) {
    if (!bootRetryQueued) { bootRetryQueued = true; setTimeout(() => { bootRetryQueued = false; retryBoot() }, 400) }
    return
  }
  booting = true
  patch({ adapter, bridgeStatus: 'connecting', demoMode: !!adapter.isDemo })
  offEvents?.() // re-boots (daemon restart) must not double-subscribe events
  const off = adapter.onEvent(applyEvent)
  offEvents = off
  let snap
  try {
    snap = await Promise.race([
      adapter.connect(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('connect timeout')), 35000)),
    ])
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
  const wasLinking = get().phase === 'linking'
  const current = get().activeChat
  // auto-select the top chat only on the first successful boot — a resync
  // must not yank the user out of "no chat open" or switch their chat
  const first = current && chats.has(current) ? current : wasLinking ? (order[0] ?? null) : null
  const statuses = new Map((snap.statuses ?? []).map((g) => [g.jid, g]))
  patch({
    phase: 'ready', account: snap.account, chats, order, buckets, contacts, statuses,
    activeChat: first, bridgeStatus: 'ready', qrString: null,
    openUnread: first ? (chats.get(first)?.unread ?? 0) : 0,
  })
  ensureNotifPermission()
  // push user prefs the daemon owns — it boots with defaults until told
  adapter.prefs?.({
    autoDlPhotos: get().settings.autoDlPhotos,
    autoDlDocs: get().settings.autoDlDocs,
    linkPreviews: get().settings.linkPreviews,
  })
  // markRead only on first open — calling it on every resync fires a PDO
  // tail request per re-boot (the burst that made the phone go silent)
  if (first && wasLinking) adapter.markRead(first)
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
    profiles: new Map(), searchHits: null, typing: new Map(), online: new Map(),
    pane: null, forwarding: null, flashId: null, paletteOpen: false, confirm: null,
    drafts: new Map(), starredList: null,
  })
  adapter?.logout()
}

export function openChat(chatId: Id) {
  const { adapter, chats } = get()
  // snapshot the unread count BEFORE markRead zeroes it — the unread divider
  // in MessageList anchors on this value
  const openUnread = chats.get(chatId)?.unread ?? 0
  patch({ activeChat: chatId, openUnread, replyTo: null, editing: null, selection: null, searchHits: null, showArchived: chats.get(chatId)?.archived ?? false })
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

// after an empty page the phone is almost certainly rate-limiting — quiet the
// scroll trigger instead of burning another PDO round-trip every swipe
const olderQuiet = new Map<Id, number>()

export async function loadOlder(chatId: Id) {
  const { adapter } = get()
  if (!adapter) return
  if (Date.now() < (olderQuiet.get(chatId) ?? 0)) return 0
  const b = get().buckets.get(chatId)
  if (b && !b.hasMore) return
  const first = b?.ids.length ? b.map.get(b.ids[0]) : undefined
  // no bucket (chat outside the snapshot's top-60) → page from "now" so the
  // daemon can answer from disk or phone-fetch with a tail anchor
  const page = await adapter.loadOlder(chatId, first?.ts ?? Date.now(), 60).catch(() => null)
  if (!page) return 0
  // re-read AFTER the await — a live message landing mid-fetch must not be
  // overwritten by the stale bucket captured above
  const cur = get().buckets.get(chatId)
  const nb = new Map(get().buckets)
  const map = new Map(cur?.map ?? [])
  const old = cur?.ids ?? []
  const ids: Id[] = []
  for (const m of page.messages) {
    if (map.has(m.id)) continue
    map.set(m.id, { ...m, v: 1 })
    ids.push(m.id)
  }
  const merged = [...ids, ...old]
  if (merged.length > 1) {
    const out = merged.some((id, i) => i > 0 && (map.get(id)?.ts ?? 0) < (map.get(merged[i - 1])?.ts ?? 0))
    if (out) merged.sort((a, b) => (map.get(a)?.ts ?? 0) - (map.get(b)?.ts ?? 0) || (a < b ? -1 : 1))
  }
  nb.set(chatId, { ids: merged, map, hasMore: page.hasMore, loaded: true })
  set({ buckets: nb })
  if (!page.messages.length && page.hasMore) olderQuiet.set(chatId, Date.now() + 90_000)
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

export function send(chatId: Id, content: OutContent, replyOverride?: ReplyRef) {
  const { adapter } = get()
  const replyTo = replyOverride ?? get().replyTo
  const id = newMsgId()
  // optimistic insert — the daemon's echo arrives under the same id and
  // upgrades this row; a failure lands as delivery:'failed'
  applyEvent({
    type: 'message',
    msg: {
      id, chatId, from: 'me', ts: Date.now(),
      delivery: 'pending', replyTo: replyTo ?? undefined,
      content: optimisticContent(content), v: 1,
    },
  })
  const r = adapter?.send(chatId, content, replyTo ?? undefined, id)
  // a transport-level failure (socket down, bridge dead) never reaches the
  // daemon — mark the optimistic row failed or it spins pending forever
  void Promise.resolve(r).catch(() => applyEvent({
    type: 'delivery', chatId, ids: [id], delivery: 'failed',
  }))
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

// ---------- statuses ----------

export function setStatusOpen(v: boolean) { patch({ statusOpen: v }) }
export function setStatusCompose(v: boolean) { patch({ statusCompose: v }) }

export function openStatus(jid: Id, index = 0) {
  patch({ statusView: { jid, index } })
  if (jid !== 'me') get().adapter?.markStatusSeen?.(jid)
}

export function closeStatus() { patch({ statusView: null }) }

/** next/prev message inside the ring, then across senders like WhatsApp */
export function stepStatus(dir: 1 | -1) {
  const { statusView, statuses } = get()
  if (!statusView) return
  const g = statuses.get(statusView.jid)
  if (!g) { closeStatus(); return }
  const next = statusView.index + dir
  if (next >= 0 && next < g.msgs.length) { patch({ statusView: { ...statusView, index: next } }); return }
  const list = [...statuses.values()].sort((a, b) => b.latest - a.latest)
  const i = list.findIndex((x) => x.jid === statusView.jid)
  const ns = list[i + dir]
  if (!ns) { closeStatus(); return }
  patch({ statusView: { jid: ns.jid, index: dir === 1 ? 0 : ns.msgs.length - 1 } })
  if (ns.jid !== 'me') get().adapter?.markStatusSeen?.(ns.jid)
}

export async function postStatus(content: OutContent) {
  try {
    await get().adapter?.sendStatus?.(content)
    patch({ statusCompose: false })
  } catch {
    toast("Couldn't post status — try again", 'error')
  }
}

/** name/about mirrored to WhatsApp through the bridge */
export async function saveProfile(p: { name?: string; status?: string }) {
  try {
    await get().adapter?.setProfile?.(p)
    const acc = get().account
    if (p.name && acc) patch({ account: { ...acc, name: p.name } })
    toast('Profile updated', 'check')
  } catch {
    toast("Couldn't update profile — try again", 'error')
  }
}

export function setReplyTo(r: ReplyRef | null) { patch({ replyTo: r, editing: null }) }
export function setEditing(m: Message | null) { patch({ editing: m, replyTo: null }) }
export function setPane(p: Pane) { patch({ pane: p, searchHits: null }) }

// profile fetches are deduped — the pane may mount several times in a row
const profileAsked = new Set<Id>()
export function requestProfile(jid: Id) {
  const { adapter, profiles } = get()
  if (!adapter?.profile || profileAsked.has(jid)) return
  if (profiles.get(jid)?.about !== undefined) return // already have one
  profileAsked.add(jid)
  void adapter.profile(jid).then((p) => {
    if (!p || 'error' in p) return
    applyEvent({ type: 'profile', profile: p as import('./bridge/types').ProfileInfo })
  }).catch(() => profileAsked.delete(jid))
}
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
  // daemon-owned prefs — push the ones the bridge actually consumes
  const a = get().adapter
  if (a?.prefs && ('autoDlPhotos' in p || 'autoDlDocs' in p || 'linkPreviews' in p)) {
    a.prefs({ autoDlPhotos: get().settings.autoDlPhotos, autoDlDocs: get().settings.autoDlDocs, linkPreviews: get().settings.linkPreviews })
  }
}

export async function searchInChat(chatId: Id, q: string) {
  const { adapter } = get()
  if (!adapter || !q.trim()) { patch({ searchHits: null }); return }
  try {
    patch({ searchHits: await adapter.searchMessages(chatId, q) })
  } catch {
    patch({ searchHits: [] })
    toast('Search is unavailable right now', 'error') // a failed search must not masquerade as zero results
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
export function doFlag(chatId: Id, flag: 'pinned' | 'muted' | 'archived' | 'favorite', v: boolean, muteMs?: number) {
  const c = get().chats.get(chatId)
  if (c) applyEvent({ type: 'chat_update', chat: { ...c, [flag]: v } })
  get().adapter?.setChatFlag(chatId, flag, v, muteMs)
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
  const chat = await adapter?.openChat(contactId).catch(() => {
    toast("Couldn't open that chat — try again", 'error')
    return undefined
  })
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

// ---------- destructive chat ops — confirmed through the global dialog ----------
export function askConfirm(c: { title: string; body?: string; ok?: string; run: () => void }) {
  patch({ confirm: c })
}
export function closeConfirm() { patch({ confirm: null }) }

export function confirmClearChat(chatId: Id) {
  const chat = get().chats.get(chatId)
  askConfirm({
    title: `Clear "${chat?.title ?? 'chat'}"?`,
    body: 'All messages will be removed from this chat — on this device and your linked phone. Media stays in your phone gallery.',
    ok: 'Clear',
    run: () => get().adapter?.clearChat?.(chatId),
  })
}

export function confirmDeleteChat(chatId: Id) {
  const chat = get().chats.get(chatId)
  askConfirm({
    title: `Delete "${chat?.title ?? 'chat'}"?`,
    body: 'The conversation and all its messages will be deleted — on this device and your linked phone.',
    ok: 'Delete',
    run: () => get().adapter?.deleteChat?.(chatId),
  })
}

/** global starred list — daemon scan, newest first; null = not loaded yet */
export async function loadStarred() {
  patch({ starredList: 'loading' })
  const msgs = await get().adapter?.starred?.().catch(() => undefined)
  patch({ starredList: msgs ?? [] })
}

/** save an attachment through the daemon — lands in Downloads/Quapp */
export async function doDownload(m: Message) {
  const r = await get().adapter?.download?.(m.chatId, m.id).catch(() => undefined)
  if (r?.path) {
    const file = r.path.split(/[\\/]/).pop()
    toast(`Saved to Downloads · ${file}`, 'check')
  } else {
    toast(r?.error === 'unavailable' ? 'Media is no longer available' : "Couldn't download — try again", 'error')
  }
}
let draftTimer: ReturnType<typeof setTimeout> | null = null
export function setDraft(chatId: Id, text: string) {
  const d = new Map(get().drafts)
  if (text) d.set(chatId, text)
  else d.delete(chatId)
  set({ drafts: d })
  // persist debounced — drafts must survive a restart (WhatsApp keeps them)
  if (draftTimer) clearTimeout(draftTimer)
  draftTimer = setTimeout(() => {
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify([...d])) } catch { /* full */ }
  }, 400)
}
export function setPalette(v: boolean) { patch({ paletteOpen: v }) }
export function setGroupSheet(v: boolean) { patch({ groupSheet: v }) }

/** decline a ringing call — real protocol reject */
export function doRejectCall() {
  const c = get().incomingCall
  if (!c) return
  patch({ incomingCall: null })
  void get().adapter?.rejectCall?.(c.id, c.from).catch(() => toast("Couldn't decline the call", 'error'))
}

/** outgoing calls can't be carried by a linked device — hand off to the
 *  official WhatsApp app (installed = the call actually dials) */
export function doCallHandoff(chatId: Id, video: boolean) {
  const chat = get().chats.get(chatId)
  if (!chat) return
  const phone = chatId.split('@')[0]?.replace(/\D/g, '')
  if (!phone) { toast('Calls only work for individual contacts', 'error'); return }
  window.open(`whatsapp://${video ? 'video' : 'call'}?phone=${phone}`, '_self')
  toast('Opening WhatsApp to place the call…', 'info')
}

export async function doCreateGroup(subject: string, jids: Id[]) {
  const r = await get().adapter?.createGroup?.(subject, jids).catch(() => undefined)
  if (r?.chatId) {
    toast('Group created', 'check')
    // the group's chat row arrives via chats.upsert — open it once it lands
    for (let i = 0; i < 20 && !get().chats.has(r.chatId); i++) await new Promise((res) => setTimeout(res, 400))
    if (get().chats.has(r.chatId)) openChat(r.chatId)
  } else {
    toast(r?.error ?? "Couldn't create the group — try again", 'error')
  }
}
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
