const W = require('ws')
const TOKEN = require('fs').readFileSync('quapp-data/token.txt', 'utf8').trim()
const bad = new W('ws://127.0.0.1:8765?token=nope')
bad.on('error', () => console.log('bad token: rejected ✓'))
bad.on('unexpected-response', (r, s) => console.log('bad token: HTTP ' + s.statusCode + ' ✓'))
bad.on('open', () => { console.log('bad token: ACCEPTED ✗'); process.exit(1) })
setTimeout(() => {
  const good = new W('ws://127.0.0.1:8765?token=' + TOKEN)
  const t = setTimeout(() => { console.log('(still linking — connect waits, normal)'); process.exit(0) }, 25000)
  good.on('open', () => good.send(JSON.stringify({ id: 1, cmd: 'connect' })))
  good.on('message', (d) => {
    const f = JSON.parse(d)
    if (f.ev) console.log('ev:', f.ev.type, f.ev.chat?.title ?? (f.ev.type === 'qr' ? 'qr ' + f.ev.qr.length + 'ch' : ''))
    if (f.id === 1) {
      const r = f.result
      console.log('connect → chats:' + r.chats.length, 'contacts:' + r.contacts.length, 'linked:' + r.linked)
      clearTimeout(t); process.exit(0)
    }
  })
  good.on('error', (e) => { console.log('good token err:', e.message); process.exit(1) })
}, 1500)
setTimeout(() => { console.log('timeout'); process.exit(1) }, 40000)
