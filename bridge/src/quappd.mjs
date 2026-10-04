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
  proto,
} from '@whiskeysockets/baileys'
import { WebSocketServer } from 'ws'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const HOST = process.env.QUAPP_HOST ?? '127.0.0.1'
const WS_PORT = Number(process.env.QUAPP_WS_PORT ?? 8765)
const MEDIA_PORT = Number(process.env.QUAPP_MEDIA_PORT ?? 8766)
const DATA = process.env.QUAPP_DATA ?? path.join(process.cwd(), 'quapp-data')
const AUTH_DIR = path.join(DATA, 'auth')
const MEDIA_DIR = path.join(DATA, 'media')
const MEDIA_BASE = `http://${HOST}:${MEDIA_PORT}/m`
for (const d of [AUTH_DIR, MEDIA_DIR]) fs.mkdirSync(d, { recursive: true })

// per-launch command token — any local webpage could otherwise drive the WS
// (browsers don't preflight WebSocket). Quapp reads it from this file via the
// Electron main process and attaches it as ?token= on the ws URL.
// QUAPPD_DEV=1 skips the check for standalone development.
const DEV = process.env.QUAPPD_DEV === '1'
// persistent per data dir (not per launch) so a daemon restart doesn't strand
// an already-loaded renderer with a stale token
const TOKEN_FILE = path.join(DATA, 'token.txt')
let TOKEN = ''
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim() } catch { /* first boot */ }
if (!TOKEN) {
  TOKEN = crypto.randomBytes(24).toString('base64url')
  try { fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 }) } catch { /* ok */ }
}

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
  historySeen: false,
  me: null, // {id, name, phone}
  chats: new Map(), // jid -> Chat model
  contacts: new Map(), // jid -> Contact model
  msgs: new Map(), // chatId -> Map<id, {proto, model}>
  lastKey: new Map(), // chatId -> raw key of newest incoming msg (read receipts)
  flags: { favorite: new Set(), unread: new Set(), starred: new Set() },
  typingTimers: new Map(), // chatId -> Map<jid, timeout>
  lidToPn: new Map(), // '@lid' -> '@s.whatsapp.net' (privacy-hidden ids)
  pushNames: new Map(), // jid -> last seen pushName
  clients: new Set(),
  readyWaiters: [],
  avatarQueued: new Set(),
  metaQueued: new Set(),
  subscribedPresence: new Set(),
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

// ---------- durable state ----------
// WhatsApp replays full history exactly once, at link time (ZapFast's
// archive.db exists for the same reason) — so chats, contacts and messages
// are persisted here and survive daemon restarts.
const STATE_FILE = path.join(DATA, 'state.v1.json')
const MSGS_PERSIST_CAP = 400 // per chat — deep scrolls stay on-demand anyway
let stateDirty = false
let stateTimer = null
const markDirty = () => {
  stateDirty = true
  if (stateTimer) return
  stateTimer = setTimeout(writeState, 4000)
}
function writeState() {
  stateTimer = null
  if (!stateDirty) return
  stateDirty = false
  try {
    const msgs = {}
    for (const [cid, bucket] of S.msgs) {
      const arr = [...bucket.values()].slice(-MSGS_PERSIST_CAP)
      msgs[cid] = arr.map((e) => ({
        m: e.model,
        p: Buffer.from(proto.WebMessageInfo.encode(e.proto).finish()).toString('base64'),
      }))
    }
    const st = {
      chats: [...S.chats.values()],
      contacts: [...S.contacts.values()],
      lidToPn: [...S.lidToPn],
      pushNames: [...S.pushNames],
      me: S.me,
      msgs,
    }
    const tmp = STATE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(st))
    fs.renameSync(tmp, STATE_FILE)
  } catch (e) { log('state write failed:', e?.message) }
}
try {
  const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  for (const c of st.chats ?? []) S.chats.set(c.id, c)
  for (const c of st.contacts ?? []) S.contacts.set(c.id, c)
  for (const [k, v] of st.lidToPn ?? []) S.lidToPn.set(k, v)
  for (const [k, v] of st.pushNames ?? []) S.pushNames.set(k, v)
  S.me = st.me ?? null
  for (const [cid, arr] of Object.entries(st.msgs ?? {})) {
    const bucket = new Map()
    for (const { m, p } of arr) {
      try { bucket.set(m.id, { proto: proto.WebMessageInfo.decode(Buffer.from(p, 'base64')), model: m }) } catch { /* bad blob */ }
    }
    if (bucket.size) S.msgs.set(cid, bucket)
  }
  log(`state restored: ${S.chats.size} chats, ${S.contacts.size} contacts, ${S.msgs.size} msg buckets`)
} catch { /* first run */ }

const emit = (ev) => {
  const raw = JSON.stringify({ ev })
  for (const ws of S.clients) if (ws.readyState === 1) ws.send(raw)
}
const respond = (ws, id, ok, resultOrErr) => {
  try {
    if (ws.readyState === 1)
      ws.send(JSON.stringify(ok ? { id, ok: true, result: resultOrErr } : { id, ok: false, error: String(resultOrErr?.message ?? resultOrErr) }))
  } catch { /* socket raced a close */ }
}

// ---------- helpers ----------
const norm = (jid) => jidNormalizedUser(jid ?? '')
// strip the :device suffix — all chat/participant jids are device-less
const ownJid = () => (S.me ? S.me.id.split(':')[0] + '@' + S.me.id.split('@')[1] : '')
const msgsOf = (chatId) => S.msgs.get(chatId) ?? new Map()
const sortedMsgs = (chatId) => [...msgsOf(chatId).values()].map((e) => e.model).sort((a, b) => a.ts - b.ts)
const enc = encodeURIComponent
const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const contactName = (jid) => {
  const c = S.contacts.get(norm(jid))
  return c?.name ?? c?.firstName ?? undefined
}
// LIDs are privacy aliases — resolve to the real phone jid when we know it
const resolveJid = (jid) => jid.endsWith('@lid') ? (S.lidToPn.get(jid) ?? jid) : jid
const displayName = (jid) => {
  jid = norm(jid)
  if (jid === ownJid()) return 'You'
  const real = resolveJid(jid)
  const c = S.contacts.get(real) ?? S.contacts.get(jid)
  if (c?.name || c?.firstName) return c.name ?? c.firstName
  const pn = S.pushNames.get(real) ?? S.pushNames.get(jid)
  if (pn) return pn
  if (real.endsWith('@lid')) return 'WhatsApp user' // still no mapping
  if (isJidGroup(real)) return 'Group'
  if (isJidNewsletter(real)) return 'Channel'
  return '+' + real.split('@')[0]
}

function upsertContact(raw) {
  const jid = norm(raw.id ?? raw.jid ?? raw.lid)
  if (!jid || jid.includes('@broadcast') || isJidNewsletter(jid)) return
  // Baileys gives { id, lid } pairs — index under both so @lid chats resolve
  const lid = raw.lid ? norm(raw.lid) : null
  if (lid && lid !== jid) {
    S.lidToPn.set(lid, jid)
    const lc = S.contacts.get(lid) ?? {}
    S.contacts.set(lid, { ...lc, id: lid, linkedJid: jid })
  }
  const prev = S.contacts.get(jid)
  const c = {
    id: jid,
    name: raw.name ?? raw.verifiedName ?? raw.notify ?? prev?.name ?? displayName(jid),
    firstName: raw.name?.split(' ')[0],
    about: raw.status ?? prev?.about,
    phone: jid.endsWith('@s.whatsapp.net') ? '+' + jid.split('@')[0] : undefined,
    avatarHue: hue(jid),
    avatarUrl: prev?.avatarUrl ?? `http://${HOST}:${MEDIA_PORT}/a/${encodeURIComponent(jid)}?token=${TOKEN}`,
    verified: !!raw.verifiedName,
  }
  S.contacts.set(jid, c)
  markDirty()
  // a contact arriving late may resolve a chat titled '+digits'/'WhatsApp user'
  retitleChats()
}
function retitleChats() {
  for (const ch of S.chats.values()) {
    if (ch.kind !== 'dm') continue
    if (!ch.title.startsWith('+') && ch.title !== 'WhatsApp user') continue
    const better = displayName(ch.id)
    if (better !== ch.title && better !== 'WhatsApp user' && !better.startsWith('+')) {
      ch.title = better
      emit({ type: 'chat_update', chat: ch })
      markDirty()
    } else if (better.startsWith('+') && ch.title === 'WhatsApp user') {
      ch.title = better // resolved lid → real number beats a generic label
      emit({ type: 'chat_update', chat: ch })
      markDirty()
    }
  }
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
    muted: muteEnds(raw.muteEndTime) || prev?.muted || false,
    archived: !!raw.archived || prev?.archived || false,
    favorite: S.flags.favorite.has(jid),
    unread: raw.unreadCount ?? prev?.unread ?? 0,
    markedUnread: !!raw.markedAsUnread || S.flags.unread.has(jid),
    lastActivity: raw.conversationTimestamp
      ? Number(raw.conversationTimestamp) * 1000
      : (prev?.lastActivity ?? lastMsgTs(jid)),
    draft: prev?.draft,
    pinnedMessageId: prev?.pinnedMessageId,
    ephemeral: !!raw.ephemeralExpiration,
    youAdmin: prev?.youAdmin,
    contactId: kind === 'dm' ? jid : undefined,
  }
  if (!chat.avatarUrl && (kind === 'dm' || kind === 'group' || kind === 'channel'))
    chat.avatarUrl = `http://${HOST}:${MEDIA_PORT}/a/${encodeURIComponent(jid)}?token=${TOKEN}` // lazy proxy — resolves fresh, never expires client-side
  S.chats.set(jid, chat)
  markDirty()
  if (kind === 'group' && !chat.participants.length) queueGroupMeta(jid)
  if (kind === 'channel' && !raw.name) queueNewsMeta(jid)
  return chat
}
// -1 = muted forever; a future timestamp = until then
const muteEnds = (m) => { const n = Number(m ?? 0); return n < 0 || n > Date.now() }
const lastMsgTs = (chatId) => {
  const arr = msgsOf(chatId)
  let t = 0
  for (const { model } of arr.values()) if (model.ts > t) t = model.ts
  return t
}

// ---------- message conversion ----------
const STATUS = { 0: 'failed', 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' }
const mediaUrl = (chatId, id) => `${MEDIA_BASE}/${enc(chatId)}/${enc(id)}?token=${TOKEN}`

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
      return { kind: 'document', name: d.fileName ?? 'Document', size: Number(d.fileLength ?? 0), mime: d.mimetype ?? 'application/octet-stream', pages: d.pageCount, url: mediaUrl(chatId, id) }
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
      from: norm(ctx.participant ?? '') === ownJid() ? 'me' : norm(ctx.participant ?? chatId),
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
  markDirty()
  const chat = S.chats.get(model.chatId)
  if (chat) chat.lastActivity = Math.max(chat.lastActivity, model.ts)
  // learn pushNames from messages — the only name source for @lid contacts
  const sender = norm(raw.key?.participant ?? raw.key?.remoteJid ?? '')
  if (raw.pushName && sender && sender !== ownJid()) {
    S.pushNames.set(sender, raw.pushName)
    // a DM titled '+'+digits or 'WhatsApp user' upgrades to the real name
    const dc = S.chats.get(sender)
    if (dc && (dc.title.startsWith('+') || dc.title === 'WhatsApp user')) {
      dc.title = raw.pushName
      emit({ type: 'chat_update', chat: dc })
    }
    const ct = S.contacts.get(sender)
    if (ct && !ct.name) ct.name = raw.pushName
  }
  // receipts need a key even for messages that only arrived via history
  if (!raw.key?.fromMe && raw.key) S.lastKey.set(model.chatId, raw.key)
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
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      shouldSyncHistoryMessage: () => true,
      shouldIgnoreJid: (jid) => isJidBroadcast(jid),
    })
    S.sock = sock
    // ignore events from a socket that was replaced (logout / overlapping
    // reconnects) — they would null out live state and write stale creds
    const safe = (fn) => (...a) => {
      if (sock !== S.sock) return
      try { fn(...a) } catch (e) { log('event handler failed:', e?.message) }
    }
    sock.ev.on('creds.update', (...a) => S.authState?.saveCreds?.(...a))
    sock.ev.on('connection.update', safe(onConn))
    sock.ev.on('messaging-history.set', safe(onHistory))
    sock.ev.on('chats.upsert', safe((chats) => { for (const c of chats) { const m = upsertChat(c); if (m) emit({ type: 'chat_update', chat: m }) } }))
    sock.ev.on('chats.update', safe(onChatsUpdate))
    sock.ev.on('chats.delete', safe((jids) => {
      for (const j of jids) {
        const chatId = norm(j)
        S.chats.delete(chatId); S.msgs.delete(chatId)
        emit({ type: 'chat_removed', chatId })
      }
    }))
    sock.ev.on('contacts.upsert', safe((cs) => { for (const c of cs) upsertContact(c) }))
    sock.ev.on('contacts.update', safe((cs) => { for (const c of cs) upsertContact(c) }))
    sock.ev.on('messages.upsert', safe(onMessages))
    sock.ev.on('messages.update', safe(onMessagesUpdate))
    sock.ev.on('messages.delete', safe(onMessagesDelete))
    sock.ev.on('presence.update', safe(onPresence))
    sock.ev.on('groups.update', safe((mds) => { for (const md of mds ?? []) applyGroupMeta(md) }))
    sock.ev.on('groups.upsert', safe((mds) => { for (const md of mds ?? []) applyGroupMeta(md) }))
    sock.ev.on('group-participants.update', safe(({ id, participants, action }) => {
      const jid = norm(id); const chat = S.chats.get(jid)
      if (!chat) return
      const who = new Set((participants ?? []).map(norm))
      if (action === 'remove') chat.participants = chat.participants.filter((p) => !who.has(p))
      else if (action === 'add') chat.participants = [...new Set([...chat.participants, ...who])]
      else { S.metaQueued.delete(jid); queueGroupMeta(jid); return } // promote/demote/etc → refetch
      emit({ type: 'chat_update', chat })
    }))
    log('socket started, protocol', version.join('.'))
  } catch (e) {
    S.sock = null
    log('socket start failed:', e?.message)
    setTimeout(ensureSocket, 10000) // offline? keep retrying instead of idling
  } finally {
    S.connecting = false
  }
}

function applyGroupMeta(md) {
  const jid = norm(md.id)
  const chat = S.chats.get(jid) ?? upsertChat({ id: jid })
  if (!chat) return
  if (md.subject) chat.title = md.subject
  if (md.participants?.length) {
    // jid = real number, id = whatever the group addresses (lid-mode groups → @lid)
    chat.participants = md.participants.map((p) => norm(p.jid ?? p.id))
    const me = ownJid()
    chat.youAdmin = md.participants.some((p) => (norm(p.jid ?? p.id) === me || norm(p.id) === me) && !!p.admin)
  }
  if (md.ephemeralDuration) chat.ephemeral = true
  emit({ type: 'chat_update', chat })
  for (const p of md.participants ?? []) {
    // participants carry both identities — {id: as-sent, jid: pn, lid: @lid}
    if (p.lid && p.jid) S.lidToPn.set(norm(p.lid), norm(p.jid))
    upsertContact({ id: p.jid ?? p.id })
  }
  // once the LID map grows, unresolved chat titles may now resolve — emit updates
  retitleChats()
}

function onConn({ connection, lastDisconnect, qr }) {
  if (qr) { S.lastQr = qr; emit({ type: 'qr', qr }) }
  if (connection === 'open') {
    S.open = true
    S.backoff = 2000
    S.lastQr = null
    const u = S.sock.user
    const devId = norm(u.id)
    S.me = { id: devId.split(':')[0] + '@' + devId.split('@')[1], name: u.name ?? 'Me', phone: '+' + devId.split(':')[0] }
    emit({ type: 'linked', account: snapshot().account })
    log('linked as', S.me.name)
    // resolve early if history already arrived or shortly after
    setTimeout(maybeReady, 12000)
    // if the link raced a 515 restart, history may never arrive — at least
    // pull groups so the chat list isn't empty, and emit what we have
    setTimeout(() => {
      if (!S.open) return
      if (!S.historyDone && !S.historySeen && S.chats.size < 30) {
        // the phone never pushed the chat list — force a FULL app-state
        // resync by clearing the stored collection versions (return_snapshot
        // is only sent when a collection has no saved version). Replays every
        // chat/contact/mute/archive mutation through chats.update+contacts.upsert.
        log('no history received — full app-state resync')
        void (async () => {
          try {
            await S.authState?.state?.keys?.set?.({
              'app-state-sync-version': { regular_high: null, regular_low: null, regular: null, critical_unblock_low: null, critical_block: null },
            })
            await S.sock?.resyncAppState?.(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], false)
            S.sock?.ev?.flush?.()
          } catch (e) { log('appstate resync failed:', e?.message) }
        })()
      }
      if (S.chats.size === 0) {
        S.sock?.groupFetchAllParticipating?.()
          .then((groups) => {
            for (const g of Object.values(groups ?? {})) {
              const m = upsertChat({ id: g.id, name: g.subject })
              if (m) emit({ type: 'chat_update', chat: m })
            }
            log(`group fallback: ${S.chats.size} chats`)
          })
          .catch((e) => log('group fetch failed:', e?.message))
      }
      // discovery: probe synced contacts for on-demand history to rebuild
      // the DM list when the initial history push never arrived
      setTimeout(() => {
        if (!S.open) return
        const known = new Set(S.chats.keys())
        const candidates = [...S.contacts.keys()]
          .filter((j) => (j.endsWith('@s.whatsapp.net') || j.endsWith('@lid')) && !known.has(j))
          .slice(0, 150)
        log(`contact discovery: ${candidates.length} candidates`)
        if (!candidates.length) return
        let i = 0
        const tick = () => {
          if (!S.open || i >= candidates.length) return
          void requestHistory(candidates[i++], 25)
          setTimeout(tick, 1600)
        }
        tick()
      }, 25000)
    }, 15000)
  }
  if (connection === 'close') {
    S.open = false
    const code = lastDisconnect?.error?.output?.statusCode
    const detail = lastDisconnect?.error?.output?.payload?.error ?? lastDisconnect?.error?.message ?? ''
    if (code === DisconnectReason.loggedOut) {
      log('logged out — clearing session')
      S.me = null
      S.historyDone = false
      readyEmitted = false
      S.authState = null // in-memory creds are dead too — never reuse them
      S.chats.clear(); S.msgs.clear(); S.contacts.clear()
      S.lidToPn.clear(); S.pushNames.clear()
      stateDirty = false
      try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.rmSync(STATE_FILE, { force: true }); fs.rmSync(MEDIA_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch { /* retried on next boot */ }
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
  S.historySeen = true
  for (const c of contacts ?? []) upsertContact(c)
  for (const c of chats ?? []) upsertChat(c)
  const arr = Array.isArray(messages) ? messages : Object.values(messages ?? {})
  let n = 0
  for (const raw of arr) {
    // history replays reactions / poll votes / protocol msgs too — apply them
    // to their targets instead of rendering "Unsupported message" rows
    const jid = norm(raw.key?.remoteJidAlt ?? raw.key?.remoteJid)
    const inner = extractMessageContent(raw.message)
    const t = inner && getContentType(inner)
    if (t === 'reactionMessage') { applyReaction(raw, inner.reactionMessage); continue }
    if (t === 'pollUpdateMessage') { void applyPollUpdate(raw, inner.pollUpdateMessage); continue }
    if (t === 'protocolMessage') {
      const p = inner.protocolMessage
      if (p?.type === 14 && p.editedMessage) applyEdit(raw, p)
      else if (p?.type === 0) applyRevoke(jid, p.key?.id)
      continue
    }
    if (t === 'senderKeyDistributionMessage' || t === 'keepInChatMessage') continue
    const model = toModel(raw)
    if (model) { storeRaw(raw, model); n++ }
  }
  if (isLatest || syncType === 0 || syncType === 7) S.historyDone = true // FULL_BOOTSTRAP / latest / NO_HISTORY
  log(`history sync type=${syncType} latest=${!!isLatest}: ${chats?.length ?? 0} chats, ${contacts?.length ?? 0} contacts, ${arr.length} messages (${n} stored)`)
  maybeReady()
  // every chunk (incl. ON_DEMAND fetches) is a reason for the UI to resync
  let total = 0
  for (const b of S.msgs.values()) total += b.size
  emit({ type: 'sync_progress', chats: S.chats.size, contacts: S.contacts.size, messages: total })
  emit({ type: 'history_done' })
  kickMetaQueue()
}

function onChatsUpdate(updates) {
  for (const u of updates) {
    const jid = norm(u.id)
    const chat = S.chats.get(jid)
    if (!chat) { const m = upsertChat(u); if (m) emit({ type: 'chat_update', chat: m }); continue }
    if (u.name) chat.title = u.name
    if (u.unreadCount != null) chat.unread = u.unreadCount
    if (u.pinned != null) chat.pinned = !!u.pinned
    if (u.archived != null) chat.archived = !!u.archived
    if (u.muteEndTime != null) chat.muted = muteEnds(u.muteEndTime)
    if (u.conversationTimestamp != null) chat.lastActivity = Math.max(chat.lastActivity, Number(u.conversationTimestamp) * 1000)
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
    const jid = norm(raw.key?.remoteJidAlt ?? raw.key?.remoteJid)
    if (!jid || isJidBroadcast(jid)) continue
    const inner = extractMessageContent(raw.message)
    const t = inner && getContentType(inner)

    if (t === 'reactionMessage') { applyReaction(raw, inner.reactionMessage); continue }
    if (t === 'pollUpdateMessage') { void applyPollUpdate(raw, inner.pollUpdateMessage); continue }
    if (t === 'protocolMessage') {
      const p = inner.protocolMessage
      if (p?.type === 14 && p.editedMessage) applyEdit(raw, p) // MESSAGE_EDIT
      else if (p?.type === 0) applyRevoke(jid, p.key?.id) // REVOKE
      continue
    }
    if (t === 'senderKeyDistributionMessage' || t === 'keepInChatMessage') continue
    if (raw.message?.protocolMessage?.type === 0) { applyRevoke(jid, raw.message.protocolMessage.key?.id); continue }

    const model = toModel(raw)
    if (!model) continue
    const isNewChat = !S.chats.has(jid)
    if (isNewChat) upsertChat({ id: jid })
    storeRaw(raw, model)

    const chat = S.chats.get(jid)
    if (type === 'notify') {
      if (chat) { chat.unread = model.from === 'me' ? chat.unread : chat.unread + 1; chat.lastActivity = model.ts }
      emit({ type: 'message', msg: model })
      if (chat) emit({ type: 'chat_update', chat })
    } else {
      // 'append' = offline backfill, not a live ping — the UI inserts it into
      // the bucket but must not bump unread or the "new messages" pill
      if (chat && (chat.lastActivity < model.ts || isNewChat)) { chat.lastActivity = Math.max(chat.lastActivity, model.ts); emit({ type: 'chat_update', chat }) }
      emit({ type: 'message', msg: model, backfill: true })
    }
  }
}

function applyReaction(raw, r) {
  const chatId = norm(raw.key.remoteJid)
  const targetId = r.key?.id
  const entry = msgsOf(chatId).get(targetId)
  if (!entry) return
  const reactor = raw.key.fromMe ? 'me' : norm(raw.key.participant ?? raw.key.remoteJid)
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
    // aggregate over ALL update messages seen so far — each update replaces a
    // voter's prior selection, never adds to it
    entry.pollUpdates ??= []
    entry.pollUpdates.push(raw)
    const votes = await getAggregateVotesInPollMessage({ message: entry.proto, pollUpdates: entry.pollUpdates }, ownJid())
    for (const o of entry.model.content.options) o.votes = 0
    for (const v of votes ?? []) {
      const i = entry.model.content.options.findIndex((o) => o.text === v.name)
      if (i >= 0) entry.model.content.options[i].votes = v.voters?.length ?? 0
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
    if (update?.pollUpdates?.length) {
      for (const pu of update.pollUpdates) void applyPollUpdate({ key: { remoteJid: chatId, participant: key.participant } }, pu)
      continue
    }
    if (update?.starred != null) {
      const entry = msgsOf(chatId).get(key.id)
      if (entry) { entry.model.starred = update.starred; emit({ type: 'message_update', msg: entry.model }) }
      continue
    }
    if (update?.status == null) continue
    const delivery = STATUS[update.status]
    if (!delivery) continue
    const entry = msgsOf(chatId).get(key.id)
    if (entry && entry.model.delivery !== 'read' || delivery === 'read') {
      if (entry) entry.model.delivery = delivery
      emit({ type: 'delivery', chatId, ids: [key.id], delivery })
    }
  }
}

function onMessagesDelete(del) {
  // WhatsApp shows "This message was deleted" placeholders — tombstone, not removal
  for (const key of del.keys ?? []) {
    const chatId = norm(key.remoteJid)
    const entry = msgsOf(chatId).get(key.id)
    if (entry) {
      entry.model.content = { kind: 'deleted' }
      entry.model.reactions = undefined
      emit({ type: 'message_update', msg: entry.model })
    }
  }
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
    if (state === 'unavailable' && p.lastSeen != null) {
      const c = S.chats.get(chatId)
      if (c) { c.lastSeen = Number(p.lastSeen) * 1000; emit({ type: 'chat_update', chat: c }) }
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
      // warm the /a/ proxy cache — do NOT expose the raw CDN url
      // (it expires); the proxy resolves a fresh one per request
      const url = await S.sock.profilePictureUrl(jid, 'preview')
      if (url) {
        const r = await fetch(url)
        if (r.ok) avatarCache.set(jid, { buf: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type') ?? 'image/jpeg', at: Date.now() })
      }
    } catch { /* no picture */ }
  })
  kickMetaQueue()
}
const metaRetry = new Map() // jid -> attempts (ZapFast-style backoff)
function queueGroupMeta(jid, attempt = 0) {
  if (attempt === 0 && S.metaQueued.has(jid)) return
  S.metaQueued.add(jid)
  metaQueue.push(async () => {
    try {
      applyGroupMeta(await S.sock.groupMetadata(jid))
      metaRetry.delete(jid)
    } catch (e) {
      const tries = (metaRetry.get(jid) ?? 0) + 1
      metaRetry.set(jid, tries)
      const msg = String(e?.message ?? e)
      const final = /not-authorized|forbidden|item-not-found|404|401/.test(msg) || tries >= 7
      S.metaQueued.delete(jid)
      if (!final) setTimeout(() => queueGroupMeta(jid, tries), Math.min(30000 * 2 ** (tries - 1), 900000))
    }
  })
  kickMetaQueue()
}
function queueNewsMeta(jid) {
  if (S.metaQueued.has(jid)) return
  S.metaQueued.add(jid)
  metaQueue.push(async () => {
    try {
      const md = await S.sock.newsletterMetadata('jid', jid)
      const name = md?.thread_metadata?.name?.text ?? md?.name?.text ?? md?.name
      const chat = S.chats.get(jid)
      if (name && chat && chat.title !== name) {
        chat.title = name
        emit({ type: 'chat_update', chat })
      }
      S.metaQueued.delete(jid)
    } catch (e) { S.metaQueued.delete(jid); log('newsletter meta failed:', e?.message) }
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

// ---------- on-demand history (ZapFast-style: ask the phone when a chat
// loads empty — mirrors "anchor at the present with an empty message id") ----------
const requestedHistory = new Set()
async function requestHistory(chatId, count = 80) {
  const jid = norm(chatId)
  if (!S.open || !jid || !S.sock?.fetchMessageHistory) return false
  const bucket = msgsOf(jid)
  const oldest = bucket.size
    ? [...bucket.values()].reduce((a, b) => (Number(a.proto.messageTimestamp) < Number(b.proto.messageTimestamp) ? a : b))
    : null
  const key = oldest?.proto?.key ?? { remoteJid: jid, id: '', fromMe: false }
  const tsMs = oldest ? Number(oldest.proto.messageTimestamp) * 1000 : Date.now()
  const tag = `${jid}:${key.id || 'head'}`
  if (requestedHistory.has(tag)) return false
  requestedHistory.add(tag)
  // if the phone is offline the answer simply never comes — let the request
  // be retried instead of deduped forever
  setTimeout(() => requestedHistory.delete(tag), 60_000)
  try {
    await S.sock.fetchMessageHistory(count, key, tsMs)
    log(`history request sent (${count} msgs)`)
    return true
  } catch (e) {
    requestedHistory.delete(tag)
    log(`history request failed: ${e?.message}`)
    return false
  }
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
    linked: !!S.me,
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

  async logout() {
    log('logout requested')
    try { await S.sock?.logout() } catch (e) { log('logout call failed:', e?.message) }
    // wipe regardless — the user asked to unpair this device
    S.me = null
    S.historyDone = false
    readyEmitted = false
    requestedHistory.clear()
    S.subscribedPresence.clear()
    S.typingTimers.clear()
    S.chats.clear(); S.msgs.clear(); S.contacts.clear()
    S.flags.favorite.clear(); S.flags.unread.clear(); S.flags.starred.clear(); saveFlags()
    S.lidToPn.clear(); S.pushNames.clear()
    S.authState = null
    try { S.sock?.end?.(undefined) } catch { /* already closed */ }
    S.sock = null
    stateDirty = false
    fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    fs.rmSync(STATE_FILE, { force: true })
    fs.rmSync(MEDIA_DIR, { recursive: true, force: true })
    fs.mkdirSync(AUTH_DIR, { recursive: true })
    setTimeout(ensureSocket, 400) // fresh socket → new QR
    return { ok: true }
  },

  async loadOlder({ chatId, beforeTs, limit }) {
    const arr = sortedMsgs(chatId)
    if (!arr.length) {
      // phone holds the history — ask for it; arrives as ON_DEMAND history.set
      void requestHistory(chatId, 100)
      return { messages: [], hasMore: true }
    }
    const idx = arr.findIndex((m) => m.ts >= beforeTs)
    const end = idx === -1 ? arr.length : idx
    const start = Math.max(0, end - limit)
    const asked = start === 0 && requestHistory(chatId, 100)
    return { messages: arr.slice(start, end), hasMore: start > 0 || !!asked }
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
        const entry = msgsOf(chatId).get(id)
        if (entry) {
          entry.model.content = { kind: 'deleted' }
          entry.model.reactions = undefined
          emit({ type: 'message_update', msg: entry.model })
        }
      } else {
        // delete-for-me: WhatsApp removes the row entirely
        msgsOf(chatId).delete(id)
        emit({ type: 'messages_removed', chatId, ids: [id] })
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
    // live presence for the open chat + pull history if we have none yet
    try { await S.sock?.presenceSubscribe(jid) } catch { /* offline */ }
    if (!msgsOf(jid).size) void requestHistory(jid, 80)
    return chat
  },

  async markRead({ chatId }) {
    const key = S.lastKey.get(chatId)
    if (key) { try { await S.sock.readMessages([key]) } catch { /* receipt best-effort */ } }
    // presence subscribe once per session per direct chat — the UI calls
    // markRead on every open, so this is the reliable hook point
    const jid = norm(chatId)
    if (!jid.endsWith('@g.us') && !S.subscribedPresence.has(jid)) {
      S.subscribedPresence.add(jid)
      void S.sock?.presenceSubscribe(jid).catch(() => {})
    }
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
        const newest = sortedMsgs(chatId).at(-1)
        const lastKey = newest && msgsOf(chatId).get(newest.id)?.proto?.key
        const lastTs = newest ? Math.floor(newest.ts / 1000) : Math.floor(Date.now() / 1000)
        await S.sock.chatModify({ archive: value, lastMessages: lastKey ? [{ key: lastKey, messageTimestamp: lastTs }] : [] }, jid)
      }
    } catch { /* flag stays local if WhatsApp refuses */ }
    if (flag === 'favorite') {
      value ? S.flags.favorite.add(jid) : S.flags.favorite.delete(jid)
      saveFlags()
    }
    chat[flag] = value
    markDirty()
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

  // real privacy settings — mirrors WhatsApp's own toggles
  async setPrivacy({ setting, value }) {
    const map = {
      lastSeen: 'updateLastSeenPrivacy',
      profilePhoto: 'updateProfilePicturePrivacy',
      groupsAdd: 'updateGroupsAddPrivacy',
      readReceipts: 'updateReadReceiptsPrivacy', // 'all' | 'none'
      status: 'updateStatusPrivacy',
    }
    const fn = map[setting]
    if (!fn || !S.sock?.[fn]) return { error: 'unsupported' }
    await S.sock[fn](value)
    return { ok: true }
  },

  async blocklist() {
    try { return { jids: await S.sock.fetchBlocklist() } } catch { return { jids: [] } }
  },

  async leaveGroup({ chatId }) {
    await S.sock.groupLeave(norm(chatId))
    const chat = S.chats.get(norm(chatId))
    if (chat) { S.chats.delete(norm(chatId)); emit({ type: 'chat_update', chat: { ...chat, kind: 'dm', title: chat.title + ' (left)' } }) }
    return { ok: true }
  },

  async pinMessage({ chatId, messageId, pin }) {
    const key = findKey(chatId, messageId)
    if (!key) return { error: 'not found' }
    try {
      await S.sock.sendMessage(norm(chatId), { pin: key, type: pin ? 1 : 2, time: 604800 })
      const chat = S.chats.get(norm(chatId))
      if (chat) {
        chat.pinnedMessageId = pin ? messageId : undefined
        emit({ type: 'chat_update', chat })
      }
    } catch (e) { return { error: e?.message } }
    return { ok: true }
  },

  async storageStats() {
    let bytes = 0, files = 0
    try {
      for (const f of fs.readdirSync(MEDIA_DIR)) {
        const st = fs.statSync(path.join(MEDIA_DIR, f))
        if (st.isFile()) { bytes += st.size; files++ }
      }
    } catch { /* dir missing */ }
    return { bytes, files }
  },

  async clearCache() {
    let freed = 0
    try {
      for (const f of fs.readdirSync(MEDIA_DIR)) {
        const p = path.join(MEDIA_DIR, f)
        freed += fs.statSync(p).size
        fs.rmSync(p, { force: true })
      }
    } catch { /* partial clear is fine */ }
    avatarCache.clear()
    return { freed }
  },

  async download({ chatId, messageId }) {
    const entry = msgsOf(chatId).get(messageId)
    if (!entry) return { error: 'not found' }
    const buf = await mediaBuffer(chatId, messageId)
    if (!buf) return { error: 'unavailable' }
    const name = path.basename(mediaFileName(entry.proto) ?? `${messageId}.bin`).replace(/[^\w .()\[\]-]/g, '_')
    const out = path.join(MEDIA_DIR, `${messageId.slice(0, 24)}-${name}`)
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
      const declared = /^data:([^;,]+)/.exec(content.url ?? content.dataUrl ?? '')?.[1]
      return { audio: b, ptt: content.voice !== false, mimetype: declared ?? 'audio/ogg; codecs=opus' }
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

const avatarCache = new Map() // jid -> {buf, mime, at}
const mediaServer = http.createServer(async (req, res) => {
  if (!DEV && /[?&]token=([^&]+)/.exec(req.url ?? '')?.[1] !== TOKEN) { res.writeHead(403).end(); return }
  const av = /^\/a\/([^/?]+)/.exec(req.url ?? '')
  if (av) {
    const jid = decodeURIComponent(av[1])
    try {
      const hit = avatarCache.get(jid)
      if (hit && Date.now() - hit.at < 300_000) {
        res.writeHead(200, { 'content-type': hit.mime, 'cache-control': 'private, max-age=300' })
        res.end(hit.buf)
        return
      }
      const url = await S.sock?.profilePictureUrl(jid, 'image')
      if (!url) throw new Error('none')
      const r = await fetch(url)
      if (!r.ok) throw new Error('fetch ' + r.status)
      const buf = Buffer.from(await r.arrayBuffer())
      avatarCache.set(jid, { buf, mime: r.headers.get('content-type') ?? 'image/jpeg', at: Date.now() })
      res.writeHead(200, { 'content-type': avatarCache.get(jid).mime, 'cache-control': 'private, max-age=300' })
      res.end(buf)
    } catch {
      if (avatarCache.has(jid)) { // stale beats nothing
        const hit = avatarCache.get(jid)
        res.writeHead(200, { 'content-type': hit.mime }); res.end(hit.buf); return
      }
      res.writeHead(404).end()
    }
    return
  }
  const m = /^\/m\/([^/]+)\/([^/?]+)/.exec(req.url ?? '')
  if (!m) { res.writeHead(404).end(); return }
  const [, chatId, msgId] = m.map(decodeURIComponent)
  const buf = await mediaBuffer(chatId, msgId)
  if (!buf) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'content-type': mediaMime(chatId, msgId), 'cache-control': 'private, max-age=86400' })
  res.end(buf)
})

// ---------- websocket ----------
const wss = new WebSocketServer({
  host: HOST,
  port: WS_PORT,
  verifyClient: (info, done) => {
    if (DEV) return done(true)
    const token = /[?&]token=([^&]+)/.exec(info.req.url ?? '')?.[1]
    done(token === TOKEN)
  },
})
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
// flush the durable state on shutdown — the archive is the only copy
process.on('exit', () => { if (stateDirty) { try { stateTimer && clearTimeout(stateTimer); writeState() } catch {} } })
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
