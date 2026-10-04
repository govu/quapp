import type {
  Chat, ClientAdapter, Id, Message, MessagePage, OutContent, ReplyRef,
  ServerEvent, Snapshot,
} from './types'
import { chats as seedChats, contacts, initialMessages, replyPool } from './demo-data'
import { DAY, rng, uid } from '../lib/util'

/**
 * DemoAdapter — a local, deterministic simulation of the protocol backend.
 * Everything the real whatsapp-rust bridge does (delivery progression, typing,
 * incoming messages, pagination) is simulated so the UI is fully exercisable.
 */
export class DemoAdapter implements ClientAdapter {
  readonly isDemo = true
  private chats = new Map<Id, Chat>()
  private msgs = new Map<Id, Message[]>()
  private cbs = new Set<(e: ServerEvent) => void>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private destroyed = false
  private counter = 1000
  private linkDelay: number

  constructor(linkDelay = 2200) {
    this.linkDelay = linkDelay
    for (const c of seedChats) this.chats.set(c.id, { ...c })
    const pages = initialMessages()
    for (const [k, v] of Object.entries(pages)) this.msgs.set(k, v)
  }

  private emit(e: ServerEvent) {
    if (!this.destroyed) for (const cb of this.cbs) cb(e)
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.destroyed) fn() }, ms)
    this.timers.add(t)
  }

  connect(): Promise<Snapshot> {
    return new Promise((res) => {
      this.later(() => {
        this.emit({
          type: 'linked',
          account: { id: 'me', name: 'You', phone: '+34 600 00 00 00', avatarHue: 210, unreadTotal: 0 },
        })
        const top: Record<Id, Message[]> = {}
        for (const [k, v] of this.msgs) top[k] = v.slice(-40)
        res({
          account: { id: 'me', name: 'You', phone: '+34 600 00 00 00', avatarHue: 210, unreadTotal: 0 },
          chats: [...this.chats.values()],
          contacts,
          topMessages: top,
        })
        this.scheduleAmbient()
      }, this.linkDelay)
    })
  }

  /** periodic ambient activity: typing + incoming messages in background chats */
  private scheduleAmbient() {
    const loop = () => {
      this.later(loop, 24000 + Math.random() * 30000)
      const pool = [...this.chats.values()].filter((c) => c.kind !== 'saved' && !c.archived && c.id !== 'ch-canal')
      const chat = pool[Math.floor(Math.random() * pool.length)]
      if (!chat) return
      const senders = chat.kind === 'group' ? chat.participants : chat.participants
      const from = senders[Math.floor(Math.random() * senders.length)]
      const name = contacts.find((c) => c.id === from)?.firstName ?? 'them'
      this.emit({ type: 'typing', chatId: chat.id, names: [name] })
      this.later(() => {
        this.emit({ type: 'typing', chatId: chat.id, names: [] })
        const msg: Message = {
          id: uid(), chatId: chat.id, from, fromName: name, ts: Date.now(),
          content: { kind: 'text', text: replyPool[Math.floor(Math.random() * replyPool.length)] },
        }
        this.append(msg)
        this.emit({ type: 'message', msg })
      }, 1600 + Math.random() * 1800)
    }
    this.later(loop, 12000)
  }

  private append(msg: Message) {
    const arr = this.msgs.get(msg.chatId) ?? []
    arr.push(msg)
    this.msgs.set(msg.chatId, arr)
    const c = this.chats.get(msg.chatId)
    if (c) this.chats.set(msg.chatId, { ...c, lastActivity: msg.ts })
  }

  loadOlder(chatId: Id, beforeTs: number, limit: number): Promise<MessagePage> {
    return new Promise((res) => {
      this.later(() => {
        const all = this.msgs.get(chatId) ?? []
        const older = all.filter((m) => m.ts < beforeTs)
        res({ messages: older.slice(-limit), hasMore: older.length > limit })
      }, 90)
    })
  }

  private match(m: Message, q: string) {
    return (
      (m.content.kind === 'text' && m.content.text.toLowerCase().includes(q)) ||
      (m.content.kind === 'image' && m.content.caption?.toLowerCase().includes(q)) ||
      (m.content.kind === 'video' && m.content.caption?.toLowerCase().includes(q)) ||
      (m.content.kind === 'document' && m.content.name.toLowerCase().includes(q))
    )
  }

  searchMessages(chatId: Id, query: string): Promise<Message[]> {
    return new Promise((res) => {
      this.later(() => {
        const q = query.toLowerCase()
        const all = this.msgs.get(chatId) ?? []
        res(all.filter((m) => this.match(m, q)).slice(-80))
      }, 50)
    })
  }

  searchAll(query: string): Promise<Message[]> {
    return new Promise((res) => {
      this.later(() => {
        const q = query.toLowerCase()
        const out: Message[] = []
        for (const arr of this.msgs.values()) for (const m of arr) if (this.match(m, q)) out.push(m)
        res(out.sort((a, b) => b.ts - a.ts).slice(0, 60))
      }, 60)
    })
  }

  openChat(contactId: Id): Promise<Chat> {
    for (const c of this.chats.values()) if (c.contactId === contactId) return Promise.resolve(c)
    const ct = contacts.find((c) => c.id === contactId)
    const chat: Chat = {
      id: `ch-${contactId}`, kind: 'dm', title: ct?.name ?? contactId,
      avatarHue: ct?.avatarHue ?? 0, avatarUrl: ct?.avatarUrl,
      participants: [contactId], pinned: false, muted: false, archived: false,
      favorite: false, unread: 0, markedUnread: false, lastActivity: Date.now(),
      contactId,
    }
    this.chats.set(chat.id, chat)
    this.msgs.set(chat.id, [])
    this.emit({ type: 'chat_update', chat })
    return Promise.resolve(chat)
  }

  send(chatId: Id, content: OutContent, replyTo?: ReplyRef) {
    const id = uid()
    const msg: Message = {
      id, chatId, from: 'me', ts: Date.now(), delivery: 'pending',
      content: content as Message['content'], replyTo,
    }
    this.append(msg)
    this.emit({ type: 'message', msg })
    this.later(() => this.emit({ type: 'delivery', chatId, ids: [id], delivery: 'sent' }), 110 + Math.random() * 90)
    this.later(() => this.emit({ type: 'delivery', chatId, ids: [id], delivery: 'delivered' }), 430 + Math.random() * 320)
    this.later(() => this.emit({ type: 'delivery', chatId, ids: [id], delivery: 'read' }), 950 + Math.random() * 950)

    // simulated reply for dms/groups
    const chat = this.chats.get(chatId)
    if (chat && chat.kind !== 'saved' && chat.kind !== 'channel' && Math.random() < 0.72) {
      this.later(() => {
        const senders = chat.participants
        const from = senders[Math.floor(Math.random() * senders.length)]
        const name = contacts.find((c) => c.id === from)?.firstName ?? 'them'
        this.emit({ type: 'typing', chatId, names: [name] })
        this.later(() => {
          this.emit({ type: 'typing', chatId, names: [] })
          const reply: Message = {
            id: uid(), chatId, from, fromName: name, ts: Date.now(),
            content: { kind: 'text', text: replyPool[Math.floor(Math.random() * replyPool.length)] },
          }
          this.append(reply)
          this.emit({ type: 'message', msg: reply })
        }, 1500 + Math.random() * 2200)
      }, 1200 + Math.random() * 1800)
    }
  }

  edit(chatId: Id, messageId: Id, text: string) {
    const m = this.msgs.get(chatId)?.find((x) => x.id === messageId)
    if (m && m.content.kind === 'text') {
      const nm = { ...m, edited: true, content: { ...m.content, text } }
      this.replace(nm)
      this.emit({ type: 'message_update', msg: nm })
    }
  }

  private replace(msg: Message) {
    const arr = this.msgs.get(msg.chatId)
    if (!arr) return
    const i = arr.findIndex((x) => x.id === msg.id)
    if (i >= 0) arr[i] = msg
  }

  delete(chatId: Id, messageIds: Id[], forEveryone: boolean) {
    for (const id of messageIds) {
      const m = this.msgs.get(chatId)?.find((x) => x.id === id)
      if (!m) continue
      const nm: Message = forEveryone
        ? { ...m, content: { kind: 'deleted' }, reactions: [], replyTo: undefined }
        : m
      if (forEveryone) {
        this.replace(nm)
        this.emit({ type: 'message_update', msg: nm })
      } else {
        const arr = this.msgs.get(chatId)!
        arr.splice(arr.indexOf(m), 1)
        this.emit({ type: 'messages_removed', chatId, ids: [id] })
      }
    }
  }

  react(chatId: Id, messageId: Id, emoji: string | null) {
    const m = this.msgs.get(chatId)?.find((x) => x.id === messageId)
    if (!m) return
    let reactions = (m.reactions ?? []).filter((r) => r.by !== 'me')
    if (emoji) reactions = [...reactions, { emoji, by: 'me' }]
    const nm = { ...m, reactions }
    this.replace(nm)
    this.emit({ type: 'message_update', msg: nm })
  }

  star(chatId: Id, messageIds: Id[], starred: boolean) {
    for (const id of messageIds) {
      const m = this.msgs.get(chatId)?.find((x) => x.id === id)
      if (!m) continue
      const nm = { ...m, starred }
      this.replace(nm)
      this.emit({ type: 'message_update', msg: nm })
    }
  }

  forward(toChatIds: Id[], messageIds: Id[]) {
    // collect messages from all chats
    const all = new Map<Id, Message>()
    for (const arr of this.msgs.values()) for (const m of arr) all.set(m.id, m)
    for (const cid of toChatIds) {
      for (const mid of messageIds) {
        const src = all.get(mid)
        if (!src) continue
        const msg: Message = {
          id: uid(), chatId: cid, from: 'me', ts: Date.now() + this.counter++,
          delivery: 'sent', forwarded: true, content: src.content,
        }
        this.append(msg)
        this.emit({ type: 'message', msg })
      }
    }
  }

  markRead(chatId: Id) {
    const c = this.chats.get(chatId)
    if (c) {
      this.chats.set(chatId, { ...c, unread: 0, markedUnread: false })
      this.emit({ type: 'chat_update', chat: this.chats.get(chatId)! })
    }
  }

  markUnread(chatId: Id, value: boolean) {
    const c = this.chats.get(chatId)
    if (c) {
      this.chats.set(chatId, { ...c, markedUnread: value, unread: value ? Math.max(1, c.unread) : 0 })
      this.emit({ type: 'chat_update', chat: this.chats.get(chatId)! })
    }
  }

  setTyping(_chatId: Id, _typing: boolean) {}

  setChatFlag(chatId: Id, flag: 'pinned' | 'muted' | 'archived' | 'favorite', value: boolean) {
    const c = this.chats.get(chatId)
    if (c) {
      this.chats.set(chatId, { ...c, [flag]: value })
      this.emit({ type: 'chat_update', chat: this.chats.get(chatId)! })
    }
  }

  vote(chatId: Id, messageId: Id, optionIndexes: number[]) {
    const m = this.msgs.get(chatId)?.find((x) => x.id === messageId)
    if (!m || m.content.kind !== 'poll') return
    const options = m.content.options.map((o, i) => ({
      ...o,
      votes: o.votes + (optionIndexes.includes(i) ? 1 : 0) - (m.content.kind === 'poll' && m.content.voted?.includes(i) ? 1 : 0),
    }))
    const nm = { ...m, content: { ...m.content, options, voted: optionIndexes } }
    this.replace(nm)
    this.emit({ type: 'message_update', msg: nm })
  }

  logout() {
    // demo has nothing to unpair — simulate a relink so the flow doesn't stall
    this.later(() => {
      this.emit({ type: 'linked', account: { id: 'me', name: 'You', phone: '+34 600 00 00 00', avatarHue: 210, unreadTotal: 0 } })
    }, 600)
  }

  pinMessage(chatId: Id, messageId: Id, pin: boolean) {
    const c = this.chats.get(chatId)
    if (c) { c.pinnedMessageId = pin ? messageId : undefined; this.emit({ type: 'chat_update', chat: c }) }
  }
  async leaveGroup(_chatId: Id) { /* demo */ }
  setPrivacy(_setting: string, _value: string) { /* demo */ }
  async blocklist() { return [] }
  async storageStats() { return { bytes: 182_000_000, files: 412 } }
  async clearCache() { return 96_000_000 }

  onEvent(cb: (e: ServerEvent) => void) {
    this.cbs.add(cb)
    return () => this.cbs.delete(cb)
  }

  dispose() {
    this.destroyed = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.cbs.clear()
  }
}

/** older history generator shared with demo-data seeds: synthesizes older pages */
export function synthesizeOlder(chatId: Id, beforeTs: number, limit: number): Message[] {
  const r = rng(chatId.length * 733 + Math.floor(beforeTs / DAY))
  const out: Message[] = []
  for (let i = 0; i < limit; i++) {
    out.push({
      id: uid(), chatId, from: r() > 0.5 ? 'me' : 'c-mara', ts: beforeTs - (limit - i) * 3 * 3600000,
      delivery: 'read',
      content: { kind: 'text', text: replyPool[Math.floor(r() * replyPool.length)] },
    })
  }
  return out
}
