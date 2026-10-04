// quappd — the Quapp bridge daemon.
// Talks WhatsApp's multi-device protocol via @whiskeysockets/baileys and
// exposes the Quapp ClientAdapter contract over a local JSON WebSocket,
// plus a small HTTP server that serves decrypted message media.
//
//   WS   ws://127.0.0.1:8765   — commands + events (docs/BRIDGE.md)
//   HTTP http://127.0.0.1:8766 — /m/<chatId>/<messageId> media bodies
//
// Privacy: message bodies, numbers, keys and QR payloads are never logged.

import makeWASocket, {
  useMultiFileAuthState as multiFileAuthState,
  DisconnectReason,
  Browsers,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  getContentType,
  extractMessageContent,
  jidNormalizedUser,
  isJidGroup,
  isJidBroadcast,
  isJidNewsletter,
  getAggregateVotesInPollMessage,
} from '@whiskeysockets/baileys'
import { WebSocketServer } from 'ws'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const HOST = process.env.QUAPP_HOST ?? '127.0.0.1'
const WS_PORT = Number(process.env.QUAPP_WS_PORT ?? 8765)
const MEDIA_PORT = Number(process.env.QUAPP_MEDIA_PORT ?? 8766)
const DATA = process.env.QUAPP_DATA ?? path.join(process.cwd(), 'quapp-data')
const AUTH_DIR = path.join(DATA, 'auth')
const MEDIA_DIR = path.join(DATA, 'media')
const MEDIA_BASE = `http://${HOST}:${MEDIA_PORT}/m`
for (const d of [AUTH_DIR, MEDIA_DIR]) fs.mkdirSync(d, { recursive: true })

const log = (...a) => console.log('[quappd]', ...a)
const logger = {
  level: 'warn',
  child() { return this },
  trace() {}, debug() {}, info() {},
  warn(m) { if (typeof m === 'string') log('warn:', m) },
  error(m) { if (typeof m === 'string') log('error:', m) },
  fatal(m) { if (typeof m === 'string') log('fatal:', m) },
}

// ---------- state ----------
const S = {
  sock: null,
  authState: null, // {state, saveCreds} reused across reconnects
  open: false,
  historyDone: false,
  me: null, // {id, name, phone}
  chats: new Map(), // jid -> Chat model
  contacts: new Map(), // jid -> Contact model
  msgs: new Map(), // chatId -> Map<id, {proto, model}>
  lastKey: new Map(), // chatId -> raw key of newest incoming msg (read receipts)
  flags: { favorite: new Set(), unread: new Set(), starred: new Set() },
  typingTimers: new Map(), // chatId -> Map<jid, timeout>
  clients: new Set(),
  readyWaiters: [],
  avatarQueued: new Set(),
  metaQueued: new Set(),
  connecting: false,
  lastQr: null,
  backoff: 2000,
}

const FLAGS_FILE = path.join(DATA, 'flags.json')
try {
  const f = JSON.parse(fs.readFileSync(FLAGS_FILE, 'utf8'))
  for (const k of ['favorite', 'unread', 'starred']) for (const v of f[k] ?? []) S.flags[k].add(v)
} catch { /* first run */ }
let flagsTimer = null
const saveFlags = () => {
  clearTimeout(flagsTimer)
  flagsTimer = setTimeout(() => {
    const f = {}
    for (const k of Object.keys(S.flags)) f[k] = [...S.flags[k]]
    fs.writeFile(FLAGS_FILE, JSON.stringify(f), () => {})
  }, 400)
}

const emit = (ev) => {
  const raw = JSON.stringify({ ev })
  for (const ws of S.clients) if (ws.readyState === 1) ws.send(raw)
}
const respond = (ws, id, ok, resultOrErr) =>
  ws.send(JSON.stringify(ok ? { id, ok: true, result: resultOrErr } : { id, ok: false, error: String(resultOrErr?.message ?? resultOrErr) }))

// ---------- helpers ----------
const norm = (jid) => jidNormalizedUser(jid ?? '')
const ownJid = () => (S.me ? S.me.id : '')
const msgsOf = (chatId) => S.msgs.get(chatId) ?? new Map()
const sortedMsgs = (chatId) => [...msgsOf(chatId).values()].map((e) => e.model).sort((a, b) => a.ts - b.ts)
const enc = encodeURIComponent
const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const contactName = (jid) => {
  const c = S.contacts.get(norm(jid))
  return c?.name ?? c?.firstName ?? undefined
}
const displayName = (jid) => {
  jid = norm(jid)
  if (jid === ownJid()) return 'You'
  const c = S.contacts.get(jid)
  if (c?.name || c?.firstName) return c.name ?? c.firstName
  if (jid.endsWith('@lid')) return 'WhatsApp user'
  return '+' + jid.split('@')[0]
}

function upsertContact(raw) {
  const jid = norm(raw.id ?? raw.jid ?? raw.lid)
  if (!jid || jid.includes('@broadcast') || isJidNewsletter(jid)) return
  const prev = S.contacts.get(jid)
  const c = {
    id: jid,
    name: raw.name ?? raw.verifiedName ?? raw.notify ?? prev?.name ?? displayName(jid),
    firstName: raw.name?.split(' ')[0],
    about: raw.status ?? prev?.about,
    phone: jid.endsWith('@s.whatsapp.net') ? '+' + jid.split('@')[0] : undefined,
    avatarHue: hue(jid),
    avatarUrl: prev?.avatarUrl,
    verified: !!raw.verifiedName,
  }
  S.contacts.set(jid, c)
}

function chatKind(jid) {
  if (jid === ownJid()) return 'saved'
  if (isJidGroup(jid)) return 'group'
  if (isJidNewsletter(jid)) return 'channel'
  return 'dm'
}

function upsertChat(raw) {
  const jid = norm(raw.id)
  if (!jid || isJidBroadcast(jid)) return
  const prev = S.chats.get(jid)
  const kind = chatKind(jid)
  const chat = {
    id: jid,
    kind,
    title: kind === 'saved' ? 'You' : (raw.name ?? raw.subject ?? prev?.title ?? displayName(jid)),
    avatarHue: hue(jid),
    avatarUrl: prev?.avatarUrl,
    participants: prev?.participants ?? [],
    pinned: !!raw.pinned || prev?.pinned || false,
    muted: Number(raw.muteEndTime ?? 0) > Date.now() || prev?.muted || false,
    archived: !!raw.archived || prev?.archived || false,
    favorite: S.flags.favorite.has(jid),
    unread: raw.unreadCount ?? prev?.unread ?? 0,
    markedUnread: !!raw.markedAsUnread || S.flags.unread.has(jid),
    lastActivity: raw.conversationTimestamp
      ? Number(raw.conversationTimestamp) * 1000
      : (prev?.lastActivity ?? lastMsgTs(jid)),
    draft: prev?.draft,
    pinnedMessageId: raw.pinned ?? undefined,
    ephemeral: !!raw.ephemeralExpiration,
    youAdmin: prev?.youAdmin,
    contactId: kind === 'dm' ? jid : undefined,
  }
  S.chats.set(jid, chat)
  queueAvatar(jid)
  if (kind === 'group' && !chat.participants.length) queueGroupMeta(jid)
  return chat
}
const lastMsgTs = (chatId) => {
  const arr = msgsOf(chatId)
  let t = 0
  for (const { model } of arr.values()) if (model.ts > t) t = model.ts
  return t
}

// ---------- message conversion ----------
const STATUS = { 0: 'pending', 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' }
const mediaUrl = (chatId, id) => `${MEDIA_BASE}/${enc(chatId)}/${enc(id)}`

function previewOf(raw) {
  const inner = extractMessageContent(raw?.message)
  if (!inner) return ''
  const t = getContentType(inner)
  const c = inner[t] ?? {}
  return c.caption ?? c.text ?? c.conversation ?? ({
    imageMessage: '📷 Photo', videoMessage: '📹 Video', audioMessage: '🎤 Voice message',
    documentMessage: '📄 ' + (c.fileName ?? 'Document'), stickerMessage: 'Sticker',
    locationMessage: '📍 Location', contactMessage: '👤 Contact', pollCreationMessage: '📊 Poll',
  }[t] ?? 'Message')
}

function convertContent(chatId, id, inner) {
  const type = getContentType(inner)
  const c = inner[type] ?? {}
  switch (type) {
    case 'conversation':
      return { kind: 'text', text: inner.conversation }
    case 'extendedTextMessage': {
      const out = { kind: 'text', text: c.text ?? '' }
      if (c.title && c.matchedText) out.linkPreview = { url: c.matchedText, title: c.title, description: c.description }
      return out
    }
    case 'imageMessage':
      return { kind: 'image', url: mediaUrl(chatId, id), w: c.width ?? 0, h: c.height ?? 0, caption: c.caption || undefined }
    case 'videoMessage': {
      const poster = c.jpegThumbnail ? 'data:image/jpeg;base64,' + Buffer.from(c.jpegThumbnail).toString('base64') : undefined
      return { kind: 'video', url: mediaUrl(chatId, id), poster, w: c.width ?? 0, h: c.height ?? 0, caption: c.caption || undefined, duration: c.seconds ?? 0 }
    }
    case 'audioMessage': {
      const wave = c.waveform ? [...c.waveform].map((b) => b / 255) : undefined
      return { kind: 'audio', duration: c.seconds ?? 0, waveform: wave ?? Array.from({ length: 32 }, (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i * 0.7))), voice: !!c.ptt, file: mediaUrl(chatId, id) }
    }
    case 'documentMessage':
    case 'documentWithCaptionMessage': {
      const d = type === 'documentWithCaptionMessage' ? c.message?.documentMessage ?? {} : c
      return { kind: 'document', name: d.fileName ?? 'Document', size: Number(d.fileLength ?? 0), mime: d.mimetype ?? 'application/octet-stream', pages: d.pageCount }
    }
    case 'stickerMessage':
      return { kind: 'sticker', emoji: c.firstEmoji || '🎭' }
    case 'locationMessage':
      return { kind: 'location', name: c.name || 'Location', address: c.address }
    case 'contactMessage':
      return { kind: 'text', text: `👤 ${c.displayName ?? 'Contact'}` }
    case 'contactsArrayMessage':
      return { kind: 'text', text: `👤 ${c.displayName ?? `${c.contacts?.length ?? ''} contacts`}` }
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3': {
      const p = type === 'pollCreationMessage' ? c : c
      return {
        kind: 'poll',
        question: p.name ?? 'Poll',
        options: (p.options ?? []).map((o) => ({ text: o.optionName ?? '', votes: 0 })),
        multi: p.selectableOptionsCount !== 1 && p.selectableCount !== 1,
      }
    }
    case 'eventMessage':
      return { kind: 'system', text: `📅 ${c.name ?? 'Event'}` }
    case 'protocolMessage':
      return null // handled at a higher level
    default:
      return { kind: 'system', text: 'Unsupported message' }
  }
}

function toModel(raw) {
  const key = raw.key
  if (!key?.remoteJid || !key?.id) return null
  const chatId = norm(key.remoteJid)
  const inner = extractMessageContent(raw.message)
  if (!inner) return null
  const type = getContentType(inner)

  // stub/system messages
  if (raw.messageStubType != null && !inner[type]) {
    const text = stubText(raw)
    if (!text) return null
    return baseModel(raw, chatId, { kind: 'system', text })
  }

  const content = convertContent(chatId, key.id, inner)
  if (!content) return null
  const model = baseModel(raw, chatId, content)

  const ctx = inner[type]?.contextInfo
  if (ctx?.isForwarded) model.forwarded = true
  if (ctx?.quotedMessage) {
    const quotedRaw = { key: { remoteJid: chatId, id: ctx.stanzaId, participant: ctx.participant, fromMe: ctx.participant === ownJid() }, message: ctx.quotedMessage }
    model.replyTo = {
      id: ctx.stanzaId,
      from: quotedRaw.key.fromMe ? 'me' : norm(ctx.participant ?? chatId),
      fromName: displayName(ctx.participant ?? chatId),
      preview: previewOf(quotedRaw),
      kind: 'text',
    }
    const qinner = extractMessageContent(ctx.quotedMessage)
    if (qinner) model.replyTo.kind = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', documentMessage: 'document', stickerMessage: 'sticker', pollCreationMessage: 'poll', locationMessage: 'location' }[getContentType(qinner)] ?? 'text'
  }
  return model
}

function baseModel(raw, chatId, content) {
  const fromMe = !!raw.key.fromMe
  const from = fromMe ? 'me' : norm(raw.key.participant ?? chatId)
  return {
    id: raw.key.id,
    chatId,
    from,
    fromName: fromMe ? undefined : (raw.pushName ?? contactName(from) ?? (S.chats.get(chatId)?.kind === 'dm' ? undefined : displayName(from))),
    ts: Number(raw.messageTimestamp ?? Date.now() / 1000) * 1000,
    delivery: fromMe ? STATUS[raw.status ?? 2] ?? 'sent' : undefined,
    starred: !!raw.starred || S.flags.starred.has(chatId + '' + raw.key.id),
    content,
  }
}

const STUB = {
  1: 'Group created', 2: 'Group created', 4: 'Group name changed',
  5: null, 29: 'A participant was added', 30: 'A participant was added',
  31: 'A participant was removed', 32: 'You were added', 33: 'You were removed',
  68: null, 69: null, 70: null, 71: 'A participant joined via invite link',
  74: 'Group icon changed', 123: 'You joined this chat',
}
function stubText(raw) {
  if (raw.messageStubType === 1 || raw.messageStubType === 2) {
    const who = raw.messageStubParameters?.[0] === 'non_add' ? 'Group created' : 'Group created'
    return who
  }
  if (STUB[raw.messageStubType] === undefined) return 'System message'
  return STUB[raw.messageStubType]
}

function storeRaw(raw, model) {
  let bucket = S.msgs.get(model.chatId)
  if (!bucket) S.msgs.set(model.chatId, (bucket = new Map()))
  if (bucket.size > 20000) { // bound memory: drop oldest
    const oldest = [...bucket.keys()][0]
    bucket.delete(oldest)
  }
  bucket.set(model.id, { proto: raw, model })
  const chat = S.chats.get(model.chatId)
  if (chat) chat.lastActivity = Math.max(chat.lastActivity, model.ts)
}

// ---------- socket ----------
async function ensureSocket() {
  if (S.sock || S.connecting) return
  S.connecting = true
  try {
    if (!S.authState) S.authState = await multiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion()
    const sock = makeWASocket({
      version,
      auth: {
        creds: S.authState.state.creds,
        keys: makeCacheableSignalKeyStore(S.authState.state.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: true,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
      shouldSyncHistoryMessage: () => true,
      shouldIgnoreJid: (jid) => isJidBroadcast(jid),
    })
    S.sock = sock
    sock.ev.on('creds.update', S.authState.saveCreds)
    sock.ev.on('connection.update', onConn)
    sock.ev.on('messaging-history.set', onHistory)
    sock.ev.on('chats.upsert', (chats) => { for (const c of chats) { const m = upsertChat(c); if (m && S.historyDone) emit({ type: 'chat_update', chat: m }) } })
    sock.ev.on('chats.update', onChatsUpdate)
    sock.ev.on('contacts.upsert', (cs) => { for (const c of cs) upsertContact(c) })
    sock.ev.on('contacts.update', (cs) => { for (const c of cs) upsertContact(c) })
    sock.ev.on('messages.upsert', onMessages)
    sock.ev.on('messages.update', onMessagesUpdate)
    sock.ev.on('messages.delete', onMessagesDelete)
    sock.ev.on('presence.update', onPresence)
    log('socket started, protocol', version.join('.'))
  } catch (e) {
    S.sock = null
    log('socket start failed:', e?.message)
  } finally {
    S.connecting = false
  }
}

function onConn({ connection, lastDisconnect, qr }) {
  if (qr) { S.lastQr = qr; emit({ type: 'qr', qr }) }
  if (connection === 'open') {
    S.open = true
    S.backoff = 2000
    S.lastQr = null
    const u = S.sock.user
    S.me = { id: norm(u.id), name: u.name ?? 'Me', phone: '+' + norm(u.id).split('@')[0] }
    emit({ type: 'linked', account: snapshot().account })
    log('linked as', S.me.name)
    // resolve early if history already arrived or shortly after
    setTimeout(maybeReady, 12000)
  }
  if (connection === 'close') {
    S.open = false
    const code = lastDisconnect?.error?.output?.statusCode
    const detail = lastDisconnect?.error?.output?.payload?.error ?? lastDisconnect?.error?.message ?? ''
    if (code === DisconnectReason.loggedOut) {
      log('logged out — clearing session')
      S.me = null
      S.historyDone = false
      fs.rm(AUTH_DIR, { recursive: true, force: true }, () => fs.mkdirSync(AUTH_DIR, { recursive: true }))
    } else {
      log(`connection closed (${code ?? '?'}) ${detail} — reconnecting`)
    }
    S.sock = null
    emit({ type: 'connection', state: 'closed' })
    S.backoff = Math.min((S.backoff ?? 2000) * 2, 30000)
    setTimeout(ensureSocket, code === DisconnectReason.loggedOut ? 500 : S.backoff)
  }
}

let readyEmitted = false
function maybeReady() {
  if (!S.open) return
  readyEmitted = true
  const waiters = S.readyWaiters.splice(0)
  for (const w of waiters) w()
}

function onHistory({ chats, contacts, messages, syncType, isLatest }) {
  for (const c of contacts ?? []) upsertContact(c)
  for (const c of chats ?? []) upsertChat(c)
  const arr = Array.isArray(messages) ? messages : Object.values(messages ?? {})
  let n = 0
  for (const raw of arr) {
    const model = toModel(raw)
    if (model) { storeRaw(raw, model); n++ }
  }
  if (syncType === 0 || isLatest) S.historyDone = true // FULL_BOOTSTRAP or latest chunk
  log(`history sync: ${chats?.length ?? 0} chats, ${arr.length} messages (${n} stored)`)
  maybeReady()
  if (S.historyDone) {
    emit({ type: 'history_done' })
    kickMetaQueue()
  }
}

function onChatsUpdate(updates) {
  for (const u of updates) {
    const jid = norm(u.id)
    const chat = S.chats.get(jid)
    if (!chat) { upsertChat(u); continue }
    if (u.name) chat.title = u.name
    if (u.unreadCount != null) chat.unread = u.unreadCount
    if (u.pinned != null) chat.pinned = !!u.pinned
    if (u.archived != null) chat.archived = !!u.archived
    if (u.muteEndTime != null) chat.muted = Number(u.muteEndTime) > Date.now()
    if (u.markedAsUnread != null) {
      chat.markedUnread = !!u.markedAsUnread
      u.markedAsUnread ? S.flags.unread.add(jid) : S.flags.unread.delete(jid)
      saveFlags()
    }
    emit({ type: 'chat_update', chat })
  }
}

function onMessages({ messages, type }) {
  for (const raw of messages) {
    const jid = norm(raw.key?.remoteJid)
    if (!jid || isJidBroadcast(jid)) continue
    const inner = extractMessageContent(raw.message)
    const t = inner && getContentType(inner)

    if (t === 'reactionMessage') { applyReaction(raw, inner.reactionMessage); continue }
    if (t === 'pollUpdateMessage') { applyPollUpdate(raw, inner.pollUpdateMessage); continue }
    if (t === 'protocolMessage') {
      const p = inner.protocolMessage
      if (p?.type === 14 && p.editedMessage) applyEdit(raw, p) // MESSAGE_EDIT
      else if (p?.type === 0) applyRevoke(jid, p.key?.id) // REVOKE
      continue
    }
    if (raw.message?.protocolMessage?.type === 0) { applyRevoke(jid, raw.message.protocolMessage.key?.id); continue }

    const model = toModel(raw)
    if (!model) continue
    if (!S.chats.has(jid)) upsertChat({ id: jid })
    storeRaw(raw, model)
    if (!raw.key.fromMe) S.lastKey.set(jid, raw.key)

    if (type === 'notify') {
      const chat = S.chats.get(jid)
      if (chat) { chat.unread = model.from === 'me' ? chat.unread : chat.unread + 1; chat.lastActivity = model.ts }
      emit({ type: 'message', msg: model })
      if (chat) emit({ type: 'chat_update', chat })
    } else if (type === 'append' && S.historyDone) {
      // backfill while online — only surface after the initial sync
      emit({ type: 'message', msg: model })
    }
  }
}

function applyReaction(raw, r) {
  const chatId = norm(raw.key.remoteJid)
  const targetId = r.key?.id
  const entry = msgsOf(chatId).get(targetId)
  if (!entry) return
  const reactor = raw.key.fromMe ? 'me' : norm(raw.key.participant ?? r.key.participant ?? chatId)
  const list = (entry.model.reactions ?? []).filter((x) => x.by !== reactor)
  if (r.text) list.push({ emoji: r.text, by: reactor })
  entry.model.reactions = list.length ? list : undefined
  emit({ type: 'message_update', msg: entry.model })
}

async function applyPollUpdate(raw, p) {
  const chatId = norm(raw.key.remoteJid)
  const entry = msgsOf(chatId).get(p.pollCreationMessageKey?.id)
  if (!entry || entry.model.content.kind !== 'poll') return
  try {
    const votes = await getAggregateVotesInPollMessage({ message: entry.proto, pollUpdates: [raw] }, ownJid())
    const counts = new Map()
    for (const v of votes ?? []) for (const opt of v.voters ?? []) counts.set(opt, (counts.get(opt) ?? 0) + 1)
    // votes arrive as [optionHash?] — baileys returns selected option indices in `voters`? fall back to name match
    const opts = entry.model.content.options
    for (const v of votes ?? []) {
      for (const name of v.voters ?? []) {
        const i = opts.findIndex((o) => o.text === name)
        if (i >= 0) opts[i].votes++
      }
    }
    emit({ type: 'message_update', msg: entry.model })
  } catch { /* undecryptable vote — ignore */ }
}

function applyEdit(raw, p) {
  const chatId = norm(raw.key.remoteJid)
  const entry = msgsOf(chatId).get(p.key?.id)
  if (!entry) return
  const inner = extractMessageContent(p.editedMessage)
  const content = inner && convertContent(chatId, p.key.id, inner)
  if (content) entry.model.content = content
  entry.model.edited = true
  emit({ type: 'message_update', msg: entry.model })
}

function applyRevoke(chatId, id) {
  const entry = msgsOf(chatId).get(id)
  if (!entry) return
  entry.model.content = { kind: 'deleted' }
  entry.model.reactions = undefined
  emit({ type: 'message_update', msg: entry.model })
}

function onMessagesUpdate(updates) {
  for (const { key, update } of updates) {
    const chatId = norm(key.remoteJid)
    if (update?.message?.protocolMessage?.type === 14) { applyEdit({ key }, update.message.protocolMessage); continue }
    if (update?.message?.protocolMessage?.type === 0) { applyRevoke(chatId, update.message.protocolMessage.key?.id); continue }
    if (update?.status == null) continue
    const delivery = STATUS[update.status]
    if (!delivery) continue
    const entry = msgsOf(chatId).get(key.id)
    if (entry) entry.model.delivery = delivery
    emit({ type: 'delivery', chatId, ids: [key.id], delivery })
  }
}

function onMessagesDelete(del) {
  const byChat = new Map()
  for (const key of del.keys ?? []) {
    const chatId = norm(key.remoteJid)
    const entry = msgsOf(chatId).get(key.id)
    if (entry) entry.model.content = { kind: 'deleted' }
    if (!byChat.has(chatId)) byChat.set(chatId, [])
    byChat.get(chatId).push(key.id)
  }
  for (const [chatId, ids] of byChat) emit({ type: 'messages_removed', chatId, ids })
}

function onPresence({ id, presences }) {
  const chatId = norm(id)
  for (const [pjid, p] of Object.entries(presences ?? {})) {
    const state = p.lastKnownPresence
    if (state === 'composing' || state === 'recording') {
      let m = S.typingTimers.get(chatId)
      if (!m) S.typingTimers.set(chatId, (m = new Map()))
      const prev = m.get(pjid)
      if (prev) clearTimeout(prev.t)
      const t = setTimeout(() => {
        m.delete(pjid)
        emit({ type: 'typing', chatId, names: [...m.keys()].map(displayName) })
      }, 6000)
      m.set(pjid, { t })
      emit({ type: 'typing', chatId, names: [...m.keys()].map(displayName) })
    } else if (state === 'available' || state === 'unavailable') {
      const m = S.typingTimers.get(chatId)
      if (m?.delete(pjid)) emit({ type: 'typing', chatId, names: [...m.keys()].map(displayName) })
      emit({ type: 'presence', chatId, online: state === 'available' })
    } else if (state === 'paused') {
      const m = S.typingTimers.get(chatId)
      if (m?.delete(pjid)) emit({ type: 'typing', chatId, names: [...m.keys()].map(displayName) })
    }
  }
}

// ---------- background enrichment (avatars + group metadata) ----------
const metaQueue = []
let metaRunning = false
function queueAvatar(jid) {
  if (S.avatarQueued.has(jid)) return
  S.avatarQueued.add(jid)
  metaQueue.push(async () => {
    try {
      const url = await S.sock.profilePictureUrl(jid, 'preview')
      const chat = S.chats.get(jid)
      if (url && chat) { chat.avatarUrl = url; emit({ type: 'chat_update', chat }) }
      const c = S.contacts.get(jid)
      if (url && c) c.avatarUrl = url
    } catch { /* no picture */ }
  })
  kickMetaQueue()
}
function queueGroupMeta(jid) {
  if (S.metaQueued.has(jid)) return
  S.metaQueued.add(jid)
  metaQueue.push(async () => {
    try {
      const md = await S.sock.groupMetadata(jid)
      const chat = S.chats.get(jid)
      if (chat) {
        chat.participants = md.participants.map((p) => norm(p.id))
        chat.youAdmin = md.participants.some((p) => norm(p.id) === ownJid() && p.admin)
        if (md.subject) chat.title = md.subject
        emit({ type: 'chat_update', chat })
      }
      for (const p of md.participants) upsertContact({ id: p.id })
    } catch { /* not a member / rate limited */ }
  })
  kickMetaQueue()
}
async function kickMetaQueue() {
  if (metaRunning || !S.open) return
  metaRunning = true
  while (metaQueue.length && S.open) {
    await metaQueue.shift()()
    await sleep(350)
  }
  metaRunning = false
}

// ---------- snapshot ----------
function snapshot() {
  const chats = [...S.chats.values()].sort((a, b) => b.lastActivity - a.lastActivity)
  const topMessages = {}
  for (const c of chats.slice(0, 60)) {
    const arr = sortedMsgs(c.id)
    if (arr.length) topMessages[c.id] = arr.slice(-40)
  }
  const unreadTotal = chats.reduce((n, c) => n + (c.muted ? 0 : c.unread), 0)
  return {
    account: { id: 'me', name: S.me?.name ?? 'Me', phone: S.me?.phone, avatarHue: hue(S.me?.id ?? 'me'), unreadTotal },
    chats,
    contacts: [...S.contacts.values()],
    topMessages,
  }
}
const waitReady = () =>
  S.open && (S.historyDone || readyEmitted)
    ? Promise.resolve()
    : new Promise((res) => S.readyWaiters.push(res))

// ---------- commands ----------
const findKey = (chatId, messageId) => msgsOf(chatId).get(messageId)?.proto?.key

const CMDS = {
  async connect() {
    await ensureSocket()
    await Promise.race([waitReady(), sleep(30000)])
    return snapshot()
  },

  async loadOlder({ chatId, beforeTs, limit }) {
    const arr = sortedMsgs(chatId)
    const idx = arr.findIndex((m) => m.ts >= beforeTs)
    const end = idx === -1 ? arr.length : idx
    const start = Math.max(0, end - limit)
    return { messages: arr.slice(start, end), hasMore: start > 0 }
  },

  async searchMessages({ chatId, query }) {
    const q = query.toLowerCase()
    return sortedMsgs(chatId).filter((m) => msgText(m).toLowerCase().includes(q)).slice(-60)
  },

  async searchAll({ query }) {
    const q = query.toLowerCase()
    const out = []
    for (const chatId of S.msgs.keys())
      for (const m of sortedMsgs(chatId)) if (msgText(m).toLowerCase().includes(q)) out.push(m)
    return out.sort((a, b) => b.ts - a.ts).slice(0, 80)
  },

  async send({ chatId, content, replyTo }) {
    const jid = norm(chatId)
    const payload = await outPayload(content)
    if (!payload) return
    const opts = {}
    if (replyTo) {
      const quoted = msgsOf(chatId).get(replyTo.id)?.proto
      if (quoted) opts.quoted = quoted
    }
    const sent = await S.sock.sendMessage(jid, payload, opts)
    if (sent) {
      const model = toModel(sent) ?? baseModel(sent, jid, { kind: 'text', text: '' })
      model.delivery = 'pending'
      storeRaw(sent, model)
      const chat = S.chats.get(jid)
      if (chat) { chat.lastActivity = model.ts; emit({ type: 'chat_update', chat }) }
      emit({ type: 'message', msg: model })
    }
  },

  async edit({ chatId, messageId, text }) {
    const key = findKey(chatId, messageId)
    if (!key) return
    await S.sock.sendMessage(norm(chatId), { edit: key, text })
    const entry = msgsOf(chatId).get(messageId)
    if (entry) {
      entry.model.content = { kind: 'text', text }
      entry.model.edited = true
      emit({ type: 'message_update', msg: entry.model })
    }
  },

  async delete({ chatId, messageIds, forEveryone }) {
    for (const id of messageIds) {
      const key = findKey(chatId, id)
      if (forEveryone && key) {
        try { await S.sock.sendMessage(norm(chatId), { delete: key }) } catch { /* revoked server-side anyway */ }
      }
      const entry = msgsOf(chatId).get(id)
      if (entry) {
        entry.model.content = { kind: 'deleted' }
        entry.model.reactions = undefined
        emit({ type: 'message_update', msg: entry.model })
      }
    }
  },

  async react({ chatId, messageId, emoji }) {
    const key = findKey(chatId, messageId)
    if (!key) return
    await S.sock.sendMessage(norm(chatId), { react: { text: emoji ?? '', key } })
    const entry = msgsOf(chatId).get(messageId)
    if (entry) {
      const list = (entry.model.reactions ?? []).filter((r) => r.by !== 'me')
      if (emoji) list.push({ emoji, by: 'me' })
      entry.model.reactions = list.length ? list : undefined
      emit({ type: 'message_update', msg: entry.model })
    }
  },

  async forward({ toChatIds, messageIds }) {
    for (const target of toChatIds) {
      for (const id of messageIds) {
        // find the proto anywhere (source chat may differ)
        let proto = null
        for (const bucket of S.msgs.values()) if (bucket.has(id)) { proto = bucket.get(id).proto; break }
        if (!proto) continue
        try {
          const sent = await S.sock.sendMessage(norm(target), { forward: proto, force: true })
          if (sent) {
            const model = toModel(sent)
            if (model) { model.forwarded = true; storeRaw(sent, model); emit({ type: 'message', msg: model }) }
          }
        } catch { /* skip failed target */ }
      }
    }
  },

  async star({ chatId, messageIds, starred }) {
    for (const id of messageIds) {
      const entry = msgsOf(chatId).get(id)
      if (!entry) continue
      entry.model.starred = starred
      const flagKey = chatId + '' + id
      starred ? S.flags.starred.add(flagKey) : S.flags.starred.delete(flagKey)
      emit({ type: 'message_update', msg: entry.model })
      try {
        await S.sock.chatModify({ star: { messages: [{ id, fromMe: !!entry.proto.key.fromMe }], star: starred } }, norm(chatId))
      } catch { /* starred stays local */ }
    }
    saveFlags()
  },

  async openChat({ contactId }) {
    const jid = norm(contactId.includes('@') ? contactId : contactId + '@s.whatsapp.net')
    let chat = S.chats.get(jid)
    if (!chat) {
      chat = upsertChat({ id: jid })
      emit({ type: 'chat_update', chat })
    }
    return chat
  },

  async markRead({ chatId }) {
    const key = S.lastKey.get(chatId)
    if (key) { try { await S.sock.readMessages([key]) } catch { /* receipt best-effort */ } }
    const chat = S.chats.get(chatId)
    if (chat) {
      chat.unread = 0
      chat.markedUnread = false
      S.flags.unread.delete(chatId)
      saveFlags()
      emit({ type: 'chat_update', chat })
    }
  },

  async markUnread({ chatId, value }) {
    const chat = S.chats.get(chatId)
    if (!chat) return
    chat.markedUnread = !!value
    value ? S.flags.unread.add(chatId) : S.flags.unread.delete(chatId)
    saveFlags()
    emit({ type: 'chat_update', chat })
  },

  async setTyping({ chatId, typing }) {
    try { await S.sock.sendPresenceUpdate(typing ? 'composing' : 'paused', norm(chatId)) } catch { /* offline */ }
  },

  async setChatFlag({ chatId, flag, value }) {
    const chat = S.chats.get(chatId)
    if (!chat) return
    const jid = norm(chatId)
    try {
      if (flag === 'pinned') await S.sock.chatModify({ pin: value }, jid)
      else if (flag === 'muted') await S.sock.chatModify({ mute: value ? 8 * 3600 * 1000 * 24 * 365 : null }, jid)
      else if (flag === 'archived') {
        const last = S.lastKey.get(chatId)
        await S.sock.chatModify({ archive: value, lastMessages: last ? [{ key: last, messageTimestamp: Math.floor(Date.now() / 1000) }] : [] }, jid)
      }
    } catch { /* flag stays local if WhatsApp refuses */ }
    if (flag === 'favorite') {
      value ? S.flags.favorite.add(jid) : S.flags.favorite.delete(jid)
      saveFlags()
    }
    chat[flag] = value
    emit({ type: 'chat_update', chat })
  },

  async vote({ chatId, messageId, optionIndexes }) {
    // sending poll votes needs the encrypted vote message construction;
    // reflect the user's selection locally until a proper impl lands.
    const entry = msgsOf(chatId).get(messageId)
    if (entry?.model.content.kind === 'poll') {
      entry.model.content.voted = optionIndexes
      emit({ type: 'message_update', msg: entry.model })
    }
  },

  async download({ chatId, messageId }) {
    const entry = msgsOf(chatId).get(messageId)
    if (!entry) return { error: 'not found' }
    const buf = await mediaBuffer(chatId, messageId)
    if (!buf) return { error: 'unavailable' }
    const name = mediaFileName(entry.proto) ?? `${messageId}.bin`
    const out = path.join(MEDIA_DIR, `${messageId}-${name}`)
    fs.writeFileSync(out, buf)
    return { path: out }
  },
}

function msgText(m) {
  const c = m.content
  return c.kind === 'text' ? c.text
    : c.kind === 'poll' ? c.question + ' ' + c.options.map((o) => o.text).join(' ')
    : c.caption ?? ''
}

async function outPayload(content) {
  const buf = (url) => (url?.startsWith('data:') ? Buffer.from(url.slice(url.indexOf(',') + 1), 'base64') : null)
  switch (content.kind) {
    case 'text': return { text: content.text }
    case 'image': {
      const b = buf(content.url)
      return b ? { image: b, caption: content.caption } : { image: { url: content.url }, caption: content.caption }
    }
    case 'video': {
      const b = buf(content.url)
      return b ? { video: b, caption: content.caption } : { video: { url: content.url }, caption: content.caption }
    }
    case 'document': {
      const b = buf(content.url ?? content.dataUrl)
      return b ? { document: b, fileName: content.name, mimetype: content.mime } : { document: { url: content.url }, fileName: content.name, mimetype: content.mime }
    }
    case 'audio': {
      const b = buf(content.url ?? content.dataUrl)
      if (!b) return null
      return { audio: b, ptt: content.voice !== false, mimetype: 'audio/ogg; codecs=opus' }
    }
    case 'poll':
      return {
        poll: {
          name: content.question,
          values: content.options.map((o) => o.text),
          selectableCount: content.multi ? 0 : 1,
        },
      }
    default: return null
  }
}

// ---------- media http ----------
function mediaFileName(protoMsg) {
  const inner = extractMessageContent(protoMsg?.message)
  if (!inner) return null
  const t = getContentType(inner)
  const c = inner[t] ?? {}
  return c.fileName ?? c.caption?.slice(0, 40) ?? null
}
async function mediaBuffer(chatId, messageId) {
  const entry = msgsOf(chatId).get(messageId)
  if (!entry) return null
  const cache = path.join(MEDIA_DIR, enc(chatId) + '--' + enc(messageId))
  try {
    if (fs.existsSync(cache)) return fs.readFileSync(cache)
  } catch { /* fall through */ }
  try {
    const buf = await downloadMediaMessage(entry.proto, 'buffer', {}, { logger, reuploadRequest: (m) => S.sock.updateMediaMessage(m) })
    fs.writeFileSync(cache, buf)
    return buf
  } catch (e) {
    log('media download failed:', e?.message)
    return null
  }
}
function mediaMime(chatId, messageId) {
  const entry = msgsOf(chatId).get(messageId)
  const inner = entry && extractMessageContent(entry.proto.message)
  if (!inner) return 'application/octet-stream'
  const c = inner[getContentType(inner)] ?? {}
  return c.mimetype ?? 'application/octet-stream'
}

const mediaServer = http.createServer(async (req, res) => {
  const m = /^\/m\/([^/]+)\/([^/?]+)/.exec(req.url ?? '')
  if (!m) { res.writeHead(404).end(); return }
  const [, chatId, msgId] = m.map(decodeURIComponent)
  const buf = await mediaBuffer(chatId, msgId)
  if (!buf) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'content-type': mediaMime(chatId, msgId), 'cache-control': 'private, max-age=86400', 'access-control-allow-origin': '*' })
  res.end(buf)
})

// ---------- websocket ----------
const wss = new WebSocketServer({ host: HOST, port: WS_PORT })
wss.on('error', (e) => {
  // another daemon already owns the ports — leave quietly, don't fight it
  log(`ws server error: ${e.message ?? e}`)
  process.exit(0)
})
wss.on('connection', (ws) => {
  S.clients.add(ws)
  // a UI that connects after pairing started still needs the current QR
  if (S.lastQr && !S.open) ws.send(JSON.stringify({ ev: { type: 'qr', qr: S.lastQr } }))
  ws.on('close', () => S.clients.delete(ws))
  ws.on('message', async (data) => {
    let f
    try { f = JSON.parse(data) } catch { return }
    const { id, cmd } = f
    const handler = CMDS[cmd]
    if (!handler || id == null) return
    try {
      const result = await handler(f)
      respond(ws, id, true, result ?? null)
    } catch (e) {
      respond(ws, id, false, e)
    }
  })
})

mediaServer.on('error', () => { /* another daemon owns it — ws error handler exits */ })
mediaServer.listen(MEDIA_PORT, HOST, () => {
  log(`ws://${HOST}:${WS_PORT}  media http://${HOST}:${MEDIA_PORT}  data=${DATA}`)
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
