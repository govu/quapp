import type {
  ClientAdapter, Id, Message, MessagePage, OutContent, ReplyRef,
  ServerEvent, Snapshot,
} from './types'

/**
 * WsAdapter — talks to the quappd bridge daemon over a JSON WebSocket.
 * Protocol: one JSON object per frame.
 *   client -> server: { id, cmd, ...args }
 *   server -> client: { id, ok, result }            (response)
 *                     { ev: <ServerEvent> }          (push)
 * Reconnects automatically if the daemon restarts.
 */
export class WsAdapter implements ClientAdapter {
  private url: string
  private ws!: WebSocket
  private seq = 0
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: unknown) => void }>()
  private cbs = new Set<(e: ServerEvent) => void>()
  private openP!: Promise<void>
  private closed = false

  constructor(url: string) {
    this.url = url
    this.open()
  }

  private open() {
    this.openP = new Promise((res, rej) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.onopen = () => {
        this.push({ type: 'connection', state: 'open' }) // lets the store resync after a daemon restart
        res()
      }
      ws.onerror = (e) => rej(e)
      ws.onclose = () => {
        for (const p of this.pending.values()) p.rej(new Error('bridge disconnected'))
        this.pending.clear()
        this.push({ type: 'connection', state: 'closed' })
        if (!this.closed) setTimeout(() => this.open(), 1500)
      }
      ws.onmessage = (m) => {
        const f = JSON.parse(m.data)
        if (f.ev) {
          this.push(f.ev as ServerEvent)
        } else if (f.id != null) {
          const p = this.pending.get(f.id)
          if (p) {
            this.pending.delete(f.id)
            if (f.ok) p.res(f.result)
            else p.rej(new Error(f.error ?? 'bridge error'))
          }
        }
      }
    })
    this.openP.catch(() => {})
  }

  private push(e: ServerEvent) {
    for (const cb of this.cbs) cb(e)
  }

  private lastErrToast = 0
  /** fire-and-forget command that surfaces failures as bridge_error events */
  private sendCmd(cmd: string, args: Record<string, unknown> = {}) {
    this.call(cmd, args).catch((e) => {
      const now = Date.now()
      if (now - this.lastErrToast > 2500) {
        this.lastErrToast = now
        this.push({ type: 'bridge_error', message: e?.message ?? 'Command failed' })
      }
    })
  }

  private async call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.openP
    const id = ++this.seq
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej })
      this.ws.send(JSON.stringify({ id, cmd, ...args }))
    })
  }

  connect() { return this.call<Snapshot>('connect') }
  loadOlder(chatId: Id, beforeTs: number, limit: number) {
    return this.call<MessagePage>('loadOlder', { chatId, beforeTs, limit })
  }
  searchMessages(chatId: Id, query: string) {
    return this.call<Message[]>('searchMessages', { chatId, query })
  }
  send(chatId: Id, content: OutContent, replyTo?: ReplyRef, clientId?: Id) {
    this.sendCmd('send', { chatId, content, replyTo, clientId })
  }
  edit(chatId: Id, messageId: Id, text: string) {
    this.sendCmd('edit', { chatId, messageId, text })
  }
  delete(chatId: Id, messageIds: Id[], forEveryone: boolean) {
    this.sendCmd('delete', { chatId, messageIds, forEveryone })
  }
  react(chatId: Id, messageId: Id, emoji: string | null) {
    this.sendCmd('react', { chatId, messageId, emoji })
  }
  forward(toChatIds: Id[], messageIds: Id[]) {
    this.sendCmd('forward', { toChatIds, messageIds })
  }
  star(chatId: Id, messageIds: Id[], starred: boolean) {
    this.sendCmd('star', { chatId, messageIds, starred })
  }
  searchAll(query: string) {
    return this.call<Message[]>('searchAll', { query })
  }
  openChat(contactId: Id) {
    return this.call<import('./types').Chat>('openChat', { contactId })
  }
  markRead(chatId: Id) { this.sendCmd('markRead', { chatId }) }
  markUnread(chatId: Id, value: boolean) { this.sendCmd('markUnread', { chatId, value }) }
  setTyping(chatId: Id, typing: boolean) { this.sendCmd('setTyping', { chatId, typing }) }
  setChatFlag(chatId: Id, flag: string, value: boolean) {
    this.sendCmd('setChatFlag', { chatId, flag, value })
  }
  vote(chatId: Id, messageId: Id, optionIndexes: number[]) {
    this.sendCmd('vote', { chatId, messageId, optionIndexes })
  }
  logout() { this.sendCmd('logout') }
  pinMessage(chatId: Id, messageId: Id, pin: boolean) {
    this.sendCmd('pinMessage', { chatId, messageId, pin })
  }
  leaveGroup(chatId: Id) { return this.call<void>('leaveGroup', { chatId }) }
  setPrivacy(setting: string, value: string) { void this.call('setPrivacy', { setting, value }) }
  blocklist() { return this.call<{ jids: string[] }>('blocklist').then((r) => r.jids) }
  profile(jid: Id) { return this.call<import('./types').ProfileInfo>('profile', { jid }) }
  storageStats() { return this.call<{ bytes: number; files: number }>('storageStats') }
  clearCache() { return this.call<{ freed: number }>('clearCache').then((r) => r.freed) }
  download(chatId: Id, messageId: Id) {
    return this.call<{ path?: string; error?: string }>('download', { chatId, messageId })
  }
  onEvent(cb: (e: ServerEvent) => void) {
    this.cbs.add(cb)
    return () => this.cbs.delete(cb)
  }
  dispose() {
    this.closed = true
    this.ws.close()
    this.cbs.clear()
  }
}
