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
      ws.onopen = () => res()
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
  send(chatId: Id, content: OutContent, replyTo?: ReplyRef) {
    void this.call('send', { chatId, content, replyTo })
  }
  edit(chatId: Id, messageId: Id, text: string) {
    void this.call('edit', { chatId, messageId, text })
  }
  delete(chatId: Id, messageIds: Id[], forEveryone: boolean) {
    void this.call('delete', { chatId, messageIds, forEveryone })
  }
  react(chatId: Id, messageId: Id, emoji: string | null) {
    void this.call('react', { chatId, messageId, emoji })
  }
  forward(toChatIds: Id[], messageIds: Id[]) {
    void this.call('forward', { toChatIds, messageIds })
  }
  star(chatId: Id, messageIds: Id[], starred: boolean) {
    void this.call('star', { chatId, messageIds, starred })
  }
  searchAll(query: string) {
    return this.call<Message[]>('searchAll', { query })
  }
  openChat(contactId: Id) {
    return this.call<import('./types').Chat>('openChat', { contactId })
  }
  markRead(chatId: Id) { void this.call('markRead', { chatId }) }
  markUnread(chatId: Id, value: boolean) { void this.call('markUnread', { chatId, value }) }
  setTyping(chatId: Id, typing: boolean) { void this.call('setTyping', { chatId, typing }) }
  setChatFlag(chatId: Id, flag: string, value: boolean) {
    void this.call('setChatFlag', { chatId, flag, value })
  }
  vote(chatId: Id, messageId: Id, optionIndexes: number[]) {
    void this.call('vote', { chatId, messageId, optionIndexes })
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
