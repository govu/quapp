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
  decryptPollVote,
  getKeyAuthor,
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
  lastRx: 0,
}

// on-demand history state (ZapFast fetch_older/early_events) — declared here
// because the durable-state restore below populates them at module load
const pendingOlder = new Map() // chatId -> { asked: ts, explicit: bool, sid: string }
const pendingSid = new Map() // peerDataRequestSessionId -> chatId (exact PDO matching)
const historyStart = new Set() // phone said "nothing older" — never ask again
const pendingReactions = new Map() // 'chatId:msgId' -> [{by, emoji, ts}]
const removalPoint = new Map() // chatId -> ts(ms): deleted chats stay deleted
const rawGroupMeta = new Map() // chatId -> GroupMetadata (cachedGroupMetadata feed)
const EARLY_MAX = 512
const PHONE_PATIENCE = 90_000

// Baileys 7 CacheStore shim — a bounded Map with the expected method names
const lruCache = (max = 5000) => {
  const m = new Map()
  return {
    get: (k) => m.get(k),
    set: (k, v) => {
      if (m.has(k)) m.delete(k)
      else if (m.size >= max) m.delete(m.keys().next().value)
      m.set(k, v)
    },
    del: (k) => m.delete(k),
    flushAll: () => m.clear(),
  }
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
      historyStart: [...historyStart],
      removalPoint: [...removalPoint],
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
  for (const j of st.historyStart ?? []) historyStart.add(j)
  for (const [k, v] of st.removalPoint ?? []) removalPoint.set(k, v)
  S.me = st.me ?? null
  // drop phantom chats/messages persisted before the badJid guard existed
  for (const k of [...S.chats.keys()]) if (badJid(k)) { S.chats.delete(k); S.msgs.delete(k) }
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
// own traffic may arrive under the privacy LID — treat both as "me"
const isOwnJid = (jid) => {
  const j = norm(jid)
  return !!j && (j === ownJid() || (!!S.me?.lid && j === S.me.lid))
}
const msgsOf = (chatId) => S.msgs.get(chatId) ?? S.msgs.get(canonicalJid(chatId)) ?? new Map()
const chatOf = (chatId) => S.chats.get(chatId) ?? S.chats.get(canonicalJid(chatId))
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
// canonical filing id for anything arriving as a jid (ZapFast Worker::canonical):
// a chat behind a privacy id is archived under its phone number once known
const canonicalJid = (jid) => resolveJid(jid)

// ZapFast learn_lid — one mapping learned → refile the chat under the number
function learnLid(lid, pn) {
  lid = norm(lid); pn = norm(pn)
  if (!lid?.endsWith('@lid') || !pn?.endsWith('@s.whatsapp.net') || lid === pn) return
  if (S.lidToPn.get(lid) === pn) return
  S.lidToPn.set(lid, pn)
  markDirty()
  rekeyChat(lid, pn)
  retitleChats()
}

// message keys carry LID↔PN pairs (ZapFast learn_source: sender_alt /
// recipient_alt) — Baileys surfaces them as key.{sender,participant}{Lid,Pn};
// the chat's own identity pairs as (remoteJid, remoteJidAlt) / (sender*, chat)
function learnFromKey(key) {
  if (!key) return
  const pair = (a, b) => {
    a = norm(a); b = norm(b)
    if (a?.endsWith('@lid') && b?.endsWith('@s.whatsapp.net')) learnLid(a, b)
    else if (b?.endsWith('@lid') && a?.endsWith('@s.whatsapp.net')) learnLid(b, a)
  }
  pair(key.senderLid, key.senderPn)
  pair(key.participantLid, key.participantPn)
  pair(key.remoteJidAlt, key.remoteJid)
  pair(key.senderLid, key.remoteJid)
  pair(key.senderPn, key.remoteJid)
  pair(key.participantLid, key.remoteJid)
}

// move a privacy-id chat under its phone number: merge messages, unread,
// metadata — ZapFast rekeys early events too; ours settle via pendingReactions
function rekeyChat(lid, pn) {
  const lc = S.chats.get(lid)
  const pc = S.chats.get(pn)
  if (lc) {
    if (pc) {
      pc.unread += lc.unread
      pc.lastActivity = Math.max(pc.lastActivity ?? 0, lc.lastActivity ?? 0)
      pc.pinned ||= lc.pinned; pc.muted ||= lc.muted; pc.archived ||= lc.archived
      if (!pc.title || pc.title.startsWith('+') || pc.title === 'WhatsApp user') pc.title = lc.title
      S.chats.delete(lid)
    } else {
      lc.id = pn
      S.chats.delete(lid)
      S.chats.set(pn, lc)
    }
    emit({ type: 'chat_removed', chatId: lid })
    emit({ type: 'chat_update', chat: S.chats.get(pn) })
  }
  const lb = S.msgs.get(lid)
  if (lb?.size) {
    const pb = msgsOf(pn)
    for (const [id, e] of lb) {
      e.model.chatId = pn
      if (e.proto?.key) e.proto.key.remoteJid = pn
      if (!pb.has(id)) pb.set(id, e)
    }
    S.msgs.delete(lid)
    S.msgs.set(pn, pb)
    // the renderer owns a bucket under the old id — force a fresh snapshot
    emit({ type: 'history_done' })
  }
  // pending early events filed under the privacy id follow the chat
  for (const [k, q] of pendingReactions) {
    if (!k.startsWith(lid + ':')) continue
    pendingReactions.delete(k)
    pendingReactions.set(pn + ':' + k.slice(lid.length + 1), q)
  }
  // every per-chat map follows the rekey — flags, receipts, pending fetches,
  // "nothing older" knowledge, presence subs, typing timers, tombstones
  if (S.lastKey.has(lid)) { S.lastKey.set(pn, S.lastKey.get(lid)); S.lastKey.delete(lid) }
  if (pendingOlder.has(lid)) { pendingOlder.set(pn, pendingOlder.get(lid)); pendingOlder.delete(lid) }
  if (historyStart.has(lid)) { historyStart.add(pn); historyStart.delete(lid) }
  for (const f of [S.flags.favorite, S.flags.unread, S.flags.starred]) {
    if (f.delete(lid)) f.add(pn)
  }
  if (S.typingTimers.has(lid)) { S.typingTimers.set(pn, S.typingTimers.get(lid)); S.typingTimers.delete(lid) }
  if (S.subscribedPresence.has(lid)) { S.subscribedPresence.add(pn); S.subscribedPresence.delete(lid) }
  if (removalPoint.has(lid)) { removalPoint.set(pn, removalPoint.get(lid)); removalPoint.delete(lid) }
}
// official fallback order: saved name → pushname → masked display_name →
// @username → formatted number — raw lid digits are never a display name
const displayName = (jid) => {
  jid = norm(jid)
  if (isOwnJid(jid)) return 'You'
  const real = resolveJid(jid)
  const c = S.contacts.get(real) ?? S.contacts.get(jid)
  if (c?.name || c?.firstName) return c.name ?? c.firstName
  const pn = S.pushNames.get(real) ?? S.pushNames.get(jid)
  if (pn) return pn
  if (c?.maskedPhone) return c.maskedPhone
  if (c?.username) return '@' + c.username
  if (real.endsWith('@lid')) return 'WhatsApp user' // still no mapping
  if (isJidGroup(real)) return 'Group'
  if (isJidNewsletter(real)) return 'Channel'
  return '+' + real.split('@')[0]
}

function upsertContact(raw) {
  const jid = norm(raw.id ?? raw.jid ?? raw.lid ?? raw.phoneNumber)
  if (!jid || jid.includes('@broadcast') || isJidNewsletter(jid)) return
  // Baileys gives { id, lid } pairs — index under both so @lid chats resolve
  const lid = raw.lid ? norm(raw.lid) : null
  const pn = raw.phoneNumber ? norm(raw.phoneNumber) : null
  if (lid && lid !== jid) {
    learnLid(lid, jid)
    const lc = S.contacts.get(lid) ?? {}
    S.contacts.set(lid, { ...lc, id: lid, linkedJid: jid })
  }
  // 7.x history contacts carry {id, lid, phoneNumber} — learn the lid→pn edge
  if (lid && pn && pn !== lid) {
    learnLid(lid, pn)
    const lc = S.contacts.get(lid) ?? {}
    S.contacts.set(lid, { ...lc, id: lid, linkedJid: pn })
  }
  const prev = S.contacts.get(jid)
  const c = {
    id: jid,
    // never persist the display fallback ('+digits'/'WhatsApp user') — a fake
    // name blocks the pushName upgrade path forever
    name: raw.name ?? raw.verifiedName ?? raw.notify ?? prev?.name,
    firstName: raw.name?.split(' ')[0] ?? prev?.firstName,
    about: raw.status ?? prev?.about,
    username: raw.username ?? prev?.username,
    maskedPhone: raw.displayName ?? prev?.maskedPhone, // '+1∙∙∙∙∙∙∙∙80' for privacy-hidden members
    phone: jid.endsWith('@s.whatsapp.net') ? '+' + jid.split('@')[0] : undefined,
    avatarHue: hue(jid),
    avatarUrl: prev?.avatarUrl ?? `http://${HOST}:${MEDIA_PORT}/a/${encodeURIComponent(jid)}?token=${TOKEN}`,
    verified: !!raw.verifiedName,
  }
  S.contacts.set(jid, c)
  markDirty()
  // a contact arriving late may resolve a chat titled '+digits'/'WhatsApp user'
  scheduleRetitle()
}
// thousands of contacts landing in one sync must not each trigger an
// O(chats) scan + emit storm — coalesce into one pass per 500ms
let retitleTimer = null
function scheduleRetitle() {
  if (retitleTimer) return
  retitleTimer = setTimeout(() => { retitleTimer = null; retitleChats() }, 500)
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
  if (isOwnJid(jid)) return 'saved'
  if (isJidGroup(jid)) return 'group'
  if (isJidNewsletter(jid)) return 'channel'
  return 'dm'
}

// phantom ids seen in the wild ('0@s.whatsapp.net', truncated users) must
// never become chats — phone JIDs always carry a full-length user part.
// (function decls: the state restore above runs before consts initialize)
function badJid(jid) {
  return !jid || isJidBroadcast(jid) || (jid.endsWith('@s.whatsapp.net') && jid.split('@')[0].length < 6)
}
// a group 'name' that is really just a phone number means history sync gave us
// the creator's contact, not the subject — show a neutral placeholder until
// metadata arrives
function looksLikeNumber(t) {
  return /^\+?[\d\s().-]{6,}$/.test(t ?? '')
}

function upsertChat(raw) {
  const jid = canonicalJid(norm(raw.id))
  if (badJid(jid)) return
  const prev = chatOf(jid)
  const kind = chatKind(jid)
  let title = kind === 'saved' ? 'You' : (raw.name ?? raw.subject ?? prev?.title ?? displayName(jid))
  if (kind === 'group' && looksLikeNumber(title)) title = 'Group'
  const chat = {
    id: jid,
    kind,
    title,
    avatarHue: hue(jid),
    avatarUrl: prev?.avatarUrl,
    participants: prev?.participants ?? [],
    // explicit false must clear the flag; absent must preserve — a stale
    // chunk can never regress live state (ZapFast: merge, never decrease)
    pinned: raw.pinned != null ? !!raw.pinned : prev?.pinned ?? false,
    muted: raw.muteEndTime != null ? muteEnds(raw.muteEndTime) : prev?.muted ?? false,
    archived: raw.archived != null ? !!raw.archived : prev?.archived ?? false,
    favorite: S.flags.favorite.has(jid),
    unread: Math.max(raw.unreadCount ?? 0, prev?.unread ?? 0),
    markedUnread: raw.markedAsUnread ?? prev?.markedUnread ?? S.flags.unread.has(jid),
    lastActivity: Math.max(
      raw.conversationTimestamp ? Number(raw.conversationTimestamp) * 1000 : 0,
      prev?.lastActivity ?? lastMsgTs(jid),
    ),
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
    case 'videoMessage':
    case 'ptvMessage': { // round video notes share the video proto shape
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
      return { kind: 'sticker', emoji: c.firstEmoji || '🎭', url: mediaUrl(chatId, id) }
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
    // --- interactive / business surfaces: show the human-readable part ---
    case 'buttonsMessage':
      return { kind: 'text', text: [c.contentText, ...(c.buttons ?? []).map((b) => '▸ ' + (b.buttonText?.displayText ?? ''))].filter(Boolean).join('\n') || 'Buttons' }
    case 'buttonsResponseMessage':
      return { kind: 'text', text: c.selectedDisplayText ?? 'Button response' }
    case 'templateButtonReplyMessage':
      return { kind: 'text', text: c.selectedDisplayText ?? 'Reply' }
    case 'listMessage':
      return { kind: 'text', text: [c.title, c.description, '▸ ' + (c.buttonText ?? 'See options')].filter(Boolean).join('\n') }
    case 'listResponseMessage':
      return { kind: 'text', text: c.title ?? c.singleSelectReply?.selectedRowId ?? 'List response' }
    case 'interactiveMessage': {
      const body = c.body?.text ?? c.carouselCards?.[0]?.body?.text ?? c.header?.title ?? 'Interactive message'
      return { kind: 'text', text: body }
    }
    case 'interactiveResponseMessage': {
      const r = c.nativeFlowResponseMessage?.paramsJson
      if (r) { try { return { kind: 'text', text: JSON.parse(r).id ?? 'Response' } } catch { /* fall through */ } }
      return { kind: 'text', text: 'Response' }
    }
    case 'productMessage':
      return { kind: 'text', text: `🛍️ ${c.product?.productImage ? '' : ''}${c.title ?? c.businessOwnerJid ?? 'Product'}` }
    case 'orderMessage':
      return { kind: 'text', text: `🧾 Order · ${c.itemCount ?? '?'} items${c.orderTitle ? ' · ' + c.orderTitle : ''}` }
    case 'pinInChatMessage':
      return { kind: 'system', text: '📌 Pinned a message' }
    case 'commentMessage': {
      const inner2 = c.message ? extractMessageContent(c.message) : null
      if (inner2) return convertContent(chatId, id, inner2)
      return { kind: 'system', text: '💬 Comment' }
    }
    case 'scheduledCallCreationMessage':
      return { kind: 'system', text: `📞 ${c.title ?? 'Call'} scheduled` }
    case 'groupMentionedMessage':
    case 'groupStatusMentionMessage': {
      const inner2 = c.message ? extractMessageContent(c.message) : null
      if (inner2) return convertContent(chatId, id, inner2)
      return { kind: 'system', text: 'Mentioned in a group status' }
    }
    case 'newsletterAdminInviteMessage':
      return { kind: 'system', text: `📢 Channel invite · ${c.newsletterName ?? ''}` }
    case 'pollCreationMessageV4':
    case 'pollCreationMessageV5':
      return { kind: 'poll', question: c.name ?? 'Poll', options: (c.options ?? []).map((o) => ({ text: o.optionName ?? '', votes: 0 })), multi: true }
    case 'botInvokeMessage':
      return { kind: 'system', text: '🤖 AI response' }
    default:
      return { kind: 'system', text: 'Unsupported message' }
  }
}

function toModel(raw) {
  const key = raw.key
  if (!key?.remoteJid || !key?.id) return null
  const chatId = canonicalJid(norm(key.remoteJid))
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
    const quotedRaw = { key: { remoteJid: chatId, id: ctx.stanzaId, participant: ctx.participant, fromMe: isOwnJid(ctx.participant) }, message: ctx.quotedMessage }
    model.replyTo = {
      id: ctx.stanzaId,
      from: isOwnJid(ctx.participant ?? '') ? 'me' : norm(ctx.participant ?? chatId),
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
    fromName: fromMe ? undefined : (raw.pushName ?? contactName(from) ?? (chatOf(chatId)?.kind === 'dm' ? undefined : displayName(from))),
    ts: Number(raw.messageTimestamp ?? Date.now() / 1000) * 1000,
    delivery: fromMe ? STATUS[raw.status ?? 2] ?? 'sent' : undefined,
    starred: !!raw.starred || S.flags.starred.has(chatId + '' + raw.key.id),
    content,
  }
}

// real WebMessageInfo.StubType values (WAProto enum) — verified 7.x
const STUB = {
  20: 'Group created',
  21: 'Group name changed',
  22: 'Group icon changed',
  27: 'A participant was added',
  28: 'A participant was removed',
  29: 'A participant was promoted to admin',
  30: 'A participant was demoted',
  31: 'A participant joined via invite link',
  32: 'A participant left',
  33: 'A participant changed their number',
  39: 'Messages are end-to-end encrypted',
  40: 'Missed voice call',
  41: 'Missed video call',
  45: 'Missed group voice call',
  46: 'Missed group video call',
  71: 'A participant joined via invite link',
  123: 'You joined this chat',
}
function stubText(raw) {
  const t = STUB[raw.messageStubType]
  if (t === undefined) return 'System message'
  if (raw.messageStubType === 2) return 'Waiting for this message…' // CIPHERTEXT — undecryptable placeholder
  return t
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
  // early events: reactions filed while the message was still missing
  const early = pendingReactions.get(model.chatId + ':' + model.id)
  if (early?.length) {
    pendingReactions.delete(model.chatId + ':' + model.id)
    const byReactor = new Map()
    for (const r of early.sort((a, b) => a.ts - b.ts)) {
      if (r.emoji) byReactor.set(r.by, r.emoji)
      else byReactor.delete(r.by)
    }
    const merged = (model.reactions ?? []).filter((x) => !byReactor.has(x.by))
    for (const [by, emoji] of byReactor) merged.push({ emoji, by })
    model.reactions = merged.length ? merged : undefined
  }
  const chat = chatOf(model.chatId)
  if (chat) chat.lastActivity = Math.max(chat.lastActivity, model.ts)
  // a fresh proto carries new signed URLs — unmark any earlier dead-media verdict
  if (['image', 'video', 'sticker', 'audio', 'document'].includes(model.content?.kind)) {
    mediaDead.delete(model.chatId + ':' + model.id)
    // live media lands warm: a photo arriving while we're online downloads to
    // cache immediately so the bubble never shows a spinner
    if (S.open && S.historyDone) void mediaBuffer(model.chatId, model.id).catch(() => {})
  }
  // learn pushNames from messages — the only name source for @lid contacts
  const sender = canonicalJid(norm(raw.key?.participant ?? raw.key?.remoteJid ?? ''))
  if (raw.pushName && sender && !isOwnJid(sender)) {
    S.pushNames.set(sender, raw.pushName)
    // a DM titled '+'+digits or 'WhatsApp user' upgrades to the real name
    const dc = chatOf(sender)
    if (dc && (dc.title.startsWith('+') || dc.title === 'WhatsApp user')) {
      dc.title = raw.pushName
      emit({ type: 'chat_update', chat: dc })
    }
    const ct = S.contacts.get(sender)
    if (ct && !ct.name) ct.name = raw.pushName
  }
  // receipts need the NEWEST key — history replay ends on the oldest message,
  // which would under-cover every newer incoming one
  if (!raw.key?.fromMe && raw.key) {
    const prev = S.lastKey.get(model.chatId)
    if (!prev || Number(raw.messageTimestamp ?? 0) >= Number(prev.messageTimestamp ?? 0)) {
      S.lastKey.set(model.chatId, { key: raw.key, messageTimestamp: Number(raw.messageTimestamp ?? 0) })
    }
  }
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
      // 7.x: retry-resend needs the original message — we keep full protos
      getMessage: async (key) => {
        const jid = canonicalJid(norm(key?.remoteJid ?? ''))
        const entry = S.msgs.get(jid)?.get(key?.id)
        return entry?.proto?.message
      },
      // cached group metadata speeds up sends & avoids redundant iq queries
      cachedGroupMetadata: async (jid) => rawGroupMeta.get(norm(jid)),
      // caches Baileys 7 uses for retry/device/placeholder bookkeeping
      msgRetryCounterCache: lruCache(2000),
      userDevicesCache: lruCache(5000),
      placeholderResendCache: lruCache(1000),
      callOfferCache: lruCache(200),
    })
    S.sock = sock
    // every decoded frame counts — keepalive answers keep this alive, so a
    // long silence means a wedged link, not an idle one (ZapFast link_watch)
    S.lastRx = Date.now()
    sock.ws?.on?.('frame', () => { S.lastRx = Date.now() })
    // ignore events from a socket that was replaced (logout / overlapping
    // reconnects) — they would null out live state and write stale creds
    const safe = (fn) => (...a) => {
      if (sock !== S.sock) return
      try { fn(...a) } catch (e) { log('event handler failed:', e?.message) }
    }
    sock.ev.on('creds.update', safe((...a) => S.authState?.saveCreds?.(...a)))
    sock.ev.on('connection.update', safe(onConn))
    sock.ev.on('messaging-history.set', safe(onHistory))
    sock.ev.on('chats.upsert', safe((chats) => { for (const c of chats) { const m = upsertChat(c); if (m) emit({ type: 'chat_update', chat: m }) } }))
    sock.ev.on('chats.update', safe(onChatsUpdate))
    sock.ev.on('chats.delete', safe((jids) => {
      for (const j of jids) {
        const chatId = canonicalJid(norm(j))
        S.chats.delete(chatId); S.msgs.delete(chatId)
        // tombstone: history replaying older messages must not resurrect it
        removalPoint.set(chatId, Date.now()); markDirty()
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
      const jid = norm(id); const chat = chatOf(jid)
      if (!chat) return
      // participants arrive as objects {id, phoneNumber?, lid?, admin} —
      // learning each lid↔pn edge is the main way lid-mode groups resolve
      const who = new Set()
      for (const p of participants ?? []) {
        if (typeof p === 'string') { who.add(canonicalJid(norm(p))); continue }
        const pn = p.phoneNumber ?? p.jid ?? null
        if (p.lid && pn) learnLid(p.lid, pn)
        who.add(canonicalJid(norm(pn ?? p.id ?? '')))
      }
      if (action === 'remove') chat.participants = chat.participants.filter((p) => !who.has(p))
      else if (action === 'add') chat.participants = [...new Set([...chat.participants, ...who])]
      else { S.metaQueued.delete(jid); queueGroupMeta(jid); return } // promote/demote/etc → refetch
      emit({ type: 'chat_update', chat })
    }))
    // 7.x: live LID↔PN resolutions between syncs — payload is a single
    // LIDMapping {lid, pn} (Types/Events.d.ts), not a list
    sock.ev.on('lid-mapping.update', safe((m) => {
      if (m?.lid && m?.pn) learnLid(m.lid, m.pn)
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
  const chat = chatOf(jid) ?? upsertChat({ id: jid })
  if (!chat) return
  rawGroupMeta.set(jid, md)
  if (md.subject) chat.title = md.subject
  if (md.participants?.length) {
    // prefer phoneNumber (real PN) — in lid-mode groups `jid`/`id` can be the
    // @lid; display_name carries the masked number for privacy-hidden members
    chat.participants = md.participants.map((p) => canonicalJid(norm(p.phoneNumber ?? p.jid ?? p.id)))
    chat.youAdmin = md.participants.some((p) => (isOwnJid(p.phoneNumber ?? p.jid ?? p.id) || isOwnJid(p.lid)) && !!p.admin)
  }
  if (md.ephemeralDuration) chat.ephemeral = true
  emit({ type: 'chat_update', chat })
  for (const p of md.participants ?? []) {
    // {id: as-addressed, jid: pn|as-addressed, lid: @lid, phoneNumber: pn, displayName: masked}
    const pn = p.phoneNumber ?? p.jid ?? null
    if (p.lid && pn) learnLid(p.lid, pn)
    if (p.id?.endsWith?.('@lid') && pn) learnLid(p.id, pn)
    const cj = canonicalJid(norm(pn ?? p.id ?? ''))
    if (cj) upsertContact({ id: cj, displayName: p.displayName })
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
    S.me = {
      id: devId.split(':')[0] + '@' + devId.split('@')[1],
      name: u.name ?? 'Me',
      phone: '+' + devId.split(':')[0],
      lid: u.lid ? norm(u.lid) : undefined,
    }
    emit({ type: 'linked', account: snapshot().account })
    log('linked as', S.me.name)
    // resolve early if history already arrived or shortly after
    setTimeout(maybeReady, 12000)
    // reconnects never get a history push — without this the "history is
    // settled" flag stays false and live-media warmup never runs
    setTimeout(() => { if (S.open && !S.historySeen) S.historyDone = true }, 20000)
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
            // write through the socket's wrapped keys (tx → cache → disk) —
            // the raw state.keys bypasses the cacheable wrapper the socket
            // actually reads, making the reset a silent no-op
            await S.sock?.authState?.keys?.set?.({
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
      // discovery: probe contacts, empty chats AND stale chats for on-demand
      // history (ZapFast: a chat that synced with a name and no messages gets
      // asked as soon as it loads or opens — we ask in bulk once). Stale
      // covers the real gap: messages lost to a dead session never get
      // requeued, so the newest tail the phone has must be pulled per chat
      setTimeout(() => {
        if (!S.open) return
        const known = new Set(S.chats.keys())
        const staleBefore = Date.now() - 6 * 3600 * 1000
        const emptyChats = [...known].filter((j) => !msgsOf(j).size && (j.endsWith('@s.whatsapp.net') || j.endsWith('@lid')))
        const staleChats = [...known].filter((j) => {
          if (!msgsOf(j).size) return false // empty chats handled above
          return lastMsgTs(j) < staleBefore // newest stored msg is old → tail gap
        })
        // PDO requests are phone-answered and rate-limited — WhatsApp stops
        // replying entirely if we burst (observed: ~15 answers then silence).
        // Prioritize what the user sees: stale chats newest-first, then a few
        // empties; deep archive refresh stays on markRead when opened.
        const staleSorted = staleChats
          .map((j) => [j, lastMsgTs(j) || 0])
          .sort((a, b) => b[1] - a[1])
          .map(([j]) => j)
        const candidates = [
          ...staleSorted.slice(0, 60),
          ...emptyChats.slice(0, 20),
          ...[...S.contacts.keys()].filter((j) => (j.endsWith('@s.whatsapp.net') || j.endsWith('@lid')) && !known.has(j)).slice(0, 20),
        ]
        log(`contact discovery: ${candidates.length} candidates (${emptyChats.length} empty, ${staleChats.length} stale)`)
        if (!candidates.length) return
        let i = 0
        const tick = () => {
          if (!S.open || i >= candidates.length) return
          if (Date.now() < discoveryPauseUntil) { setTimeout(tick, 60000); return } // rate-limited — idle the sweep
          void requestHistory(candidates[i++], 50, false, true, true) // tail anchor — the gap is at the newest end
          setTimeout(tick, 4000) // ~15/min — under the phone's PDO patience
        }
        tick()
      }, 25000)
    }, 15000)
  }
  if (connection === 'close') {
    S.open = false
    // presence subscriptions die with the socket — resubscribe on open
    S.subscribedPresence.clear()
    for (const m of S.typingTimers.values()) for (const { t } of m.values()) clearTimeout(t)
    S.typingTimers.clear()
    const code = lastDisconnect?.error?.output?.statusCode
    const detail = lastDisconnect?.error?.output?.payload?.error ?? lastDisconnect?.error?.message ?? ''
    if (code === DisconnectReason.loggedOut) {
      log('logged out — clearing session')
      S.me = null
      S.historyDone = false
      readyEmitted = false
      syncEndEmitted = false
      S.chats.clear(); S.msgs.clear(); S.contacts.clear()
      S.lidToPn.clear(); S.pushNames.clear()
      wipeAuthDirs()
    } else {
      log(`connection closed (${code ?? '?'}) ${detail} — reconnecting`)
    }
    S.sock = null
    emit({ type: 'connection', state: 'closed' })
    S.backoff = Math.min((S.backoff ?? 2000) * 2, 30000)
    setTimeout(ensureSocket, code === DisconnectReason.loggedOut ? 500 : S.backoff)
  }
}

// rename-then-delete: a pending keys.set writeFile can land AFTER rmSync and
// resurrect the old device (the zombie-session Bad MAC flood). Renaming first
// makes late writes land in the tombstone dir, then it's deleted — and on
// Windows rmSync on open handles can fail partially, leaving files behind.
function wipeAuthDirs() {
  S.authState = null // in-memory creds are dead too — never reuse them
  stateDirty = false
  for (const dir of [AUTH_DIR, MEDIA_DIR]) {
    try {
      const tmp = `${dir}.stale-${Date.now()}`
      fs.renameSync(dir, tmp)
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* retried next boot */ }
    }
  }
  try { fs.rmSync(STATE_FILE, { force: true }) } catch { /* next boot */ }
  try { fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch { /* next boot */ }
}

// silence watchdog (ZapFast SILENCE_LIMIT=120s): WhatsApp's keepalive pings
// every ~30s, so zero frames for 150s while 'open' means the link is wedged —
// a write into it can hang forever and no close event ever arrives
setInterval(() => {
  if (!S.open || !S.sock) return
  const quiet = Date.now() - (S.lastRx ?? 0)
  if (quiet < 150_000) return
  log(`link silent for ${Math.round(quiet / 1000)}s — reconnecting`)
  try { S.sock.end?.(undefined) } catch { /* dead */ }
}, 30_000)

let readyEmitted = false
let syncEndEmitted = false
function maybeReady() {
  if (!S.open) return
  readyEmitted = true
  const waiters = S.readyWaiters.splice(0)
  for (const w of waiters) w()
}

function onHistory({ chats, contacts, messages, syncType, isLatest, progress, peerDataRequestSessionId, lidPnMappings }) {
  S.historySeen = true
  // 7.x: history carries authoritative LID↔PN pairs (also auto-stored in
  // the signal repo) — feed them into our display map for names/numbers
  for (const m of lidPnMappings ?? []) if (m.lid && m.pn) learnLid(m.lid, m.pn)
  // ON_DEMAND answers pending fetchMessageHistory requests (ZapFast:
  // sync_type == ON_DEMAND || peer_data_request_session_id.is_some())
  const onDemand = syncType === 6 || peerDataRequestSessionId != null
  const filed = new Map() // chatId -> count stored this chunk
  for (const c of contacts ?? []) upsertContact(c)
  const chatMore = new Map() // chatId -> endOfHistoryTransferType
  for (const c of chats ?? []) {
    const jid = canonicalJid(norm(c.id))
    // ZapFast removal_point: a chat deleted locally stays deleted — replayed
    // history only resurrects it if it carries newer activity
    const through = removalPoint.get(jid)
    const chatTs = c.conversationTimestamp ? Number(c.conversationTimestamp) * 1000 : 0
    if (through && chatTs <= through && !S.chats.has(jid)) continue
    upsertChat(c)
    // learn chat-level LID edges the history conversation carries
    if (c.lidJid && c.pnJid) learnLid(c.lidJid, c.pnJid)
    else if (jid.endsWith('@lid') && c.pnJid) learnLid(jid, c.pnJid)
    else if (jid.endsWith('@s.whatsapp.net') && c.lidJid) learnLid(c.lidJid, jid)
    if (c.endOfHistoryTransferType != null) chatMore.set(jid, c.endOfHistoryTransferType)
    // 1=COMPLETE_AND_NO_MORE, 3=on-demand complete but no access — the phone
    // has nothing older either way; never ask again (ZapFast history_start)
    if (c.endOfHistoryTransferType === 1 || c.endOfHistoryTransferType === 3) historyStart.add(jid)
  }
  const arr = Array.isArray(messages) ? messages : Object.values(messages ?? {})
  let n = 0
  for (const raw of arr) {
    learnFromKey(raw.key)
    // history replays reactions / poll votes / protocol msgs too — apply them
    // to their targets instead of rendering "Unsupported message" rows
    const jid = canonicalJid(norm(raw.key?.remoteJid))
    const inner = extractMessageContent(raw.message)
    const t = inner && getContentType(inner)
    if (t === 'reactionMessage') { applyReaction(raw, inner.reactionMessage); continue }
    if (t === 'pollUpdateMessage') {
      // 7.x decrypts the vote internally and re-emits it via messages.update
      // ({key:creationMsgKey, pollUpdates:[{vote,...}]}) — raw row never renders
      storePollUpdate(raw, inner.pollUpdateMessage)
      continue
    }
    if (t === 'protocolMessage') {
      const p = inner.protocolMessage
      if (p?.type === 14 && p.editedMessage) applyEdit(raw, p)
      else if (p?.type === 0) applyRevoke(jid, p.key?.id)
      continue
    }
    if (t === 'senderKeyDistributionMessage' || t === 'keepInChatMessage') continue
    const model = toModel(raw)
    if (model) {
      const through = removalPoint.get(model.chatId)
      if (through) {
        if (model.ts > through) removalPoint.delete(model.chatId) // newer activity reopens the chat
        else continue // replayed pre-deletion message — stays deleted
      }
      storeRaw(raw, model); n++
      filed.set(model.chatId, (filed.get(model.chatId) ?? 0) + 1)
    }
  }
  if (!onDemand && (isLatest || syncType === 0 || syncType === 7)) S.historyDone = true
  log(`history sync type=${syncType} latest=${!!isLatest} progress=${progress ?? '-'}: ${chats?.length ?? 0} chats, ${contacts?.length ?? 0} contacts, ${arr.length} messages (${n} stored)`)
  if (onDemand) {
    // exact match when the phone echoes our request session id — the filed
    // chat may differ from the requested jid (e.g. lid canonicalized to pn)
    if (peerDataRequestSessionId != null) {
      const wanted = pendingSid.get(peerDataRequestSessionId)
      if (wanted && !filed.has(wanted) && !chatMore.has(wanted)) {
        filed.set(wanted, 0); chatMore.set(wanted, undefined)
      }
      pendingSid.delete(peerDataRequestSessionId)
    }
    const counts = new Map(filed)
    for (const jid of chatMore.keys()) if (!counts.has(jid)) counts.set(jid, 0)
    answerOlder([...counts.entries()].map(([jid, count]) => [jid, count, chatMore.get(jid)]))
  }
  maybeReady()
  // every chunk (incl. ON_DEMAND fetches) is a reason for the UI to resync
  let total = 0
  for (const b of S.msgs.values()) total += b.size
  emit({ type: 'sync_progress', chats: S.chats.size, contacts: S.contacts.size, messages: total, progress: progress ?? null })
  if (S.historyDone && !syncEndEmitted) { syncEndEmitted = true; emit({ type: 'sync_progress', done: true, chats: S.chats.size, contacts: S.contacts.size, messages: total }) }
  emit({ type: 'history_done' })
  kickMetaQueue()
  void prefetchMedia()
  warmAvatars()
}

// background media warmup — the phone's CDN links are freshest right after
// history replay, so pull the newest media of the most recent chats into the
// disk cache at low pace; the UI's <img> then hits a warm cache instantly.
// Skips: files already cached, media we permanently failed before, and rows
// older than MEDIA_PREFETCH_AGE — CDN links that old are dead anyway
const MEDIA_PREFETCH_AGE = 21 * 24 * 3600 * 1000
let prefetchRunning = false
async function prefetchMedia() {
  if (prefetchRunning) return
  prefetchRunning = true
  try {
    const chats = [...S.chats.values()].sort((a, b) => b.lastActivity - a.lastActivity).slice(0, 40)
    const queue = []
    const cutoff = Date.now() - MEDIA_PREFETCH_AGE
    for (const c of chats) {
      const b = msgsOf(c.id)
      for (const id of [...b.keys()].slice(-25)) {
        const e = b.get(id)
        const k = e?.model?.content?.kind
        if (!e || !['image', 'video', 'sticker', 'document', 'audio'].includes(k)) continue
        if (e.model.ts < cutoff) continue
        const key = c.id + ':' + id
        if (mediaDead.has(key)) continue
        const cache = path.join(MEDIA_DIR, enc(c.id) + '--' + enc(id))
        if (!fs.existsSync(cache)) queue.push([c.id, id])
      }
    }
    if (!queue.length) return
    log(`media prefetch: ${queue.length} files queued`)
    for (const [chatId, id] of queue) {
      if (!S.open) break
      await mediaBuffer(chatId, id).catch(() => {})
      await sleep(250) // gentle — the wire carries live traffic too
    }
  } finally { prefetchRunning = false }
}

function onChatsUpdate(updates) {
  for (const u of updates) {
    const jid = canonicalJid(norm(u.id))
    const chat = chatOf(jid)
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
    learnFromKey(raw.key)
    const jid = canonicalJid(norm(raw.key?.remoteJid))
    if (badJid(jid)) continue
    const inner = extractMessageContent(raw.message)
    const t = inner && getContentType(inner)

    if (t === 'reactionMessage') { applyReaction(raw, inner.reactionMessage); continue }
    if (t === 'pollUpdateMessage') {
      // 7.x decrypts the vote internally and re-emits it via messages.update
      // ({key:creationMsgKey, pollUpdates:[{vote,...}]}) — raw row never renders
      storePollUpdate(raw, inner.pollUpdateMessage)
      continue
    }
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
    const through = removalPoint.get(jid)
    if (through) {
      if (model.ts > through) removalPoint.delete(jid)
      else if (type !== 'notify') continue // old replay — chat stays deleted
    }
    const isNewChat = !S.chats.has(jid)
    if (isNewChat) upsertChat({ id: jid })
    const isNewMsg = !msgsOf(jid).has(model.id)
    storeRaw(raw, model)

    const chat = chatOf(jid)
    if (type === 'notify') {
      if (chat) {
        // re-deliveries after a reconnect must not double-count; a fromMe
        // echo means the phone already read the chat — clear it (ZapFast)
        if (isNewMsg && model.from !== 'me') chat.unread += 1
        if (model.from === 'me') chat.unread = 0
        chat.lastActivity = Math.max(chat.lastActivity, model.ts)
      }
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

// reactions that arrive before their message (ZapFast early_events) wait in
// pendingReactions — history replays reactions before targets, and phone
// reads can precede the message itself
function queueReaction(chatId, targetId, reactor, emoji, ts) {
  const k = chatId + ':' + targetId
  if (!pendingReactions.has(k) && pendingReactions.size >= EARLY_MAX) {
    pendingReactions.delete(pendingReactions.keys().next().value)
  }
  const q = pendingReactions.get(k) ?? []
  const i = q.findIndex((x) => x.by === reactor)
  if (i >= 0) { if (q[i].ts <= ts) q[i] = { by: reactor, emoji, ts } } else q.push({ by: reactor, emoji, ts })
  pendingReactions.set(k, q)
}

function applyReaction(raw, r) {
  const chatId = canonicalJid(norm(raw.key.remoteJid))
  const targetId = r.key?.id
  const entry = msgsOf(chatId).get(targetId)
  const reactor = raw.key.fromMe ? 'me' : canonicalJid(norm(raw.key.participant ?? raw.key.remoteJid))
  if (!entry) { queueReaction(chatId, targetId, reactor, r.text ?? '', Number(raw.messageTimestamp ?? 0)); return }
  const list = (entry.model.reactions ?? []).filter((x) => x.by !== reactor)
  if (r.text) list.push({ emoji: r.text, by: reactor })
  entry.model.reactions = list.length ? list : undefined
  emit({ type: 'message_update', msg: entry.model })
}

// A pollUpdateMessage carries {pollUpdateMessageKey (the CREATION key), vote}.
// From history the vote is still encrypted — decrypt with the poll's own
// messageSecret (same recipe process-message.js uses); from live traffic the
// update arrives pre-decrypted via messages.update.
async function storePollUpdate(raw, p) {
  const chatId = canonicalJid(norm(raw.key.remoteJid))
  const creationKey = p.pollUpdateMessageKey
  const entry = msgsOf(canonicalJid(norm(creationKey?.remoteJid ?? chatId))).get(creationKey?.id)
  if (!entry || entry.model.content.kind !== 'poll') return
  entry.pollUpdates ??= []
  let vote = p.vote
  if (vote?.encPayload && entry.proto.message?.messageContextInfo?.messageSecret) {
    try {
      const meId = ownJid()
      vote = decryptPollVote(vote, {
        pollEncKey: entry.proto.message.messageContextInfo.messageSecret,
        pollCreatorJid: getKeyAuthor(creationKey, meId),
        pollMsgId: creationKey.id,
        voterJid: getKeyAuthor(raw.key, meId),
      })
    } catch { /* undecryptable vote — skip */ return }
  }
  if (!vote) return
  entry.pollUpdates.push({
    pollUpdateMessageKey: raw.key,
    vote,
    senderTimestampMs: p.senderTimestampMs,
  })
  await aggregatePollVotes(entry)
}

async function aggregatePollVotes(entry) {
  try {
    // aggregate over ALL decrypted updates — each replaces a voter's prior
    // selection, never adds to it
    const votes = await getAggregateVotesInPollMessage(
      { message: entry.proto.message, pollUpdates: entry.pollUpdates },
      ownJid(),
    )
    for (const o of entry.model.content.options) o.votes = 0
    for (const v of votes ?? []) {
      const i = entry.model.content.options.findIndex((o) => o.text === v.name)
      if (i >= 0) entry.model.content.options[i].votes = v.voters?.length ?? 0
    }
    emit({ type: 'message_update', msg: entry.model })
  } catch { /* keep last tallies */ }
}

function applyEdit(raw, p) {
  const chatId = canonicalJid(norm(raw.key.remoteJid))
  const entry = msgsOf(chatId).get(p.key?.id)
  if (!entry) return
  const inner = extractMessageContent(p.editedMessage)
  const content = inner && convertContent(chatId, p.key.id, inner)
  if (content) entry.model.content = content
  entry.model.edited = true
  emit({ type: 'message_update', msg: entry.model })
}

function applyRevoke(chatId, id) {
  const entry = msgsOf(canonicalJid(chatId)).get(id)
  if (!entry) return
  entry.model.content = { kind: 'deleted' }
  entry.model.reactions = undefined
  emit({ type: 'message_update', msg: entry.model })
}

function onMessagesUpdate(updates) {
  for (const { key, update } of updates) {
    const chatId = canonicalJid(norm(key.remoteJid))
    if (update?.message?.protocolMessage?.type === 14) { applyEdit({ key }, update.message.protocolMessage); continue }
    if (update?.message?.protocolMessage?.type === 0) { applyRevoke(chatId, update.message.protocolMessage.key?.id); continue }
    if (update?.pollUpdates?.length) {
      // key IS the poll-creation message key; items are already decrypted
      const entry = msgsOf(chatId).get(key.id)
      if (entry?.model.content.kind === 'poll') {
        entry.pollUpdates ??= []
        entry.pollUpdates.push(...update.pollUpdates)
        void aggregatePollVotes(entry)
      }
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
  // payload union: {keys:[]} for delete-for-me, or {jid, all:true} for clear-chat
  if (del.all && del.jid) {
    const chatId = canonicalJid(norm(del.jid))
    S.msgs.delete(chatId)
    const chat = chatOf(chatId)
    if (chat) { chat.lastActivity = lastMsgTs(chatId) }
    emit({ type: 'chat_cleared', chatId })
    if (chat) emit({ type: 'chat_update', chat })
    markDirty()
    return
  }
  // WhatsApp shows "This message was deleted" placeholders — tombstone, not removal
  for (const key of del.keys ?? []) {
    const chatId = canonicalJid(norm(key.remoteJid))
    const entry = msgsOf(chatId).get(key.id)
    if (entry) {
      entry.model.content = { kind: 'deleted' }
      entry.model.reactions = undefined
      emit({ type: 'message_update', msg: entry.model })
    }
  }
}

function onPresence({ id, presences }) {
  const chatId = canonicalJid(norm(id))
  for (const [rawPjid, p] of Object.entries(presences ?? {})) {
    const pjid = canonicalJid(norm(rawPjid))
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
      const c = chatOf(chatId)
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
    await avatarFetch(jid, false).catch(() => {})
  })
  kickMetaQueue()
}
// warm the newest chats' photos — the sidebar paints instantly and the CDN
// links are freshest right after connect/history
function warmAvatars() {
  const chats = [...S.chats.values()].sort((a, b) => b.lastActivity - a.lastActivity).slice(0, 40)
  for (const c of chats) if (c.kind === 'dm' || c.kind === 'group') queueAvatar(c.id)
}
const metaRetry = new Map() // jid -> attempts (ZapFast-style backoff)
function queueGroupMeta(jid, attempt = 0) {
  if (attempt === 0 && S.metaQueued.has(jid)) return
  S.metaQueued.add(jid)
  metaQueue.push(async () => {
    try {
      applyGroupMeta(await S.sock.groupMetadata(jid))
      metaRetry.delete(jid)
      S.metaQueued.delete(jid) // release — a later refetch must be allowed
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
      const chat = chatOf(jid)
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
    await sleep(800) // ZapFast paces metadata at ~2/5s — bursts hit rate limits
  }
  metaRunning = false
}

// ---------- on-demand history (ZapFast fetch_older: anchor at the oldest
// archived message, or at the present with an empty id for empty chats) ----
// The wire field is named ...TimestampMs but the phone reads UNIX SECONDS —
// whatsmeow found it the hard way; multiplying by 1_000 lands in year ~56000
// and the phone silently never answers (ZapFast AGENTS.md warns the same).
// tail=false → anchor at our OLDEST stored message (scroll-back: the phone
// sends messages before it). tail=true → anchor at NOW with an empty id (the
// phone sends the newest `count` messages — closes the gap between our newest
// stored row and the present, which a backward anchor can never reach).
async function requestHistory(chatId, count = 80, explicit = false, tail = false, discovery = false) {
  const jid = canonicalJid(norm(chatId))
  if (!S.open || !jid || !S.sock?.fetchMessageHistory) return false
  if (historyStart.has(jid) && !tail) return false
  if (discovery && Date.now() < discoveryPauseUntil) return false
  const prev = pendingOlder.get(jid)
  if (prev) { if (explicit) prev.explicit = true; return false }
  const bucket = msgsOf(jid)
  const oldest = bucket.size && !tail
    ? [...bucket.values()].reduce((a, b) => (Number(a.proto.messageTimestamp) < Number(b.proto.messageTimestamp) ? a : b))
    : null
  const key = oldest?.proto?.key
    ? { remoteJid: jid, id: oldest.proto.key.id, fromMe: !!oldest.proto.key.fromMe }
    : { remoteJid: jid, id: '', fromMe: false }
  // messageTimestamp is already seconds; empty/tail anchors request at "now"
  const ts = oldest ? Number(oldest.proto.messageTimestamp) : Math.floor(Date.now() / 1000)
  pendingOlder.set(jid, { asked: Date.now(), explicit, discovery })
  try {
    // fetchMessageHistory returns the PDO request session id — the phone
    // echoes it on the ON_DEMAND chunk, so we can match exactly which chat
    // a response belongs to (7.x emits peerDataRequestSessionId)
    const sid = await S.sock.fetchMessageHistory(count, key, ts)
    const pending = pendingOlder.get(jid)
    if (pending && typeof sid === 'string') { pending.sid = sid; pendingSid.set(sid, jid) }
    log(`history request ${jid === chatId ? '' : '(lid→pn) '}sent (${count} msgs, anchor ${key.id || 'present'}${sid ? `, sid ${sid.slice(0, 8)}…` : ''})`)
    return true
  } catch (e) {
    pendingOlder.delete(jid)
    log(`history request failed: ${e?.message}`)
    return false
  }
}

// consecutive unanswered PDO requests = the phone is rate-limiting → pause the
// discovery sweep (a dead sweep burns the whole budget). Any response resets.
let discoveryPauseUntil = 0
let unansweredStreak = 0

// ON_DEMAND chunks resolve pending requests (ZapFast answer_older)
function answerOlder(fileCounts) {
  unansweredStreak = 0
  for (const [jid, n, moreOnPhone] of fileCounts) {
    if (moreOnPhone === 1 || moreOnPhone === 3) historyStart.add(jid) // no more / no access
    const req = pendingOlder.get(jid)
    if (req?.sid) pendingSid.delete(req.sid)
    pendingOlder.delete(jid)
    emit({ type: 'older_result', chatId: jid, count: n, hasMore: n > 0 && moreOnPhone !== 1 && moreOnPhone !== 3 })
  }
}

// unanswered requests expire — explicit (user scroll) retries quietly
setInterval(() => {
  const now = Date.now()
  for (const [jid, req] of pendingOlder) {
    if (now - req.asked < PHONE_PATIENCE) continue
    pendingOlder.delete(jid)
    if (req.sid) pendingSid.delete(req.sid)
    if (req.discovery && ++unansweredStreak >= 4) {
      // phone went silent — the budget is spent; back off the sweep entirely
      discoveryPauseUntil = now + 10 * 60 * 1000
      log(`discovery: ${unansweredStreak} unanswered PDO requests — pausing sweep 10min`)
      unansweredStreak = 0
    }
    emit({ type: 'older_result', chatId: jid, count: 0, hasMore: true })
  }
}, 15000)

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
    const dead = S.sock
    S.sock = null // safe() handler guard: events from the dying socket are dropped
    try { await dead?.logout() } catch (e) { log('logout call failed:', e?.message) }
    // wipe regardless — the user asked to unpair this device
    S.me = null
    S.historyDone = false
    readyEmitted = false
    syncEndEmitted = false
    pendingOlder.clear()
    pendingSid.clear()
    historyStart.clear()
    pendingReactions.clear()
    rawGroupMeta.clear()
    S.subscribedPresence.clear()
    S.typingTimers.clear()
    S.chats.clear(); S.msgs.clear(); S.contacts.clear()
    S.flags.favorite.clear(); S.flags.unread.clear(); S.flags.starred.clear(); saveFlags()
    S.lidToPn.clear(); S.pushNames.clear()
    // kill the dying socket's listeners so a late creds.update can't write
    // into the wiped dir (zombie-session resurrection → Bad MAC flood)
    try { dead?.ev?.removeAllListeners?.() } catch { /* already torn down */ }
    try { dead?.end?.(undefined) } catch { /* already closed */ }
    wipeAuthDirs()
    setTimeout(ensureSocket, 400) // fresh socket → new QR
    return { ok: true }
  },

  async loadOlder({ chatId, beforeTs, limit }) {
    const jid = canonicalJid(norm(chatId))
    const arr = sortedMsgs(jid)
    if (!arr.length) {
      // phone holds the history — ask for it; arrives as ON_DEMAND history.set
      if (historyStart.has(jid)) return { messages: [], hasMore: false }
      void requestHistory(jid, 100, true)
      return { messages: [], hasMore: true }
    }
    const idx = arr.findIndex((m) => m.ts >= beforeTs)
    const end = idx === -1 ? arr.length : idx
    const start = Math.max(0, end - limit)
    const asked = start === 0 && !historyStart.has(jid) && (await requestHistory(jid, 100, true))
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

  async send({ chatId, content, replyTo, clientId }) {
    const jid = norm(chatId)
    const payload = await outPayload(content)
    if (!payload) return
    const opts = {}
    if (clientId) opts.messageId = clientId // echo reconciles the optimistic row
    if (replyTo) {
      const quoted = msgsOf(chatId).get(replyTo.id)?.proto
      if (quoted) opts.quoted = quoted
    }
    let sent
    try {
      sent = await S.sock.sendMessage(jid, payload, opts)
    } catch (e) {
      log('send failed:', e?.message)
      if (clientId) emit({ type: 'delivery', chatId, ids: [clientId], delivery: 'failed' })
      throw e
    }
    if (sent) {
      const model = toModel(sent) ?? baseModel(sent, jid, { kind: 'text', text: '' })
      model.delivery = 'sent'
      storeRaw(sent, model)
      const chat = chatOf(jid)
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
        // only tombstone if WhatsApp accepted the revoke — a failed send must
        // not pretend the message was deleted for everyone
        try {
          await S.sock.sendMessage(norm(chatId), { delete: key })
          const entry = msgsOf(chatId).get(id)
          if (entry) {
            entry.model.content = { kind: 'deleted' }
            entry.model.reactions = undefined
            emit({ type: 'message_update', msg: entry.model })
          }
        } catch (e) { log('revoke failed:', e?.message) }
      } else {
        // delete-for-me: local row removal + server-side deleteForMe so the
        // message doesn't resurrect on the next history replay
        if (key) {
          try {
            await S.sock.chatModify({
              deleteForMe: { deleteMedia: false, key, timestamp: Math.floor(Date.now() / 1000) },
            }, canonicalJid(norm(chatId)))
          } catch { /* local delete still stands */ }
        }
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
    let chat = chatOf(jid)
    if (!chat) {
      chat = upsertChat({ id: jid })
      emit({ type: 'chat_update', chat })
    }
    // live presence for the open chat + pull history if we have none yet
    try { await S.sock?.presenceSubscribe(jid) } catch { /* offline */ }
    if (!msgsOf(jid).size) void requestHistory(jid, 80, false, true)
    return chat
  },

  async markRead({ chatId }) {
    const last = S.lastKey.get(chatId) ?? S.lastKey.get(canonicalJid(norm(chatId)))
    if (last?.key) { try { await S.sock.readMessages([last.key]) } catch { /* receipt best-effort */ } }
    // presence subscribe once per session per direct chat — the UI calls
    // markRead on every open, so this is the reliable hook point
    const jid = canonicalJid(norm(chatId))
    if (!jid.endsWith('@g.us') && !S.subscribedPresence.has(jid)) {
      S.subscribedPresence.add(jid)
      void S.sock?.presenceSubscribe(jid).catch(() => {})
    }
    const chat = chatOf(chatId)
    if (chat) {
      chat.unread = 0
      chat.markedUnread = false
      S.flags.unread.delete(chat.id)
      S.flags.unread.delete(chatId)
      saveFlags()
      emit({ type: 'chat_update', chat })
    }
    // ZapFast: a chat that opened with no local messages asks the phone — and
    // a chat whose newest message is older than a couple hours gets its TAIL
    // refreshed (now-anchor — a backward anchor can never reach the gap)
    if (!msgsOf(jid).size) void requestHistory(jid, 80, true, true)
    else if (Date.now() - (lastMsgTs(jid) || 0) > 2 * 3600 * 1000) void requestHistory(jid, 50, true, true)
  },

  async markUnread({ chatId, value }) {
    const chat = chatOf(chatId)
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
    const chat = chatOf(chatId)
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

  // rich contact profile for the info pane — about, business info, hi-res pic.
  // Also persists `about` onto the contact so the next boot shows it instantly.
  async profile({ jid }) {
    const j = canonicalJid(norm(jid))
    if (!j || !S.sock || !S.open) return { error: 'offline' }
    const [statusR, bizR] = await Promise.allSettled([
      S.sock.fetchStatus(j),
      S.sock.getBusinessProfile ? S.sock.getBusinessProfile(j) : Promise.resolve(null),
    ])
    const stList = statusR.status === 'fulfilled' ? statusR.value : null
    const st = Array.isArray(stList) ? stList.find((x) => norm(x.id) === j || x.id?.includes(j.split('@')[0])) ?? stList[0] : stList
    const about = st?.status?.status ?? (typeof st?.status === 'string' ? st.status : null)
    const bizRaw = bizR.status === 'fulfilled' ? bizR.value : null
    const biz = bizRaw?.wid || bizRaw?.description || bizRaw?.category ? {
      description: bizRaw.description ?? '',
      website: bizRaw.website ?? [],
      email: bizRaw.email ?? null,
      category: bizRaw.category ?? null,
      address: bizRaw.address ?? null,
    } : null
    if (about) {
      upsertContact({ id: j })
      const c = S.contacts.get(j)
      if (c) { c.about = about; markDirty() }
    }
    void avatarFetch(j, true).catch(() => {}) // warm the hi-res while the pane is open
    const payload = { jid: j, about, since: st?.status?.setAt ?? null, biz }
    emit({ type: 'profile', profile: payload })
    return payload
  },

  async leaveGroup({ chatId }) {
    await S.sock.groupLeave(norm(chatId))
    const chat = chatOf(norm(chatId))
    if (chat) { S.chats.delete(norm(chatId)); emit({ type: 'chat_update', chat: { ...chat, kind: 'dm', title: chat.title + ' (left)' } }) }
    return { ok: true }
  },

  async pinMessage({ chatId, messageId, pin }) {
    const key = findKey(chatId, messageId)
    if (!key) return { error: 'not found' }
    try {
      await S.sock.sendMessage(norm(chatId), { pin: key, type: pin ? 1 : 2, time: 604800 })
      const chat = chatOf(norm(chatId))
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
// mediaDead marks messages whose download is permanently exhausted (dead CDN +
// declined/failed phone re-upload). Retrying costs a 45s reupload wait — a
// fresh proto arriving via history replay clears the mark (new signed URLs)
const mediaDead = new Set()

async function mediaBuffer(chatId, messageId) {
  const entry = msgsOf(chatId).get(messageId)
  if (!entry) return null
  const deadKey = chatId + ':' + messageId
  if (mediaDead.has(deadKey)) return 'gone'
  const cache = path.join(MEDIA_DIR, enc(chatId) + '--' + enc(messageId))
  try {
    if (fs.existsSync(cache)) return fs.readFileSync(cache)
  } catch { /* fall through */ }
  try {
    // 45s cap: the reupload wait inside downloadMediaMessage has no timeout —
    // a phone that never answers would hang this request forever
    const buf = await Promise.race([
      downloadMediaMessage(entry.proto, 'buffer', {}, {
        logger,
        reuploadRequest: (m) => S.sock.updateMediaMessage(m),
      }),
      sleep(45_000).then(() => { throw new Error('media download timed out') }),
    ])
    fs.writeFileSync(cache, buf)
    return buf
  } catch (e) {
    const msg = e?.message ?? ''
    // 'No valid media URL' = view-once consumed elsewhere / media genuinely
    // gone — 410 Gone so the UI can render 'unavailable' instead of retrying
    if (/No valid media URL/i.test(msg)) { log('media gone (view-once/redacted):', messageId); mediaDead.add(deadKey); return 'gone' }
    log('media download failed:', msg)
    mediaDead.add(deadKey)
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

// ---------- avatar pipeline ----------
// Three tiers, disk-backed so a daemon restart doesn't re-hammer WhatsApp's
// profile-pic endpoint (it rate-limits hard — that was the blank-avatar bug):
//   mem (hot) → disk (AVATAR_DIR, 24h) → profilePictureUrl → CDN fetch
// Misses are negative-cached 6h so privacy-blocked jids don't get pounded.
const AVATAR_DIR = path.join(DATA, 'avatars')
const AVATAR_INDEX = path.join(AVATAR_DIR, 'index.json')
fs.mkdirSync(AVATAR_DIR, { recursive: true })
const avatarCache = new Map() // jid -> {buf, mime, at}
const avatarIdx = new Map() // jid -> {f, mime, hi, at}
const avatarMiss = new Map() // jid -> ts (negative cache, session-only)
const avatarInflight = new Map() // jid|big -> Promise<entry|null>
let avatarIdxDirty = false
try {
  const raw = JSON.parse(fs.readFileSync(AVATAR_INDEX, 'utf8'))
  for (const [j, e] of Object.entries(raw)) if (e?.f && fs.existsSync(path.join(AVATAR_DIR, e.f))) avatarIdx.set(j, e)
} catch { /* first boot or wiped dir */ }
const avatarIdxSave = () => {
  if (!avatarIdxDirty) return
  avatarIdxDirty = false
  try {
    const tmp = AVATAR_INDEX + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(avatarIdx)))
    fs.renameSync(tmp, AVATAR_INDEX)
  } catch { /* best effort */ }
}
setInterval(avatarIdxSave, 15000).unref()
const avatarFile = (jid) => crypto.createHash('sha1').update(jid).digest('hex').slice(0, 20)
const AV_MISS_TTL = 6 * 3600 * 1000
const AV_DISK_TTL = 24 * 3600 * 1000

function avatarFromDisk(entry) {
  try {
    const buf = fs.readFileSync(path.join(AVATAR_DIR, entry.f))
    avatarCache.set(entry._jid, { buf, mime: entry.mime, at: entry.at })
    return { buf, mime: entry.mime, at: entry.at }
  } catch { avatarIdx.delete(entry._jid); avatarIdxDirty = true; return null }
}

async function avatarFetch(jid, big) {
  const key = jid + (big ? '|big' : '')
  let p = avatarInflight.get(key)
  if (p) return p
  p = (async () => {
    const mem = avatarCache.get(jid)
    if (mem && (!big || avatarIdx.get(jid)?.hi) && Date.now() - mem.at < 300_000) return mem
    const disk = avatarIdx.get(jid)
    if (disk && Date.now() - disk.at < AV_DISK_TTL && (!big || disk.hi)) {
      const hit = avatarFromDisk({ ...disk, _jid: jid })
      if (hit) return hit
    }
    // negative cache: no-picture jids only get re-asked every 6h
    if ((avatarMiss.get(jid) ?? 0) > Date.now() - AV_MISS_TTL) {
      return disk ? avatarFromDisk({ ...disk, _jid: jid }) : null
    }
    try {
      const url = await S.sock?.profilePictureUrl(jid, big ? 'image' : 'preview')
      if (!url) throw new Error('no picture')
      const r = await fetch(url)
      if (!r.ok) throw new Error('cdn ' + r.status)
      const buf = Buffer.from(await r.arrayBuffer())
      const entry = { buf, mime: r.headers.get('content-type') ?? 'image/jpeg', at: Date.now() }
      avatarCache.set(jid, entry)
      // a hi-res fetch upgrades the stored copy; a preview fetch only fills a void
      const prev = avatarIdx.get(jid)
      if (big || !prev?.hi) {
        const f = avatarFile(jid)
        try { fs.writeFileSync(path.join(AVATAR_DIR, f), buf) } catch { /* disk full? */ }
        avatarIdx.set(jid, { f, mime: entry.mime, hi: big || !!prev?.hi, at: entry.at })
        avatarIdxDirty = true
      }
      avatarMiss.delete(jid)
      return entry
    } catch {
      avatarMiss.set(jid, Date.now())
      return disk ? avatarFromDisk({ ...disk, _jid: jid }) : null // stale beats nothing
    } finally { avatarInflight.delete(key) }
  })()
  avatarInflight.set(key, p)
  return p
}

const mediaServer = http.createServer(async (req, res) => {
  if (!DEV && /[?&]token=([^&]+)/.exec(req.url ?? '')?.[1] !== TOKEN) { res.writeHead(403).end(); return }
  const av = /^\/a\/([^/?]+)/.exec(req.url ?? '')
  if (av) {
    const jid = decodeURIComponent(av[1])
    const hit = await avatarFetch(jid, /[?&]big=1/.test(req.url ?? ''))
    if (!hit) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': hit.mime, 'cache-control': 'private, max-age=300' })
    res.end(hit.buf)
    return
  }
  const m = /^\/m\/([^/]+)\/([^/?]+)/.exec(req.url ?? '')
  if (!m) { res.writeHead(404).end(); return }
  const [, chatId, msgId] = m.map(decodeURIComponent)
  const buf = await mediaBuffer(chatId, msgId)
  if (buf === 'gone') { res.writeHead(410).end(); return }
  if (!buf) { res.writeHead(404).end(); return }
  const mime = mediaMime(chatId, msgId)
  // Range support: <audio>/<video> need it for duration probing + seeking;
  // without it Chrome may refuse ogg/opus playback entirely
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? parseInt(range[1]) : Math.max(0, buf.length - parseInt(range[2]))
    const end = range[2] ? Math.min(buf.length - 1, parseInt(range[2])) : buf.length - 1
    if (start >= buf.length || end < start) {
      res.writeHead(416, { 'content-range': `bytes */${buf.length}` }).end()
      return
    }
    res.writeHead(206, {
      'content-type': mime, 'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${buf.length}`,
      'content-length': end - start + 1,
      'cache-control': 'private, max-age=86400',
    })
    res.end(buf.subarray(start, end + 1))
    return
  }
  res.writeHead(200, { 'content-type': mime, 'accept-ranges': 'bytes', 'content-length': buf.length, 'cache-control': 'private, max-age=86400' })
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
