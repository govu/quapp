# quappd — the Quapp bridge daemon

`quappd` is a Node daemon that speaks WhatsApp's multi-device protocol via
[`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) 6.7.x
and exposes the Quapp `ClientAdapter` contract (`src/bridge/types.ts`) over
local JSON transports. The renderer never sees a protobuf.

- Source: `bridge/src/quappd.mjs` (single-file ESM)
- Bundle: `bridge/dist/quappd.cjs` — produced by `pnpm bridge`
  (esbuild, `--platform=node --format=cjs --target=node20`)
- Externals (not bundled): sharp, jimp, canvas, link-preview-js,
  qrcode-terminal, audio-decode, music-metadata, bufferutil, utf-8-validate

Privacy: message bodies, numbers, keys and QR payloads are never logged.

## Build & run

```bash
pnpm bridge               # bundle → bridge/dist/quappd.cjs
pnpm quappd               # run unbundled from source
node bridge/dist/quappd.cjs
```

In the packaged app, Electron forks `quappd.cjs` with
`ELECTRON_RUN_AS_NODE=1` and auto-restarts it on crash
(`electron/main.cjs`). `bridge/dist/**` is shipped asar-unpacked.

## Transports

### WebSocket — commands + events

`ws://127.0.0.1:8765`, one JSON object per frame:

```
client → daemon   { "id": 1, "cmd": "send", ...args }
daemon → client   { "id": 1, "ok": true,  "result": ... }   response
                  { "id": 1, "ok": false, "error": "..." }  error
                  { "ev": { "type": "message", ... } }      unsolicited push
```

Multiple clients may attach; events are broadcast to all connected sockets.

### HTTP — decrypted media

`http://127.0.0.1:8766/m/<chatId>/<messageId>` (both segments URL-encoded).

Looks up the stored proto, decrypts via `downloadMediaMessage`, and serves
the body with the message's own mimetype plus
`cache-control: private, max-age=86400` and `access-control-allow-origin: *`.
Bodies are disk-cached under `data/media/` after the first fetch; 404 when
the message is unknown or decryption fails. Message models reference media
by this URL — image `url`, video `url`, audio `file`, etc.

## Environment & data dir

| var                | default        |
|--------------------|----------------|
| `QUAPP_HOST`       | `127.0.0.1`    |
| `QUAPP_WS_PORT`    | `8765`         |
| `QUAPP_MEDIA_PORT` | `8766`         |
| `QUAPP_DATA`       | `./quapp-data` |

Under Electron, `QUAPP_DATA` is `<userData>/quappd`, so the session survives
working-directory changes. Data dir layout:

- `auth/` — baileys multi-file auth state (creds + signal keys)
- `media/` — decrypted media cache (`<chatId>--<messageId>`) and `download` output
- `flags.json` — persisted local flags: `favorite`, `unread`, `starred`
  (400ms-debounced writes)

Chats, contacts and messages live in daemon memory (20k msgs/chat cap);
auth, flags and the media cache are the only on-disk state.

## Events (`{ "ev": … }`)

| type               | payload                     | when                                        |
|--------------------|-----------------------------|---------------------------------------------|
| `qr`               | `{qr}`                      | pairing payload; repeats until scanned      |
| `connection`       | `{state:'closed'}`          | socket dropped (auto-reconnect, 2s→30s backoff) |
| `linked`           | `{account}`                 | connection open, account identified         |
| `history_done`     | `{}`                        | initial history sync finished               |
| `chat_update`      | `{chat}`                    | any chat field changed                      |
| `message`          | `{msg}`                     | new incoming message / own-send echo        |
| `message_update`   | `{msg}`                     | edit, reaction, revoke, poll tally, star    |
| `messages_removed` | `{chatId, ids}`             | deleted for everyone                        |
| `delivery`         | `{chatId, ids, delivery}`   | receipt transition                          |
| `typing`           | `{chatId, names}`           | composing/recording, 6s decay               |
| `presence`         | `{chatId, online}`          | contact availability                        |

## Commands

`{id, cmd, ...args}` → `{id, ok, result}`.

| cmd              | args                              | notes |
|------------------|-----------------------------------|-------|
| `connect`        | —                                 | starts the socket, waits for link + first history sync (up to ~30s), resolves with a `Snapshot` (account, chats sorted by activity, contacts, last 40 msgs for the 60 most recent chats) |
| `loadOlder`      | `chatId, beforeTs, limit`         | pages **daemon memory only** — see caveats |
| `searchMessages` | `chatId, query`                   | substring match, last 60 hits |
| `searchAll`      | `query`                           | all chats, top 80 by timestamp |
| `send`           | `chatId, content, replyTo?`       | text / image / video / document / audio / poll; media as `data:` URL (decoded to a buffer) or http(s) `url`; `replyTo.id` attaches the quoted proto |
| `edit`           | `chatId, messageId, text`         | WhatsApp message edit |
| `delete`         | `chatId, messageIds, forEveryone` | revokes when `forEveryone`, always tombstones locally |
| `react`          | `chatId, messageId, emoji`        | `null` removes the reaction |
| `forward`        | `toChatIds, messageIds`           | `sendMessage {forward: proto, force: true}` per target |
| `star`           | `chatId, messageIds, starred`     | `chatModify` + persisted local flag (survives restarts) |
| `openChat`       | `contactId`                       | get-or-create the dm; accepts a phone number or jid |
| `markRead`       | `chatId`                          | `readMessages` on the newest incoming key; clears unread + flags |
| `markUnread`     | `chatId, value`                   | local flag only — no WhatsApp-side unread marker |
| `setTyping`      | `chatId, typing`                  | presence `composing` / `paused` |
| `setChatFlag`    | `chatId, flag, value`             | `pinned` / `muted` (~1y = always) / `archived` via `chatModify`; `favorite` is local-only |
| `vote`           | `chatId, messageId, optionIndexes` | **local reflection only** — encrypted vote construction is TODO |
| `download`       | `chatId, messageId`               | writes the media body to `data/media/`, returns `{path}` |

## Pairing & session

The first `connect` emits `qr` events (raw pairing strings) until the phone
scans one — the UI renders them on the onboarding screen. Credentials
persist in `auth/`, so later launches skip the QR step. A `loggedOut`
disconnect wipes `auth/` and re-enters pairing. `syncFullHistory` is on:
each daemon start re-syncs chats/messages from the phone.

## Connecting the UI

Adapter selection is in `src/App.tsx`:

- Electron (packaged or `electron .`): `WsAdapter('ws://127.0.0.1:8765')`
  automatically — the daemon is a child process.
- Browser dev: `http://localhost:5199/?bridge=ws://127.0.0.1:8765`
- `?demo` forces the `DemoAdapter` (local simulation); a plain browser load
  defaults to demo.

## Caveats

- Browser fingerprint is `Browsers.ubuntu('Chrome')` — the macOS fingerprint
  gets HTTP 428 (Precondition Required) from WhatsApp.
- `loadOlder` serves daemon memory only (history-sync backfill + live
  traffic). Phone-side on-demand history fetch is not wired.
- Audio/video plays straight from the media HTTP URL — streamed from the
  disk cache once fetched.
- Poll votes are reflected in the local model only; the encrypted
  `pollUpdateMessage` send path isn't implemented, so votes aren't visible
  to other participants. Incoming votes are tallied when decryptable.
- In-memory chat/message state is rebuilt from history sync on each daemon
  start; only `auth/`, `flags.json` and `media/` persist across restarts.
