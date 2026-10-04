# Quapp

A fast, native-feeling WhatsApp desktop client — React + Tailwind renderer in
an Electron shell, backed by `quappd`, a local Node daemon that speaks the
WhatsApp multi-device protocol
([@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) 6.7.x).
A ground-up reimagining of [ZapFast](https://github.com/crmne/zapfast).

![stack](https://img.shields.io/badge/stack-React%2019%20·%20Vite%208%20·%20Tailwind%204%20·%20Electron-blue)

## Features

- **Real WhatsApp link via QR** — scan once, session persists; live messages,
  media, reactions, edits, polls, receipts, presence.
- **iMessage-style UI** — virtualized chat & message lists, normalized state
  with per-row subscriptions, GPU-only spring motion.
- **Command palette** (`⌘K`) — jump to chats, open conversations from
  contacts, run actions.
- **Search everywhere** — per-chat and cross-chat message search.
- **Apple-style themes** — light/dark/system, 6 accent tints, 4 chat
  wallpapers. Settings persist.
- **Drafts** per chat (shown as `Draft:` in the list), unread divider,
  starred messages, jump-to-latest pill, selection mode.
- **Full messaging surface** — replies, forwards, delete-for-everyone, voice
  notes with waveforms, docs, locations, stickers, link previews.
- Formatting shortcuts — `⌘B` bold, `⌘I` italic, `⌘E` code, `⇧⌘X` strike.

## Architecture

```
renderer (React) ──► zustand store ──► ClientAdapter
                                          ├─ DemoAdapter   local simulation
                                          └─ WsAdapter ────► quappd ────► WhatsApp
                                             ws://127.0.0.1:8765   Baileys
                                             http://127.0.0.1:8766  multi-device
```

- `src/bridge/types.ts` is the whole UI↔backend contract — swap the adapter
  and the same UI runs on demo data or the real protocol.
- `quappd` (`bridge/src/quappd.mjs` → bundled to `bridge/dist/quappd.cjs` by
  `pnpm bridge`) owns the WhatsApp session. Electron forks it as a child
  process; port 8765 is commands/events, 8766 serves decrypted media.
- Wire protocol, commands and events: [`docs/BRIDGE.md`](docs/BRIDGE.md).

## Run it

```bash
pnpm install
pnpm dev           # Vite dev server on :5199 (keep running)
pnpm desktop:dev   # Electron window against the dev server
```

`pnpm desktop` does the same after a full `tsc`/`vite` build. Browser-only:
`http://localhost:5199` runs on demo data; append
`?bridge=ws://127.0.0.1:8765` to use a running daemon.

## Build the Windows app

```bash
pnpm dist          # release/Quapp-0.1.0-x64.exe   (NSIS installer)
                   # release/Quapp-0.1.0-portable.exe
```

## Disclaimer

Unofficial client — not affiliated with WhatsApp or Meta. Messages stay
end-to-end encrypted between your linked session and your contacts; the
daemon keeps auth keys, history and the media cache on local disk only.
No telemetry, no account system, nothing leaves the machine except WhatsApp
protocol traffic.
