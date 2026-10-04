import { create } from 'zustand'
import type {
  Account, Chat, ClientAdapter, Contact, Id, Message, OutContent, ReplyRef, ServerEvent,
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

// ---------- event application ----------

function upsertMessage(msg: Message) {
  const { buckets, chats } = get()
  const b = buckets.get(msg.chatId)
  if (b) {
    const map = new Map(b.map)
    const prev = map.get(msg.id)
    map.set(msg.id, { ...msg, v: (prev?.v ?? 0) + 1 })
    const ids = prev ? b.ids : [...b.ids, msg.id]
    const nb = { ...b, map, ids }
    const nbuckets = new Map(buckets)
    nbuckets.set(msg.chatId, nb)
    set({ buckets: nbuckets })
  } else {
    const nbuckets = new Map(buckets)
    nbuckets.set(msg.chatId, { ids: [msg.id], map: new Map([[msg.id, { ...msg, v: 1 }]]), hasMore: false, loaded: true })
    set({ buckets: nbuckets })
  }
  const c = chats.get(msg.chatId)
  if (c && msg.ts >= c.lastActivity) {
    const nc = new Map(chats)
    const isActive = get().activeChat === msg.chatId
    const inc = msg.from !== 'me' && !isActive ? 1 : 0
    nc.set(msg.chatId, { ...c, lastActivity: msg.ts, unread: c.unread + inc })
    set({ chats: nc, order: sortChats(nc) })
  }
}

function updateMessage(msg: Message) {
  const { buckets } = get()
  const b = buckets.get(msg.chatId)
  if (!b) return
  const prev = b.map.get(msg.id)
  const map = new Map(b.map)
  map.set(msg.id, { ...prev, ...msg, v: (prev?.v ?? 0) + 1 })
  const nb = new Map(buckets)
  nb.set(msg.chatId, { ...b, map })
  set({ buckets: nb })
}

function applyEvent(e: ServerEvent) {
  switch (e.type) {
    case 'message': upsertMessage(e.msg); break
    case 'message_update': updateMessage(e.msg); break
    case 'messages_removed': {
      const { buckets } = get()
      const b = buckets.get(e.chatId)
      if (!b) break
      const map = new Map(b.map)
      for (const id of e.ids) map.delete(id)
      const nb = new Map(buckets)
      nb.set(e.chatId, { ...b, map, ids: b.ids.filter((i) => map.has(i)) })
      set({ buckets: nb })
      break
    }
    case 'delivery': {
      const { buckets, settings } = get()
      const b = buckets.get(e.chatId)
      if (!b) break
      const map = new Map(b.map)
      let changed = false
      for (const id of e.ids) {
        const m = map.get(id)
        if (m && m.delivery) {
          const d = e.delivery === 'read' && !settings.readReceipts ? 'delivered' : e.delivery
          map.set(id, { ...m, delivery: d, v: (m.v ?? 0) + 1 })
          changed = true
        }
      }
      if (changed) {
        const nb = new Map(buckets)
        nb.set(e.chatId, { ...b, map })
        set({ buckets: nb })
      }
      break
    }
    case 'chat_update': {
      const chats = new Map(get().chats)
      chats.set(e.chat.id, e.chat)
      set({ chats, order: sortChats(chats) })
      break
    }
    case 'typing': {
      const t = new Map(get().typing)
      if (e.names.length) t.set(e.chatId, e.names)
      else t.delete(e.chatId)
      set({ typing: t })
      break
    }
    case 'presence': {
      const o = new Map(get().online)
      o.set(e.chatId, e.online)
      set({ online: o })
      break
    }
    case 'linked': {
      set({ account: e.account, qrString: null })
      break
    }
    case 'qr': {
      set({ qrString: e.qr })
      break
    }
    case 'connection': {
      if (e.state === 'closed') {
        set({ bridgeStatus: 'connecting' })
        // bridge may just be restarting — re-boot automatically while still linking
        if (get().phase === 'linking') setTimeout(retryBoot, 2500)
      }
      break
    }
    case 'history_done': break
  }
}

// ---------- public actions ----------

let booting = false

export async function boot(adapter: ClientAdapter) {
  if (booting) return
  booting = true
  patch({ adapter, bridgeStatus: 'connecting', demoMode: !!adapter.isDemo })
  const off = adapter.onEvent(applyEvent)
  let snap
  try {
    snap = await adapter.connect()
  } catch {
    off()
    booting = false
    patch({ bridgeStatus: 'error' })
    return undefined
  }
  const chats = new Map(snap.chats.map((c) => [c.id, c]))
  const buckets = new Map<Id, ChatBucket>()
  for (const [chatId, msgs] of Object.entries(snap.topMessages)) {
    buckets.set(chatId, {
      ids: msgs.map((m) => m.id),
      map: new Map(msgs.map((m) => [m.id, { ...m, v: 1 }])),
      hasMore: true,
      loaded: true,
    })
  }
  const contacts = new Map(snap.contacts.map((c) => [c.id, c]))
  const order = sortChats(chats)
  const first = order[0] ?? null
  patch({
    phase: 'ready', account: snap.account, chats, order, buckets, contacts,
    activeChat: first, bridgeStatus: 'ready', qrString: null,
  })
  if (first) adapter.markRead(first)
  booting = false
  return off
}

export function retryBoot() {
  const { adapter } = get()
  if (adapter) void boot(adapter)
}

export function openChat(chatId: Id) {
  const { adapter } = get()
  patch({ activeChat: chatId, replyTo: null, editing: null, selection: null, showArchived: false })
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
  const page = await adapter.loadOlder(chatId, first.ts, 60)
  const nb = new Map(get().buckets)
  const map = new Map(b.map)
  const ids = page.messages.map((m) => { map.set(m.id, { ...m, v: 1 }); return m.id })
  nb.set(chatId, { ...b, map, ids: [...ids, ...b.ids], hasMore: page.hasMore })
  set({ buckets: nb })
  return page.messages.length
}

export function send(chatId: Id, content: OutContent) {
  const { adapter, replyTo } = get()
  adapter?.send(chatId, content, replyTo ?? undefined)
  patch({ replyTo: null })
}

export function setReplyTo(r: ReplyRef | null) { patch({ replyTo: r, editing: null }) }
export function setEditing(m: Message | null) { patch({ editing: m, replyTo: null }) }
export function setPane(p: Pane) { patch({ pane: p, searchHits: null }) }
export function setQuery(q: string) { patch({ query: q }) }
export function setFilter(f: Filter) { patch({ filter: f, showArchived: false }) }
export function setShowArchived(v: boolean) { patch({ showArchived: v }) }
export function setSettingsOpen(v: boolean) { patch({ settingsOpen: v }) }
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
  const hits = await adapter.searchMessages(chatId, q)
  patch({ searchHits: hits })
}

export function jumpTo(_chatId: Id, messageId: Id) {
  patch({ flashId: null })
  requestAnimationFrame(() => patch({ flashId: messageId }))
}

export function flashDone() { patch({ flashId: null }) }

// message-level actions
export function doEdit(chatId: Id, id: Id, text: string) {
  get().adapter?.edit(chatId, id, text)
  patch({ editing: null })
}
export function doDelete(chatId: Id, ids: Id[], forEveryone: boolean) {
  get().adapter?.delete(chatId, ids, forEveryone)
  patch({ selection: null })
}
export function doReact(chatId: Id, id: Id, emoji: string | null) {
  get().adapter?.react(chatId, id, emoji)
}
export function doForward(toIds: Id[], msgs: Message[]) {
  get().adapter?.forward(toIds, msgs.map((m) => m.id))
  patch({ forwarding: null, selection: null })
  toast(toIds.length > 1 ? `Forwarded to ${toIds.length} chats` : 'Forwarded', 'check')
}
export function doFlag(chatId: Id, flag: 'pinned' | 'muted' | 'archived' | 'favorite', v: boolean) {
  get().adapter?.setChatFlag(chatId, flag, v)
}
export function doMarkUnread(chatId: Id, v: boolean) {
  get().adapter?.markUnread(chatId, v)
}
export function doVote(chatId: Id, id: Id, idxs: number[]) {
  get().adapter?.vote(chatId, id, idxs)
}
export function doStar(chatId: Id, ids: Id[], v: boolean) {
  get().adapter?.star(chatId, ids, v)
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
