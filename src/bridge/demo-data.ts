import type { Chat, Contact, Id, Message, MsgContent } from './types'
import { DAY, rng } from '../lib/util'

// Deterministic demo dataset. Photos from picsum (seeded, stable).

export const ME = 'me'

export const contacts: Contact[] = [
  { id: 'c-mara', name: 'Mara Vidal', firstName: 'Mara', about: 'diseñando cosas ✨', phone: '+34 612 44 90 17', avatarHue: 214 },
  { id: 'c-tomas', name: 'Tomás Eterovic', firstName: 'Tomás', phone: '+34 677 18 02 55', avatarHue: 152 },
  { id: 'c-ines', name: 'Inés Caetano', firstName: 'Inés', about: 'Lisboa 📍', phone: '+351 91 440 23 88', avatarHue: 288 },
  { id: 'c-ravi', name: 'Ravi Nair', firstName: 'Ravi', phone: '+44 7401 229 384', avatarHue: 24 },
  { id: 'c-jo', name: 'Joaquín Reyes', firstName: 'Joaquín', about: 'solo audio', phone: '+56 9 7713 4020', avatarHue: 348 },
  { id: 'c-paula', name: 'Paula Ferrer', firstName: 'Paula', phone: '+34 655 30 71 12', avatarHue: 190 },
  { id: 'c-dani', name: 'Daniela Okafor', firstName: 'Daniela', about: 'Product @ Nortia', phone: '+234 803 555 0197', avatarHue: 96, verified: true },
  { id: 'c-santi', name: 'Santiago Paz', firstName: 'Santi', phone: '+54 9 11 5555 2144', avatarHue: 262 },
  { id: 'c-lena', name: 'Lena Vogt', firstName: 'Lena', phone: '+49 151 2342 8810', avatarHue: 330 },
  { id: 'c-marco', name: 'Marco Ancona', firstName: 'Marco', phone: '+39 333 118 4402', avatarHue: 12 },
  { id: 'c-abi', name: 'Abi Whitfield', firstName: 'Abi', phone: '+44 7911 123 456', avatarHue: 174 },
  { id: 'c-nico', name: 'Nicolás Prats', firstName: 'Nico', phone: '+34 600 12 88 03', avatarHue: 46 },
]

export const chats: Chat[] = [
  { id: 'saved', kind: 'saved', title: 'You', avatarHue: 210, participants: [], pinned: false, muted: false, archived: false, favorite: false, unread: 0, markedUnread: false, lastActivity: Date.now() - 2 * 3600000 },
  { id: 'ch-mara', kind: 'dm', title: 'Mara Vidal', avatarHue: 214, participants: ['c-mara'], contactId: 'c-mara', pinned: true, muted: false, archived: false, favorite: true, unread: 2, markedUnread: false, lastActivity: Date.now() - 4 * 60000 },
  { id: 'ch-brunch', kind: 'group', title: 'Brunch del sábado 🥐', avatarHue: 30, participants: ['c-ines', 'c-tomas', 'c-paula', 'c-jo', 'c-nico'], pinned: true, muted: false, archived: false, favorite: false, unread: 9, markedUnread: false, lastActivity: Date.now() - 14 * 60000 },
  { id: 'ch-ravi', kind: 'dm', title: 'Ravi Nair', avatarHue: 24, participants: ['c-ravi'], contactId: 'c-ravi', pinned: false, muted: false, archived: false, favorite: true, unread: 0, markedUnread: true, lastActivity: Date.now() - 52 * 60000 },
  { id: 'ch-nortia', kind: 'group', title: 'Nortia — product', avatarHue: 210, participants: ['c-dani', 'c-ravi', 'c-abi', 'c-lena'], pinned: false, muted: true, archived: false, favorite: false, unread: 31, markedUnread: false, lastActivity: Date.now() - 68 * 60000 },
  { id: 'ch-jo', kind: 'dm', title: 'Joaquín Reyes', avatarHue: 348, participants: ['c-jo'], contactId: 'c-jo', pinned: false, muted: false, archived: false, favorite: false, unread: 1, markedUnread: false, lastActivity: Date.now() - 3 * 3600000 },
  { id: 'ch-ines', kind: 'dm', title: 'Inés Caetano', avatarHue: 288, participants: ['c-ines'], contactId: 'c-ines', pinned: false, muted: false, archived: false, favorite: false, unread: 0, markedUnread: false, lastActivity: Date.now() - 5 * 3600000 },
  { id: 'ch-fam', kind: 'group', title: 'Familia', avatarHue: 140, participants: ['c-paula', 'c-santi', 'c-marco'], pinned: false, muted: false, archived: false, favorite: false, unread: 4, markedUnread: false, lastActivity: Date.now() - 9 * 3600000 },
  { id: 'ch-lena', kind: 'dm', title: 'Lena Vogt', avatarHue: 330, participants: ['c-lena'], contactId: 'c-lena', pinned: false, muted: false, archived: false, favorite: false, unread: 0, markedUnread: false, lastActivity: Date.now() - DAY - 2 * 3600000 },
  { id: 'ch-tenis', kind: 'group', title: 'Tenis jueves 🎾', avatarHue: 100, participants: ['c-nico', 'c-tomas', 'c-marco', 'c-santi'], pinned: false, muted: true, archived: false, favorite: false, unread: 0, markedUnread: false, lastActivity: Date.now() - DAY - 5 * 3600000 },
  { id: 'ch-dani', kind: 'dm', title: 'Daniela Okafor', avatarHue: 96, participants: ['c-dani'], contactId: 'c-dani', pinned: false, muted: false, archived: false, favorite: false, unread: 0, markedUnread: false, lastActivity: Date.now() - 2 * DAY - 3600000 },
  { id: 'ch-canal', kind: 'channel', title: 'notas de diseño', avatarHue: 258, participants: [], pinned: false, muted: true, archived: false, favorite: false, unread: 12, markedUnread: false, lastActivity: Date.now() - 26 * 60000 },
  { id: 'ch-tomas', kind: 'dm', title: 'Tomás Eterovic', avatarHue: 152, participants: ['c-tomas'], contactId: 'c-tomas', pinned: false, muted: false, archived: true, favorite: false, unread: 0, markedUnread: false, lastActivity: Date.now() - 4 * DAY },
  { id: 'ch-abi', kind: 'dm', title: 'Abi Whitfield', avatarHue: 174, participants: ['c-abi'], contactId: 'c-abi', pinned: false, muted: false, archived: true, favorite: false, unread: 0, markedUnread: false, lastActivity: Date.now() - 6 * DAY },
  { id: 'ch-marco', kind: 'dm', title: 'Marco Ancona', avatarHue: 12, participants: ['c-marco'], contactId: 'c-marco', pinned: false, muted: false, archived: false, favorite: false, unread: 0, markedUnread: false, lastActivity: Date.now() - 8 * DAY },
]

const T = (text: string): MsgContent => ({ kind: 'text', text })
const IMG = (seed: string, w: number, h: number, caption?: string): MsgContent => ({
  kind: 'image', url: `https://picsum.photos/seed/${seed}/${w * 2}/${h * 2}`, w, h, caption,
})

const byId: Record<Id, { id: Id | 'me'; name?: string }> = {}
for (const c of contacts) byId[c.id] = { id: c.id, name: c.firstName }

function mk(chatId: Id, i: number, ts: number, from: Id | 'me', content: MsgContent, extra?: Partial<Message>): Message {
  const c = contacts.find((x) => x.id === from)
  return {
    id: `${chatId}-${i.toString(36)}`, chatId, from,
    fromName: c?.firstName,
    ts, content,
    delivery: from === 'me' ? 'read' : undefined,
    ...extra,
  }
}

interface Seed { chatId: Id; n: number; seed: number; build: (mkfn: typeof mk, i: number, base: number) => Message | null }

const S = (chatId: Id, seed: number, n: number, build: Seed['build']): Seed => ({ chatId, seed, n, build })

// Message scripts per chat. Older messages are generated procedurally.
const seeds: Seed[] = [
  S('ch-mara', 11, 64, (mk, i, base) => {
    const script: Message[] = [
      mk('ch-mara', 1, base - 3 * DAY - 7 * 3600000, 'c-mara', T('conseguí las entradas!! 🎉')),
      mk('ch-mara', 2, base - 3 * DAY - 7 * 3600000 + 40000, ME, T('no puede ser, ¿las del sábado?')),
      mk('ch-mara', 3, base - 3 * DAY - 7 * 3600000 + 90000, 'c-mara', T('sí, fila 12. te paso el link')),
      mk('ch-mara', 4, base - 3 * DAY - 7 * 3600000 + 150000, 'c-mara', T('https://example.com/tickets/sab12'), { delivery: undefined }),
      mk('ch-mara', 5, base - 2 * DAY - 5 * 3600000, 'c-mara', IMG('mara-studio', 640, 480, 'así quedó el mockup')),
      mk('ch-mara', 6, base - 2 * DAY - 5 * 3600000 + 60000, ME, T('está *muy* bien. el tracking del título un toque más cerrado')),
      mk('ch-mara', 7, base - 2 * DAY - 5 * 3600000 + 200000, 'c-mara', T('sí, -0.02em. y bajo el leading a 1.05')),
      mk('ch-mara', 8, base - DAY - 4 * 3600000, ME, IMG('me-desk', 640, 420, 'mi setup quedó así')),
      mk('ch-mara', 9, base - DAY - 4 * 3600000 + 120000, 'c-mara', T('el brazo del monitor 👌',)),
      mk('ch-mara', 10, base - 46 * 60000, 'c-mara', T('¿comemos algo antes del show?'), { delivery: undefined }),
      mk('ch-mara', 11, base - 44 * 60000, 'c-mara', { kind: 'audio', duration: 14, waveform: [3,6,9,12,8,14,16,11,7,10,15,13,9,6,4,8,12,9,5,3], voice: true }),
      mk('ch-mara', 12, base - 38 * 60000, ME, T('dale, reservá en ese lugar italiano')),
      mk('ch-mara', 13, base - 12 * 60000, 'c-mara', T('listo, 19:30. no llegues tarde 😤')),
      mk('ch-mara', 14, base - 4 * 60000, 'c-mara', T('ah y traé la cámara'), { delivery: undefined }),
    ]
    const m = script.find((s) => s.id === `ch-mara-${i}`)
    if (m) return m
    // generated history
    const r = rng(i * 977 + base)
    const who = r() > 0.5 ? ME : 'c-mara'
    const samples = [
      'jajaja sí, tal cual', 'después te mando el archivo', '¿viste lo que subió Dani?',
      'ok perfecto', 'mañana te cuento bien', 'eso mismo pensé yo',
      '*claro* que sí', 'me parece que el jueves no puedo', 'buenísimo 🔥',
      'te llamo en 10?', 'sí, confirmado', 'mira esto: `prefers-reduced-transparency`',
    ]
    return mk('ch-mara', i, base - 3 * DAY - (80 - i) * 3.2 * 3600000, who, T(samples[Math.floor(r() * samples.length)]))
  }),

  S('ch-brunch', 23, 90, (mk, i, base) => {
    const script: Message[] = [
      mk('ch-brunch', 1, base - 2 * 3600000, 'c-ines', T('gente, confirmen para el sábado')),
      mk('ch-brunch', 2, base - 2 * 3600000 + 90000, 'c-tomas', T('yo voy 🙋‍♂️')),
      mk('ch-brunch', 3, base - 2 * 3600000 + 240000, 'c-paula', T('yo también, ¿a qué hora?')),
      mk('ch-brunch', 4, base - 110 * 60000, 'c-ines', { kind: 'poll', question: '¿Dónde hacemos brunch?', options: [{ text: 'Federal Café', votes: 3 }, { text: 'La Bicicleta', votes: 2 }, { text: 'En casa de Inés', votes: 1 }], multi: false }),
      mk('ch-brunch', 5, base - 95 * 60000, 'c-nico', IMG('brunch-table', 640, 480)),
      mk('ch-brunch', 6, base - 90 * 60000, 'c-nico', T('así quedó la última vez, para motivarlos')),
      mk('ch-brunch', 7, base - 60 * 60000, 'c-jo', T('llevo yo las mimosas')),
      mk('ch-brunch', 8, base - 40 * 60000, 'c-paula', T('@Nicolás esas tostadas se ven increíbles'), { replyTo: { id: 'ch-brunch-5', from: 'c-nico', fromName: 'Nico', preview: '📷 Photo', kind: 'image' } }),
      mk('ch-brunch', 9, base - 30 * 60000, 'c-tomas', T('Federal ganando por paliza')),
      mk('ch-brunch', 10, base - 20 * 60000, 'c-ines', T('voten que cierro la reserva hoy')),
      mk('ch-brunch', 11, base - 14 * 60000, 'c-jo', T('ya voté 🗳️')),
      mk('ch-brunch', 12, base - 14 * 60000 + 30000, 'c-paula', T('yo también')),
    ]
    const m = script.find((s) => s.id === `ch-brunch-${i}`)
    if (m) {
      if (i === 8) m.reactions = [{ emoji: '❤️', by: 'c-ines' }, { emoji: '❤️', by: 'c-tomas' }, { emoji: '🙌', by: 'c-jo' }]
      if (i === 5) m.reactions = [{ emoji: '😋', by: 'c-paula' }, { emoji: '😋', by: 'c-tomas' }]
      return m
    }
    const r = rng(i * 613 + base)
    const who = ['c-ines', 'c-tomas', 'c-paula', 'c-jo', 'c-nico', ME][Math.floor(r() * 6)]
    const samples = [
      'jajaja', 'buen plan', 'yo me apunto', '¿y si llueve?', 'confirmado entonces',
      'qué rico se veía todo', 'puedo llevar café de especialidad', 'no puedo creer que es octubre ya',
      'alguien que traiga altavoz', 'después del brunch ¿paseo?', 'de una 💪', 'perfecto 👌',
    ]
    return mk('ch-brunch', i, base - 2 * DAY - (90 - i) * 2.6 * 3600000, who, T(samples[Math.floor(r() * samples.length)]))
  }),

  S('ch-ravi', 7, 40, (mk, i, base) => {
    const script: Message[] = [
      mk('ch-ravi', 1, base - 3 * 3600000, 'c-ravi', T('the build is green again ✅')),
      mk('ch-ravi', 2, base - 3 * 3600000 + 60000, ME, T('finally. what was it?')),
      mk('ch-ravi', 3, base - 3 * 3600000 + 120000, 'c-ravi', T('flaky test in the sync worker. `poll_history` was racing the snapshot')),
      mk('ch-ravi', 4, base - 3 * 3600000 + 200000, 'c-ravi', T('moved it behind the merge barrier, all good')),
      mk('ch-ravi', 5, base - 70 * 60000, ME, T('nice catch. want me to tag the release?')),
      mk('ch-ravi', 6, base - 52 * 60000, 'c-ravi', { kind: 'document', name: 'release-notes-0.19.md', size: 18432, mime: 'text/markdown', pages: 3 }),
      mk('ch-ravi', 7, base - 52 * 60000 + 45000, 'c-ravi', T('go ahead, notes are in there')),
    ]
    const m = script.find((s) => s.id === `ch-ravi-${i}`)
    if (m) return m
    const r = rng(i * 331 + base)
    const who = r() > 0.45 ? 'c-ravi' : ME
    const samples = [
      'ship it', 'lgtm', 'checking now', 'the metrics look way better',
      'memory is flat under load', 'can you repro on windows?', 'yes, 100% reproducible',
      'merged. closing the ticket', 'nice', 'one sec, on a call',
    ]
    return mk('ch-ravi', i, base - 2 * DAY - (40 - i) * 4.1 * 3600000, who, T(samples[Math.floor(r() * samples.length)]))
  }),

  S('ch-nortia', 17, 70, (mk, i, base) => {
    const script: Message[] = [
      mk('ch-nortia', 1, base - 90 * 60000, 'c-dani', T('team — roadmap review moved to 11:00 tomorrow')),
      mk('ch-nortia', 2, base - 85 * 60000, 'c-abi', T('works for me')),
      mk('ch-nortia', 3, base - 80 * 60000, 'c-ravi', T('can we get the latency numbers before?'), { replyTo: { id: 'ch-nortia-1', from: 'c-dani', fromName: 'Daniela', preview: 'team — roadmap review moved to 11:00 tomorrow', kind: 'text' } }),
      mk('ch-nortia', 4, base - 75 * 60000, 'c-dani', T('on it, dashboard is live')),
      mk('ch-nortia', 5, base - 70 * 60000, 'c-lena', IMG('nortia-dash', 640, 400, 'p95 dropped again')),
      mk('ch-nortia', 6, base - 68 * 60000, 'c-lena', T('183ms across the board')),
    ]
    const m = script.find((s) => s.id === `ch-nortia-${i}`)
    if (m) {
      if (i === 6) m.reactions = [{ emoji: '🎉', by: 'c-dani' }, { emoji: '🚀', by: 'c-ravi' }, { emoji: '🎉', by: 'c-abi' }]
      return m
    }
    const r = rng(i * 421 + base)
    const who = ['c-dani', 'c-ravi', 'c-abi', 'c-lena', ME][Math.floor(r() * 5)]
    const samples = [
      'noted', 'will check', 'can someone pick this up?', 'the staging deploy is out',
      'nice work', 'blocked on design review', 'on my list for today', '+1',
      'lets discuss in the call', 'pushed a fix', 'metrics look clean', 'shipping tomorrow',
    ]
    return mk('ch-nortia', i, base - 4 * DAY - (70 - i) * 2.9 * 3600000, who, T(samples[Math.floor(r() * samples.length)]))
  }),

  S('ch-jo', 5, 30, (mk, i, base) => {
    if (i === 30) return mk('ch-jo', i, base - 3 * 3600000, 'c-jo', { kind: 'audio', duration: 47, waveform: [2,5,8,12,15,11,16,18,13,9,14,17,19,15,11,8,12,16,10,7,9,13,17,14,10,6,8,11,9,5,4,7,10,12,8,6,3,5], voice: true })
    if (i === 29) return mk('ch-jo', i, base - 3 * 3600000 - 30000, 'c-jo', T('te dejo un audio que es más fácil'))
    const r = rng(i * 199 + base)
    const who = r() > 0.5 ? 'c-jo' : ME
    const samples = ['dale', 'jajaja qué hdp', 'nos vemos el finde?', 'el sábado imposible, ¿domingo?', 'de una', 'cuando quieras', 'avísame 👍']
    return mk('ch-jo', i, base - 3 * DAY - (30 - i) * 5.3 * 3600000, who, T(samples[Math.floor(r() * samples.length)]))
  }),

  S('ch-ines', 9, 44, (mk, i, base) => {
    const script: Message[] = [
      mk('ch-ines', 1, base - 6 * 3600000, 'c-ines', IMG('ines-lisboa', 640, 640, 'Lisboa está preciosa hoy')),
      mk('ch-ines', 2, base - 6 * 3600000 + 120000, ME, T('qué envidia. la luz ahí es otra cosa')),
      mk('ch-ines', 3, base - 6 * 3600000 + 300000, 'c-ines', T('vente un finde, hay vuelos baratos')),
      mk('ch-ines', 4, base - 5.2 * 3600000, ME, T('🤔')),
      mk('ch-ines', 5, base - 5 * 3600000, 'c-ines', T('te lo tomaré como un sí')),
    ]
    const m = script.find((s) => s.id === `ch-ines-${i}`)
    if (m) {
      if (i === 4) m.reactions = [{ emoji: '😂', by: 'c-ines' }]
      return m
    }
    const r = rng(i * 277 + base)
    const who = r() > 0.5 ? 'c-ines' : ME
    const samples = ['jajaja', 'saudade', 'el pastel de nata de ayer 🤤', 'mañana subo las fotos', '¿te llegó la postal?', 'sí! gracias']
    return mk('ch-ines', i, base - 3 * DAY - (44 - i) * 3.7 * 3600000, who, T(samples[Math.floor(r() * samples.length)]))
  }),

  S('ch-fam', 13, 55, (mk, i, base) => {
    const script: Message[] = [
      mk('ch-fam', 1, base - 10 * 3600000, 'c-paula', T('mamá pregunta quién trae el postre el domingo')),
      mk('ch-fam', 2, base - 9.8 * 3600000, 'c-santi', T('yo hago el tiramisú')),
      mk('ch-fam', 3, base - 9.5 * 3600000, 'c-marco', T('yo traigo vino 🍷')),
      mk('ch-fam', 4, base - 9.4 * 3600000, ME, T('listo entonces. yo llevo el pan')),
      mk('ch-fam', 5, base - 9.2 * 3600000, 'c-paula', { kind: 'sticker', emoji: '🥳' }),
    ]
    const m = script.find((s) => s.id === `ch-fam-${i}`)
    if (m) {
      if (i === 2) m.reactions = [{ emoji: '😋', by: 'c-paula' }, { emoji: '👏', by: 'c-marco' }]
      return m
    }
    const r = rng(i * 359 + base)
    const who = ['c-paula', 'c-santi', 'c-marco', ME][Math.floor(r() * 4)]
    const samples = ['jajaja', 'ok', 'el domingo a las 13:00', 'confirmen los que van', 'yo llego tipo 12:30', 'perfecto', '❤️', 'qué lindo va a estar']
    return mk('ch-fam', i, base - 5 * DAY - (55 - i) * 2.2 * 3600000, who, T(samples[Math.floor(r() * samples.length)]))
  }),

  S('ch-lena', 19, 36, (mk, i, base) => {
    if (i === 36) return mk('ch-lena', i, base - DAY - 2 * 3600000, 'c-lena', { kind: 'video', url: '', w: 640, h: 360, duration: 12, caption: 'from the workshop today', poster: 'https://picsum.photos/seed/lena-ws/1280/720' })
    if (i === 35) return mk('ch-lena', i, base - DAY - 2.2 * 3600000, 'c-lena', T('quick vid'))
    const r = rng(i * 173 + base)
    const who = r() > 0.5 ? 'c-lena' : ME
    const samples = ['alles gut hier', 'the print proofs arrived', 'kannst du das prüfen?', 'looking great so far', 'yes, ship it', 'bis morgen!']
    return mk('ch-lena', i, base - 4 * DAY - (36 - i) * 4.4 * 3600000, who, T(samples[Math.floor(r() * samples.length)]))
  }),

  S('ch-tenis', 29, 48, (mk, i, base) => {
    if (i === 48) return mk('ch-tenis', i, base - DAY - 5 * 3600000, 'c-nico', T('jueves 19:00 cancha 3, reservada'))
    const r = rng(i * 149 + base)
    const who = ['c-nico', 'c-tomas', 'c-marco', 'c-santi', ME][Math.floor(r() * 5)]
    const samples = ['voy', 'llego 18:45', 'llevo pelotas nuevas', '¿dobles o singles?', 'dobles obvio', 'alguien confirme a Marco', 'jj qué partido el otro día']
    return mk('ch-tenis', i, base - 7 * DAY - (48 - i) * 3.1 * 3600000, who, T(samples[Math.floor(r() * samples.length)]))
  }),

  S('ch-dani', 31, 25, (mk, i, base) => {
    const script: Message[] = [
      mk('ch-dani', 1, base - 2 * DAY - 2 * 3600000, 'c-dani', T('the board loved the direction')),
      mk('ch-dani', 2, base - 2 * DAY - 2 * 3600000 + 240000, 'c-dani', T('we greenlight phase 2 🚀')),
      mk('ch-dani', 3, base - 2 * DAY - 1.8 * 3600000, ME, T('huge. congrats Dani')),
      mk('ch-dani', 4, base - 2 * DAY - 1 * 3600000, 'c-dani', T('could not have done it without the team')),
    ]
    const m = script.find((s) => s.id === `ch-dani-${i}`)
    if (m) return m
    const r = rng(i * 211 + base)
    const who = r() > 0.5 ? 'c-dani' : ME
    const samples = ['yes!', 'on it', 'review sent', 'the deck is ready', 'thanks!', 'lets sync tomorrow']
    return mk('ch-dani', i, base - 6 * DAY - (25 - i) * 5.1 * 3600000, who, T(samples[Math.floor(r() * samples.length)]))
  }),

  S('ch-canal', 37, 20, (mk, i, base) => {
    const posts: MsgContent[] = [
      T('Interfaces feel alive when motion starts from the current on-screen value.'),
      T('Response is the foundation: respond on pointer-down, never on release.'),
      T('A spring you cannot interrupt is not a spring.'),
      IMG('canal-post1', 640, 400),
      T('Materials encode hierarchy. Heavier blur separates; lighter invites touch.'),
      T('Track velocity, not just position. The release matters more than the drag.'),
      T('Reduced motion is not no motion. It is a gentler equivalent.'),
      IMG('canal-post2', 640, 480),
      T('Type at large sizes wants negative tracking. Small text wants room.'),
      T('The seam between drag and animation is where interfaces die.'),
    ]
    const c = posts[(i - 1) % posts.length]
    return mk('ch-canal', i, base - 12 * 3600000 - (20 - i) * 7 * 3600000, 'c-dani', c, { fromName: 'notas de diseño' })
  }),

  S('ch-tomas', 41, 20, (mk, i, base) => {
    const r = rng(i * 83 + base)
    const who = r() > 0.5 ? 'c-tomas' : ME
    const samples = ['sale bici el domingo?', 'cuenta conmigo', 'llevo la GoPro', 'a las 8 en el puente?', 'confirmado']
    return mk('ch-tomas', i, base - 4 * DAY - (20 - i) * 4 * 3600000, who, T(samples[Math.floor(r() * samples.length)]))
  }),

  S('ch-abi', 43, 16, (mk, i, base) => {
    const r = rng(i * 89 + base)
    const who = r() > 0.5 ? 'c-abi' : ME
    const samples = ['thanks for the intro!', 'happy to help', 'lets keep in touch', 'definitely']
    return mk('ch-abi', i, base - 6 * DAY - (16 - i) * 6 * 3600000, who, T(samples[Math.floor(r() * samples.length)]))
  }),

  S('ch-marco', 47, 22, (mk, i, base) => {
    const r = rng(i * 67 + base)
    const who = r() > 0.5 ? 'c-marco' : ME
    const samples = ['ciao!', 'come va?', 'tutto bene, tu?', 'a cena da me venerdì', 'porto io il dolce']
    return mk('ch-marco', i, base - 8 * DAY - (22 - i) * 4.7 * 3600000, who, T(samples[Math.floor(r() * samples.length)]))
  }),

  S('saved', 53, 14, (mk, i, base) => {
    const notes: MsgContent[] = [
      T('wi-fi: QuappGuest / bolt-4421'), T('https://developer.apple.com/design/human-interface-guidelines/materials'),
      T('comprar: pilas AA, café, tomillo'), T('idea: atajo Cmd+Shift+P para pausar sync'),
      { kind: 'image', url: 'https://picsum.photos/seed/saved-ref/1280/960', w: 640, h: 480, caption: 'referencia para el bento' },
      T('cumpleaños Inés: 14 oct'), T('pedir devolución paquete Nortia'), T('`git worktree add ../x branch`'),
    ]
    return mk('saved', i, base - 2 * DAY - (14 - i) * 6.3 * 3600000, ME, notes[(i - 1) % notes.length])
  }),
]

export function initialMessages(): Record<Id, Message[]> {
  const out: Record<Id, Message[]> = {}
  for (const s of seeds) {
    const base = Date.now()
    const msgs: Message[] = []
    for (let i = 1; i <= s.n; i++) {
      const m = s.build(mk, i, base)
      if (m) msgs.push(m)
    }
    msgs.sort((a, b) => a.ts - b.ts)
    out[s.chatId] = msgs
  }
  return out
}

// pool of replies for the simulator
export const replyPool = [
  'jajaja totalmente', 'ok, anotado', '¿en serio?', 'dale, me parece bien',
  'después lo vemos con calma', 'buenísimo 🔥', 'no te entendí, ¿me explicas?',
  'sí, eso mismo', 'mañana te confirmo', 'cuéntame más', '👍', 'ajá',
  'perfecto, quedo atento', 'hmm déjame pensarlo', 'sí, ya lo vi', 'me encanta',
  'eso estaba pensando', 'seguro que sí', 'gracias! 🙏', 'de una, va',
]

export const namesFor = (ids: Id[]) => ids.map((id) => contacts.find((c) => c.id === id)?.firstName ?? 'them')
