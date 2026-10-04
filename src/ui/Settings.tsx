import { useEffect, useState, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import {
  Bell, ChatCircle, Database, Info, Keyboard, Lock, PaintBrush, User, X,
} from '@phosphor-icons/react'
import { cx, spring } from '../lib/util'
import { logout, setSettingsOpen, toast, updateSettings, useStore, type Accent, type Settings } from '../store'
import { Avatar, Dialog, DialogButton, SquircleIcon } from './common'

type SectionId = 'account' | 'appearance' | 'chats' | 'notifications' | 'privacy' | 'storage' | 'shortcuts' | 'about'

const NAV: { id: SectionId; label: string; icon: ReactNode; color: string }[] = [
  { id: 'account', label: 'Account', icon: <User size={16} weight="fill" />, color: '#0a84ff' },
  { id: 'appearance', label: 'Appearance', icon: <PaintBrush size={16} weight="fill" />, color: '#bf5af2' },
  { id: 'chats', label: 'Chats', icon: <ChatCircle size={16} weight="fill" />, color: '#30d158' },
  { id: 'notifications', label: 'Notifications', icon: <Bell size={16} weight="fill" />, color: '#ff453a' },
  { id: 'privacy', label: 'Privacy', icon: <Lock size={16} weight="fill" />, color: '#5e5ce6' },
  { id: 'storage', label: 'Storage', icon: <Database size={16} weight="fill" />, color: '#64d2ff' },
  { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard size={16} weight="fill" />, color: '#98989d' },
  { id: 'about', label: 'About', icon: <Info size={16} weight="fill" />, color: '#ff9f0a' },
]

export function SettingsSheet() {
  const open = useStore((s) => s.settingsOpen)
  const [section, setSection] = useState<SectionId>('account')
  const [q, setQ] = useState('')
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] grid place-items-center"
        >
          <div className="absolute inset-0 bg-black/25" onClick={() => setSettingsOpen(false)} />
          <motion.div
            initial={{ scale: 0.96, y: 14, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.97, y: 8, opacity: 0 }}
            transition={spring.sheet}
            className="relative flex h-[560px] w-[720px] max-w-[94vw] overflow-hidden rounded-[14px] bg-[var(--bg-grouped-2)] shadow-[0_24px_80px_rgba(0,0,0,0.3)] ring-1 ring-black/10"
            role="dialog"
            aria-label="Settings"
          >
            {/* nav */}
            <div className="vibrancy hairline-r flex w-[218px] shrink-0 flex-col p-2.5">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search"
                className="mb-2 w-full rounded-[8px] bg-[var(--fill-3)] px-2.5 py-[5px] text-[13px] outline-none placeholder:text-[var(--label-3)] focus:ring-2 focus:ring-[var(--blue)]/50"
              />
              <div className="min-h-0 flex-1 overflow-y-auto">
                {NAV.filter((n) => !q || n.label.toLowerCase().includes(q.toLowerCase())).map((n) => (
                  <button
                    key={n.id}
                    onClick={() => setSection(n.id)}
                    className={cx(
                      'mb-0.5 flex w-full items-center gap-2.5 rounded-[8px] px-2 py-[6px] text-left text-[13.5px]',
                      section === n.id ? 'bg-[var(--blue)]/15 font-medium text-[var(--label)]' : 'hover:bg-[var(--fill-3)]',
                    )}
                  >
                    <SquircleIcon icon={n.icon} color={n.color} size={24} />
                    {n.label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setSettingsOpen(false)}
                className="press mt-2 flex items-center gap-1.5 rounded-[8px] px-2 py-1.5 text-[13px] text-[var(--label-2)] hover:bg-[var(--fill-3)]"
              >
                <X size={14} /> Close
              </button>
            </div>
            {/* detail */}
            <div className="min-w-0 flex-1 overflow-y-auto bg-[var(--bg)] p-6">
              <AnimatePresence mode="wait">
                <motion.div
                  key={section}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.15 }}
                >
                  {section === 'account' && <AccountSection />}
                  {section === 'appearance' && <AppearanceSection />}
                  {section === 'chats' && <ChatsSection />}
                  {section === 'notifications' && <NotificationsSection />}
                  {section === 'privacy' && <PrivacySection />}
                  {section === 'storage' && <StorageSection />}
                  {section === 'shortcuts' && <ShortcutsSection />}
                  {section === 'about' && <AboutSection />}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Group({ children }: { children: ReactNode }) {
  return <div className="mb-5 divide-y divide-[var(--separator)] rounded-[10px] border border-[var(--separator)] bg-[var(--bg)] [&>*]:px-3.5 [&>*]:py-[9px]">{children}</div>
}

function Row({ label, hint, control }: { label: string; hint?: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-[13.5px]">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] text-[var(--label-3)]">{hint}</div>}
      </div>
      {control}
    </div>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-[20px] font-bold tracking-[-0.01em]">{children}</h2>
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={cx('relative h-[26px] w-[44px] rounded-full transition-colors duration-200', on ? 'bg-[var(--green)]' : 'bg-[var(--fill)]')}
    >
      <motion.span
        layout
        transition={spring.snappy}
        className={cx('absolute top-[2px] size-[22px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)]', on ? 'right-[2px]' : 'left-[2px]')}
      />
    </button>
  )
}

function Segmented<T extends string>({ options, value, onChange }: { options: { v: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-[8px] bg-[var(--fill-3)] p-[2px]">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={cx(
            'relative rounded-[6px] px-3 py-[3px] text-[12.5px] transition-colors',
            value === o.v ? 'font-medium text-[var(--label)]' : 'text-[var(--label-2)] hover:text-[var(--label)]',
          )}
        >
          {value === o.v && (
            <motion.span
              layoutId={undefined}
              className="absolute inset-0 rounded-[6px] bg-[var(--bg)] shadow-[0_1px_3px_rgba(0,0,0,0.14)]"
            />
          )}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

function AccountSection() {
  const account = useStore((s) => s.account)
  const demoMode = useStore((s) => s.demoMode)
  const [dialog, setDialog] = useState<'devices' | 'add' | 'logout' | null>(null)
  const relink = () => { setDialog(null); logout() }
  return (
    <div>
      <SectionTitle>Account</SectionTitle>
      <Group>
        <div className="flex items-center gap-3.5 py-1">
          <Avatar name={account?.name ?? 'You'} hue={account?.avatarHue ?? 210} url={account?.avatarUrl} size={56} />
          <div>
            <div className="text-[16px] font-semibold">{account?.name}</div>
            <div className="text-[13px] text-[var(--label-2)]">{account?.phone}</div>
          </div>
        </div>
      </Group>
      <Group>
        <button className="block w-full text-left" onClick={() => setDialog('devices')}>
          <Row label="Linked devices" hint="This device" control={<span className="text-[13px] text-[var(--label-3)]">›</span>} />
        </button>
        <button className="block w-full text-left" onClick={() => setDialog('add')}>
          <Row label="Link a different account" hint="Replaces the session on this device" control={<span className="text-[13px] text-[var(--label-3)]">›</span>} />
        </button>
      </Group>
      <Group>
        <Row label="Log out" hint="Unlink this device. Your messages stay on this PC." control={<button onClick={() => setDialog('logout')} className="press rounded-[7px] px-2.5 py-1 text-[13px] font-medium text-[var(--red)] hover:bg-[var(--red)]/10">Log out</button>} />
      </Group>

      <Dialog open={dialog === 'devices'} onClose={() => setDialog(null)} title="Linked devices"
        actions={<>
          <DialogButton destructive onClick={relink}>Unlink this device</DialogButton>
          <DialogButton onClick={() => setDialog(null)}>Cancel</DialogButton>
        </>}>
        <div className="text-left">
          <div className="mb-1 flex items-center gap-2.5 rounded-[9px] bg-[var(--fill-3)] px-3 py-2.5">
            <span className="grid size-7 place-items-center rounded-[7px] bg-[var(--blue)]/15 text-[var(--blue)]">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">Quapp — Windows</div>
              <div className="text-[11.5px] text-[var(--label-3)]">{demoMode ? 'Demo session' : 'This device · active now'}</div>
            </div>
          </div>
          Manage other sessions from WhatsApp on your phone → Linked devices.
        </div>
      </Dialog>
      <Dialog open={dialog === 'add'} onClose={() => setDialog(null)} title="Link a different account?"
        actions={<>
          <DialogButton primary onClick={relink}>Show QR</DialogButton>
          <DialogButton onClick={() => setDialog(null)}>Cancel</DialogButton>
        </>}>
        You'll be signed out of {account?.phone ?? 'this number'} and shown a QR code to link a different WhatsApp account.
      </Dialog>
      <Dialog open={dialog === 'logout'} onClose={() => setDialog(null)} title="Log out of Quapp?"
        actions={<>
          <DialogButton destructive onClick={relink}>Log out</DialogButton>
          <DialogButton onClick={() => setDialog(null)}>Cancel</DialogButton>
        </>}>
        This unlinks the device from {account?.phone ?? 'your WhatsApp'}. Your messages stay on this PC.
      </Dialog>
    </div>
  )
}

const ACCENTS: { v: Accent; color: string }[] = [
  { v: 'blue', color: '#0a84ff' },
  { v: 'green', color: '#30d158' },
  { v: 'purple', color: '#bf5af2' },
  { v: 'pink', color: '#ff375f' },
  { v: 'orange', color: '#ff9f0a' },
  { v: 'teal', color: '#40c8e0' },
]

function AppearanceSection() {
  const settings = useStore((s) => s.settings)
  return (
    <div>
      <SectionTitle>Appearance</SectionTitle>
      <Group>
        <Row
          label="Theme"
          control={
            <Segmented
              value={settings.theme}
              onChange={(v) => updateSettings({ theme: v })}
              options={[{ v: 'light', label: 'Light' }, { v: 'dark', label: 'Dark' }, { v: 'system', label: 'Auto' }]}
            />
          }
        />
        <Row
          label="Accent"
          hint="Tint for bubbles, buttons and selection"
          control={
            <div className="flex items-center gap-2">
              {ACCENTS.map((a) => (
                <button
                  key={a.v}
                  onClick={() => updateSettings({ accent: a.v })}
                  className={cx(
                    'press relative size-[22px] rounded-full transition-transform',
                    settings.accent === a.v && 'scale-110',
                  )}
                  style={{ background: a.color }}
                  aria-label={`${a.v} accent`}
                >
                  {settings.accent === a.v && (
                    <span className="absolute inset-0 grid place-items-center text-[11px] font-bold text-white">✓</span>
                  )}
                </button>
              ))}
            </div>
          }
        />
      </Group>
      <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--label-3)]">Chat wallpaper</div>
      <div className="mb-5 grid grid-cols-4 gap-2.5">
        {(['default', 'pattern', 'dusk', 'none'] as const).map((w) => (
          <button
            key={w}
            onClick={() => updateSettings({ wallpaper: w })}
            className={cx(
              'press relative aspect-[4/3] overflow-hidden rounded-[10px] ring-2 ring-offset-2 ring-offset-[var(--bg)] transition-shadow',
              settings.wallpaper === w ? 'ring-[var(--blue)]' : 'ring-transparent hover:ring-[var(--fill)]',
            )}
          >
            <span className={cx('absolute inset-0', wallPreview(w))} />
            <span className="absolute bottom-1 left-1 rounded-[5px] bg-black/40 px-1.5 py-0.5 text-[10px] font-medium capitalize text-white">{w}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function wallPreview(w: string) {
  switch (w) {
    case 'pattern': return 'wall-pattern'
    case 'dusk': return 'wall-dusk'
    case 'none': return 'wall-none'
    default: return 'wall-default'
  }
}

function ChatsSection() {
  const settings = useStore((s) => s.settings)
  return (
    <div>
      <SectionTitle>Chats</SectionTitle>
      <Group>
        <Row label="Enter sends message" hint="Off: Enter adds a line, Ctrl+Enter sends" control={<Toggle on={settings.enterToSend} onChange={(v) => updateSettings({ enterToSend: v })} />} />
        <Row label="Link previews" hint="Show a preview card for links" control={<Toggle on={settings.linkPreviews} onChange={(v) => updateSettings({ linkPreviews: v })} />} />
        <Row label="Animations" hint="Reduce motion for a calmer interface" control={
          <Segmented
            value={settings.animLevel}
            onChange={(v) => updateSettings({ animLevel: v })}
            options={[{ v: 'full', label: 'Full' }, { v: 'reduced', label: 'Reduced' }]}
          />
        } />
      </Group>
    </div>
  )
}

function NotificationsSection() {
  const settings = useStore((s) => s.settings)
  const demoMode = useStore((s) => s.demoMode)
  return (
    <div>
      <SectionTitle>Notifications</SectionTitle>
      <Group>
        <Row
          label="Desktop notifications"
          hint={demoMode ? 'Enable real pairing to receive them' : 'Windows toast notifications for new messages'}
          control={<Toggle on={settings.notifications} onChange={(v) => updateSettings({ notifications: v })} />}
        />
        <Row label="Sounds" hint="Play a tone for incoming messages" control={<Toggle on={settings.notifSound} onChange={(v) => updateSettings({ notifSound: v })} />} />
        <Row label="Show message preview" hint="Off: notifications show the sender only" control={<Toggle on={settings.notifPreview} onChange={(v) => updateSettings({ notifPreview: v })} />} />
      </Group>
      <Group>
        <Row label="Unread badge" hint="The window title shows the unread count" control={<span className="text-[13px] text-[var(--label-3)]">Always on</span>} />
      </Group>
    </div>
  )
}

type PrivacyKey = 'privLastSeen' | 'privPhoto' | 'privGroups'
const PRIVACY_SETTING: Record<PrivacyKey, 'lastSeen' | 'profilePhoto' | 'groupsAdd'> = {
  privLastSeen: 'lastSeen',
  privPhoto: 'profilePhoto',
  privGroups: 'groupsAdd',
}

function PrivacySection() {
  const settings = useStore((s) => s.settings)
  const demoMode = useStore((s) => s.demoMode)
  const adapter = useStore((s) => s.adapter)
  const [blocked, setBlocked] = useState<number | null>(null)

  useEffect(() => {
    adapter?.blocklist?.().then((jids) => setBlocked(jids.length)).catch(() => setBlocked(0))
  }, [adapter])

  const setPriv = (key: PrivacyKey, value: Settings[PrivacyKey]) => {
    updateSettings({ [key]: value })
    adapter?.setPrivacy?.(PRIVACY_SETTING[key], value === 'nobody' ? 'none' : value)
  }

  return (
    <div>
      <SectionTitle>Privacy</SectionTitle>
      <Group>
        <Row
          label="Read receipts"
          hint="Blue ticks. Off: you also can't see theirs"
          control={
            <Toggle
              on={settings.readReceipts}
              onChange={(v) => {
                updateSettings({ readReceipts: v })
                adapter?.setPrivacy?.('readReceipts', v ? 'all' : 'none')
              }}
            />
          }
        />
      </Group>
      <Group>
        <Row label="Last seen & online" hint={demoMode ? 'Synced to WhatsApp when linked' : undefined} control={<PrivacyPick v={settings.privLastSeen} set={(v) => setPriv('privLastSeen', v)} />} />
        <Row label="Profile photo" control={<PrivacyPick v={settings.privPhoto} set={(v) => setPriv('privPhoto', v)} />} />
        <Row label="Groups" hint="Who can add you" control={<PrivacyPick v={settings.privGroups} set={(v) => setPriv('privGroups', v)} />} />
      </Group>
      <Group>
        <Row label="Blocked contacts" control={<span className="text-[13px] tabular-nums text-[var(--label-3)]">{blocked ?? '—'}</span>} />
      </Group>
    </div>
  )
}

function PrivacyPick({ v, set }: { v: 'everyone' | 'contacts' | 'nobody'; set: (x: 'everyone' | 'contacts' | 'nobody') => void }) {
  return (
    <Segmented
      value={v}
      onChange={set}
      options={[
        { v: 'everyone', label: 'Everyone' },
        { v: 'contacts', label: 'Contacts' },
        { v: 'nobody', label: 'Nobody' },
      ]}
    />
  )
}

function fmtBytes(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`
  return `${n} B`
}

function StorageSection() {
  const settings = useStore((s) => s.settings)
  const adapter = useStore((s) => s.adapter)
  const [stats, setStats] = useState<{ bytes: number; files: number } | null>(null)
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    adapter?.storageStats?.().then(setStats).catch(() => setStats(null))
  }, [adapter])

  const clear = async () => {
    if (!adapter?.clearCache) return
    setClearing(true)
    try {
      const freed = await adapter.clearCache()
      toast(`Freed ${fmtBytes(freed)}`, 'check')
      const s = await adapter.storageStats?.()
      if (s) setStats(s)
    } catch {
      toast("Couldn't clear the cache", 'error')
    } finally {
      setClearing(false)
    }
  }

  return (
    <div>
      <SectionTitle>Storage</SectionTitle>
      <Group>
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[13.5px]">{stats ? fmtBytes(stats.bytes) : '—'} cached media</span>
            <span className="text-[12px] text-[var(--label-3)]">{stats ? `${stats.files} files` : ''}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--fill-3)]">
            <div
              className="h-full bg-[var(--blue)] transition-all duration-500"
              style={{ width: `${Math.min(100, Math.max(2, ((stats?.bytes ?? 0) / (4e9)) * 100))}%` }}
            />
          </div>
          <div className="mt-2 text-[11.5px] text-[var(--label-2)]">
            Messages and media stay encrypted on this PC — the cache re-downloads on demand.
          </div>
        </div>
      </Group>
      <Group>
        <Row label="Auto-download photos" hint="Fetch attachments when a chat opens" control={<Toggle on={settings.autoDlPhotos} onChange={(v) => updateSettings({ autoDlPhotos: v })} />} />
        <Row label="Auto-download documents" control={<Toggle on={settings.autoDlDocs} onChange={(v) => updateSettings({ autoDlDocs: v })} />} />
      </Group>
      <Group>
        <Row
          label="Clear media cache"
          hint="Deletes downloaded photos, videos and documents — re-fetched on demand"
          control={
            <button onClick={() => void clear()} disabled={clearing} className="press rounded-[7px] px-2.5 py-1 text-[13px] font-medium text-[var(--blue)] hover:bg-[var(--blue)]/10 disabled:opacity-40">
              {clearing ? 'Clearing…' : 'Clear'}
            </button>
          }
        />
      </Group>
    </div>
  )
}

const SHORTCUTS: [string, string][] = [
  ['Command palette', 'Ctrl+K'],
  ['Search in chat', 'Ctrl+F'],
  ['Settings', 'Ctrl+,'],
  ['Next / previous chat', 'Alt+↑ Alt+↓'],
  ['Edit last message', '↑ (empty composer)'],
  ['Bold / italic / code', 'Ctrl+B Ctrl+I Ctrl+E'],
  ['Strikethrough', 'Ctrl+Shift+X'],
  ['New line', 'Shift+Enter'],
  ['Close / cancel', 'Esc'],
]

function ShortcutsSection() {
  return (
    <div>
      <SectionTitle>Shortcuts</SectionTitle>
      <Group>
        {SHORTCUTS.map(([label, keys]) => (
          <Row key={label} label={label} control={<span className="flex gap-1">{keys.split(' ').map((k) => <kbd key={k} className="rounded-[5px] border border-[var(--separator-strong)] bg-[var(--fill-4)] px-1.5 py-0.5 text-[11.5px] font-medium text-[var(--label-2)]">{k}</kbd>)}</span>} />
        ))}
      </Group>
    </div>
  )
}

function AboutSection() {
  return (
    <div>
      <SectionTitle>About</SectionTitle>
      <div className="flex flex-col items-center py-6 text-center">
        <div className="grid size-[72px] place-items-center rounded-[18px] bg-gradient-to-b from-[#1EA9FF] to-[#0A6BFF] shadow-[0_8px_24px_rgba(10,107,255,0.35)]">
          <svg width="38" height="38" viewBox="0 0 64 64"><path d="M32 13c-8.8 0-16 6.3-16 14 0 4.4 2.1 8.4 5.5 11L20 45l7.6-2.4c1.4.3 2.9.4 4.4.4 8.8 0 16-6.3 16-14S40.8 13 32 13z" fill="#fff" /></svg>
        </div>
        <div className="mt-3 text-[19px] font-semibold">Quapp</div>
        <div className="mt-0.5 text-[13px] text-[var(--label-2)]">Version 0.1.0</div>
        <div className="mt-4 max-w-[320px] text-[12.5px] leading-relaxed text-[var(--label-3)]">
          A fast, minimal WhatsApp client for Windows. Chats and media stay on this PC — nothing is sent to third-party servers.
        </div>
      </div>
    </div>
  )
}
