import { Suspense, lazy, useEffect, useState } from 'react'
import { AnimatePresence, MotionConfig } from 'motion/react'
import { WsAdapter } from './bridge/ws'
import type { ClientAdapter } from './bridge/types'
import { boot, clearSelection, closeConfirm, closeStatus, logout, nextChat, setForwarding, setGroupSheet, setPalette, setPane, setRelinkPrompt, setSettingsOpen, setStatusCompose, useStore } from './store'
import { Sidebar } from './ui/Sidebar'
import { Conversation } from './ui/Conversation'
import { Onboarding } from './ui/Onboarding'
import { Palette } from './ui/Palette'
import { Dialog, DialogButton, Toasts } from './ui/common'
import { ContextMenuHost } from './ui/Menu'
import { CallOverlay, ForwardSheet, GroupSheet } from './ui/Panes'
import { StatusComposer, StatusViewer } from './ui/Status'

const SettingsSheet = lazy(() => import('./ui/Settings').then((m) => ({ default: m.SettingsSheet })))

// the daemon accepts only connections carrying its per-launch token; the
// Electron main process reads token.txt and passes it in via ?token=
function withToken(url: string, q: URLSearchParams): string {
  const token = q.get('token')
  if (!token) return url
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
}

async function makeAdapter(): Promise<ClientAdapter> {
  const q = new URLSearchParams(location.search)
  const url = q.get('bridge')
  if (url) return new WsAdapter(withToken(url, q))
  // demo mode stays out of the production bundle — pulled in only when asked
  const demo = () => import('./bridge/demo').then((m) => new m.DemoAdapter())
  if (q.has('demo')) return demo()
  // inside the packaged app the quappd daemon runs as a child process
  if (navigator.userAgent.includes('Electron')) return new WsAdapter(withToken('ws://127.0.0.1:8765', q))
  return demo()
}

function ConfirmHost() {
  const confirm = useStore((s) => s.confirm)
  return (
    <Dialog open={!!confirm} onClose={closeConfirm} title={confirm?.title ?? ''}
      actions={<>
        <DialogButton destructive onClick={() => { const r = confirm?.run; closeConfirm(); r?.() }}>{confirm?.ok ?? 'Confirm'}</DialogButton>
        <DialogButton onClick={closeConfirm}>Cancel</DialogButton>
      </>}>
      {confirm?.body}
    </Dialog>
  )
}

function RelinkPrompt() {
  const open = useStore((s) => s.relinkPrompt)
  const account = useStore((s) => s.account)
  return (
    <Dialog open={open} onClose={() => setRelinkPrompt(false)} title="Link a different account?"
      actions={<>
        <DialogButton primary onClick={() => { setRelinkPrompt(false); logout() }}>Show QR</DialogButton>
        <DialogButton onClick={() => setRelinkPrompt(false)}>Cancel</DialogButton>
      </>}>
      You'll be signed out of {account?.phone ?? 'this number'} and shown a QR code to link a different WhatsApp account.
    </Dialog>
  )
}

export default function App() {
  const phase = useStore((s) => s.phase)
  const theme = useStore((s) => s.settings.theme)
  const accent = useStore((s) => s.settings.accent)
  const animLevel = useStore((s) => s.settings.animLevel)
  const forwarding = useStore((s) => s.forwarding)
  const groupSheet = useStore((s) => s.groupSheet)

  // theme: system/light/dark — applied instantly, no transition on switch
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  // accent retint
  useEffect(() => {
    document.documentElement.dataset.accent = accent
  }, [accent])

  // animation level — MotionConfig drops transform/layout motion; CSS rule
  // collapses keyframe anims and transitions app-wide
  useEffect(() => {
    document.documentElement.classList.toggle('anim-reduced', animLevel === 'reduced')
  }, [animLevel])

  // Mica: the frame has real system material → sidebar drops its own paint
  useEffect(() => {
    if (new URLSearchParams(location.search).get('mica') === '1') {
      document.body.classList.add('mica')
      return () => document.body.classList.remove('mica')
    }
  }, [])

  const [, setAdapter] = useState<ClientAdapter | null>(null)

  // kick the link/connect immediately — the onboarding screen shows the QR while connecting
  useEffect(() => {
    let live = true
    void makeAdapter().then((a) => { if (live) { setAdapter(a); void boot(a) } })
    return () => { live = false }
  }, [])

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette(!useStore.getState().paletteOpen)
      }
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setPane('search')
      }
      if (mod && e.key === ',') {
        e.preventDefault()
        setSettingsOpen(true)
      }
      if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); nextChat(1) }
      if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); nextChat(-1) }
      if (e.key === 'Escape') {
        const s = useStore.getState()
        if (s.paletteOpen) { setPalette(false); return }
        if (s.confirm) { closeConfirm(); return }
        if (s.statusView) { closeStatus(); return }
        if (s.statusCompose) { setStatusCompose(false); return }
        if (s.groupSheet) { setGroupSheet(false); return }
        if (s.forwarding) { setForwarding(null); return }
        if (s.selection) clearSelection()
        else if (s.pane) setPane(null)
        else if (s.settingsOpen) setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (phase === 'linking') {
    return (
      <MotionConfig reducedMotion={animLevel === 'reduced' ? 'always' : 'user'}>
        <div className="h-full">
          <Onboarding />
        </div>
      </MotionConfig>
    )
  }

  return (
    <MotionConfig reducedMotion={animLevel === 'reduced' ? 'always' : 'user'}>
      <div className="flex h-full overflow-hidden">
        <Sidebar />
        <main className="relative flex min-w-0 flex-1 flex-col">
          <Conversation />
        </main>
        <Suspense fallback={null}>
          <SettingsSheet />
        </Suspense>
        <AnimatePresence>{forwarding && <ForwardSheet />}</AnimatePresence>
        <AnimatePresence>{groupSheet && <GroupSheet />}</AnimatePresence>
        <AnimatePresence><StatusViewer /></AnimatePresence>
        <AnimatePresence><StatusComposer /></AnimatePresence>
        <AnimatePresence><CallOverlay /></AnimatePresence>
        <Palette />
        <Toasts />
        <ContextMenuHost />
        <RelinkPrompt />
        <ConfirmHost />
      </div>
    </MotionConfig>
  )
}
