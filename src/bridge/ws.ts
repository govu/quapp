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

  private retries = 0

  private open() {
    this.openP = new Promise((res, rej) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.onopen = () => {
        this.retries = 0
        this.push({ type: 'connection', state: 'open', source: 'bridge' }) // lets the store resync after a daemon restart
        res()
      }
      ws.onerror = (e) => rej(e)
      ws.onclose = () => {
        for (const p of this.pending.values()) p.rej(new Error('bridge disconnected'))
        this.pending.clear()
        this.push({ type: 'connection', state: 'closed', source: 'bridge' })
        if (!this.closed) {
          // exponential backoff with jitter — a fixed 1.5s loop hammers a
          // daemon that is mid-restart and looks identical to the user either way
          const delay = Math.min(1200 * 2 ** this.retries++, 12000) * (0.7 + Math.random() * 0.6)
          setTimeout(() => this.open(), delay)
        }
      }
      ws.onmessage = (m) => {
        let f
        try { f = JSON.parse(m.data) } catch { return } // a malformed frame must not throw in the handler
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
  private lastErrMsg = ''
  /** raw daemon/transport errors aren't user copy — map them once */
  private friendlyErr(e: unknown): string {
    const m = String((e as { message?: string })?.message ?? e ?? '')
    if (/disconnect|closed|CLOSED/i.test(m)) return 'Connection lost — retrying…'
    if (/timed? ?out/i.test(m)) return 'Timed out — try again'
    if (/cannot read|of null|undefined/i.test(m)) return "Couldn't reach WhatsApp — check your connection"
    return 'Command failed'
  }
  private errToast(e: unknown) {
    const msg = this.friendlyErr(e)
    const now = Date.now()
    if (now - this.lastErrToast < 2500 && msg === this.lastErrMsg) return
    this.lastErrToast = now
    this.lastErrMsg = msg
    this.push({ type: 'bridge_error', message: msg })
  }
  /** fire-and-forget command that surfaces failures as bridge_error events */
  private sendCmd(cmd: string, args: Record<string, unknown> = {}) {
    this.call(cmd, args).catch((e) => this.errToast(e))
  }

  private async call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.openP
    const id = ++this.seq
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej })
      try {
        this.ws.send(JSON.stringify({ id, cmd, ...args }))
      } catch (e) {
        // send() on a dead socket throws synchronously — settle + free the slot
        this.pending.delete(id)
        rej(e)
      }
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
    // the store awaits this to flip the optimistic row to 'failed' on a
    // transport error — sendCmd would swallow the rejection
    return this.call<unknown>('send', { chatId, content, replyTo, clientId }).then(
      () => undefined,
      (e) => { this.errToast(e); throw e },
    )
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
  setChatFlag(chatId: Id, flag: string, value: boolean, muteMs?: number) {
    this.sendCmd('setChatFlag', { chatId, flag, value, muteMs })
  }
  prefs(p: { autoDlPhotos?: boolean; autoDlDocs?: boolean; linkPreviews?: boolean }) {
    this.sendCmd('prefs', p)
  }
  vote(chatId: Id, messageId: Id, optionIndexes: number[]) {
    this.sendCmd('vote', { chatId, messageId, optionIndexes })
  }
  logout() { this.sendCmd('logout') }
  pinMessage(chatId: Id, messageId: Id, pin: boolean) {
    this.sendCmd('pinMessage', { chatId, messageId, pin })
  }
  clearChat(chatId: Id) { this.sendCmd('clearChat', { chatId }) }
  deleteChat(chatId: Id) { this.sendCmd('deleteChat', { chatId }) }
  leaveGroup(chatId: Id) { return this.call<void>('leaveGroup', { chatId }) }
  setPrivacy(setting: string, value: string) { void this.call('setPrivacy', { setting, value }) }
  blocklist() { return this.call<{ jids: string[] }>('blocklist').then((r) => r.jids) }
  profile(jid: Id) { return this.call<import('./types').ProfileInfo>('profile', { jid }) }
  storageStats() { return this.call<{ bytes: number; files: number }>('storageStats') }
  clearCache() { return this.call<{ freed: number }>('clearCache').then((r) => r.freed) }
  starred() { return this.call<{ msgs: Message[] }>('starred').then((r) => r.msgs) }
  block(jid: Id, blocked: boolean) { this.sendCmd('block', { jid, blocked }) }
  groupEdit(chatId: Id, p: { subject?: string; description?: string }) { this.sendCmd('groupEdit', { chatId, ...p }) }
  createGroup(subject: string, participantJids: Id[]) {
    return this.call<{ chatId?: Id; error?: string }>('createGroup', { subject, participantJids })
  }
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
