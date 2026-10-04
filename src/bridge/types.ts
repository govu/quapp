// Protocol types — the contract between the UI and any backend.
// A backend can be the DemoAdapter (local simulation) or the quappd
// bridge over whatsapp-rust. The UI never sees a protobuf.

export type Id = string

export type ChatKind = 'dm' | 'group' | 'channel' | 'saved'
export type Delivery = 'pending' | 'sent' | 'delivered' | 'read' | 'failed'

export interface Account {
  id: Id
  name: string
  phone?: string
  avatarHue: number
  avatarUrl?: string
  unreadTotal: number
}

export interface Contact {
  id: Id
  name: string
  firstName?: string
  about?: string
  phone?: string
  avatarHue: number
  avatarUrl?: string
  verified?: boolean
  blocked?: boolean
}

export interface Chat {
  id: Id
  kind: ChatKind
  title: string
  avatarHue: number
  avatarUrl?: string
  participants: Id[]
  /** sender id -> display name inside this chat (groups) */
  pinned: boolean
  muted: boolean
  archived: boolean
  favorite: boolean
  /** unread count; markedUnread shows the hollow dot */
  unread: number
  markedUnread: boolean
  lastActivity: number
  draft?: string
  /** id of pinned message, if the chat has one */
  pinnedMessageId?: Id
  /** last time this contact was seen online (dms) */
  lastSeen?: number
  ephemeral?: boolean
  youAdmin?: boolean
  contactId?: Id
}

export interface LinkPreview {
  url: string
  title: string
  description?: string
  site?: string
}

export type MsgContent =
  | { kind: 'text'; text: string; linkPreview?: LinkPreview }
  | { kind: 'image'; url: string; w: number; h: number; caption?: string }
  | { kind: 'video'; url: string; poster?: string; w: number; h: number; caption?: string; duration: number }
  | { kind: 'audio'; duration: number; waveform: number[]; voice: boolean; played?: boolean; url?: string; file?: string }
  | { kind:'document'; name: string; size: number; mime: string; pages?: number; url?: string }
  | { kind: 'sticker'; emoji: string; url?: string }
  | { kind: 'poll'; question: string; options: { text: string; votes: number }[]; multi: boolean; voted?: number[] }
  | { kind: 'location'; name: string; address?: string }
  | { kind: 'system'; text: string }
  | { kind: 'deleted' }

export interface ReplyRef {
  id: Id
  from: Id | 'me'
  fromName: string
  preview: string
  kind: MsgContent['kind']
}

export interface Reaction {
  emoji: string
  by: Id | 'me'
}

export interface Message {
  id: Id
  chatId: Id
  from: Id | 'me'
  /** display name for group senders */
  fromName?: string
  ts: number
  delivery?: Delivery
  edited?: boolean
  forwarded?: boolean
  starred?: boolean
  replyTo?: ReplyRef
  reactions?: Reaction[]
  content: MsgContent
  /** bumped by the store when any field changes, for memoized rows */
  v?: number
}

export interface MessagePage {
  messages: Message[]
  hasMore: boolean
}

export interface SearchHit {
  messageId: Id
  chatId: Id
}

/** rich contact profile fetched on demand (info pane) */
export interface ProfileInfo {
  jid: Id
  about?: string | null
  since?: number | null
  biz?: {
    description: string
    website: string[]
    email: string | null
    category: string | null
    address: string | null
  } | null
}

export type OutContent =
  | { kind: 'text'; text: string }
  | { kind: 'audio'; duration: number; waveform: number[]; voice: true; url?: string; dataUrl?: string }
  | { kind: 'document'; name: string; size: number; mime: string; url?: string; dataUrl?: string }
  | { kind: 'image'; url: string; w: number; h: number; caption?: string }
  | { kind: 'video'; url: string; w: number; h: number; caption?: string }
  | { kind: 'poll'; question: string; options: { text: string; votes: number }[]; multi: boolean }

// ---- events pushed from a backend to the store ----
export type ServerEvent =
  | { type: 'message'; msg: Message; backfill?: boolean }
  | { type: 'message_update'; msg: Message }
  | { type: 'messages_removed'; chatId: Id; ids: Id[] }
  | { type: 'delivery'; chatId: Id; ids: Id[]; delivery: Delivery }
  | { type: 'chat_update'; chat: Chat }
  | { type: 'chat_removed'; chatId: Id }
  | { type: 'chat_cleared'; chatId: Id }
  | { type: 'typing'; chatId: Id; names: string[] }
  | { type: 'linked'; account: Account }
  | { type: 'presence'; chatId: Id; online: boolean; lastSeen?: number }
  /** real pairing QR payload from the bridge — render it for the user to scan */
  | { type: 'qr'; qr: string }
  /** 'bridge' = UI↔daemon socket · 'whatsapp' = daemon↔WhatsApp socket */
  | { type: 'connection'; state: 'open' | 'closed'; source?: 'bridge' | 'whatsapp' }
  | { type: 'history_done' }
  | { type: 'older_result'; chatId: Id; count: number; hasMore: boolean }
  | { type: 'sync_progress'; chats: number; contacts: number; messages: number; progress?: number | null; done?: boolean }
  | { type: 'profile'; profile: ProfileInfo }
  /** a command failed at the bridge — the UI surfaces it as a toast */
  | { type: 'bridge_error'; message: string }

// ---- the adapter the store drives ----
export interface Snapshot {
  /** false while the device isn't paired — the UI should stay on the QR screen */
  linked?: boolean
  account: Account
  chats: Chat[]
  contacts: Contact[]
  /** initial pages for the most recent chats, keyed by chat id */
  topMessages: Record<Id, Message[]>
}

export interface ClientAdapter {
  /** true for the local simulation — lets the UI show demo affordances */
  readonly isDemo?: boolean
  /** resolves once the device is linked + history is loaded */
  connect(): Promise<Snapshot>
  loadOlder(chatId: Id, beforeTs: number, limit: number): Promise<MessagePage>
  searchMessages(chatId: Id, query: string): Promise<Message[]>
  /** rejects on transport failure so the optimistic row can flip to 'failed' */
  send(chatId: Id, content: OutContent, replyTo?: ReplyRef, clientId?: Id): Promise<void> | void
  edit(chatId: Id, messageId: Id, text: string): void
  delete(chatId: Id, messageIds: Id[], forEveryone: boolean): void
  react(chatId: Id, messageId: Id, emoji: string | null): void
  forward(toChatIds: Id[], messageIds: Id[]): void
  /** star/unstar messages; reflected through message_update events */
  star(chatId: Id, messageIds: Id[], starred: boolean): void
  /** cross-chat message search — every chat at once */
  searchAll(query: string): Promise<Message[]>
  /** open (or create) the dm for a contact; returns the chat */
  openChat(contactId: Id): Promise<Chat>
  markRead(chatId: Id): void
  markUnread(chatId: Id, value: boolean): void
  setTyping(chatId: Id, typing: boolean): void
  setChatFlag(chatId: Id, flag: 'pinned' | 'muted' | 'archived' | 'favorite', value: boolean, muteMs?: number): void
  /** push Settings-sheet prefs the bridge owns (auto-download, link previews) */
  prefs?(p: { autoDlPhotos?: boolean; autoDlDocs?: boolean; linkPreviews?: boolean }): void
  vote(chatId: Id, messageId: Id, optionIndexes: number[]): void
  /** unlink this device — the bridge wipes its session and emits a fresh QR */
  logout(): void
  /** optional advanced ops — demo may no-op */
  pinMessage?(chatId: Id, messageId: Id, pin: boolean): void
  /** clear the visible history, keep the chat — synced to the phone */
  clearChat?(chatId: Id): void
  /** delete the conversation entirely — synced to the phone */
  deleteChat?(chatId: Id): void
  leaveGroup?(chatId: Id): Promise<void>
  setPrivacy?(setting: 'lastSeen' | 'profilePhoto' | 'groupsAdd' | 'readReceipts' | 'status', value: string): void
  blocklist?(): Promise<string[]>
  /** fetch a contact's rich profile (about/business/hi-res pic warm) */
  profile?(jid: Id): Promise<ProfileInfo | { error?: string }>
  /** all starred messages across chats — the Starred screen */
  starred?(): Promise<Message[]>
  /** save a media/document message to the downloads folder */
  download?(chatId: Id, messageId: Id): Promise<{ path?: string; error?: string }>
  /** block/unblock a contact or chat jid */
  block?(jid: Id, blocked: boolean): void
  /** group subject/description — admin only; errors surface via bridge_error */
  groupEdit?(chatId: Id, p: { subject?: string; description?: string }): void
  /** create a group; resolves to the new chat id */
  createGroup?(subject: string, participantJids: Id[]): Promise<{ chatId?: Id; error?: string }>
  storageStats?(): Promise<{ bytes: number; files: number }>
  clearCache?(): Promise<number>
  onEvent(cb: (e: ServerEvent) => void): () => void
  dispose(): void
}
