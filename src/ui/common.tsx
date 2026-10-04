import { memo, useState, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Check, Info, WarningCircle } from '@phosphor-icons/react'
import { cx, spring } from '../lib/util'
import { useStore } from '../store'

// ---------- Avatar: gradient squircle with initials, Apple-style ----------
const AVATAR_GRADIENTS = [
  ['#5ac8fa', '#0a84ff'], ['#64d2ff', '#5e5ce6'], ['#ff9f0a', '#ff453a'],
  ['#30d158', '#0a84ff'], ['#bf5af2', '#ff375f'], ['#ffd60a', '#ff9f0a'],
  ['#66d4cf', '#30b0c7'], ['#ff6482', '#bf5af2'], ['#8e8e93', '#48484a'],
]

export const Avatar = memo(function Avatar({
  name, hue, url, size = 40, className,
}: { name: string; hue: number; url?: string; size?: number; className?: string }) {
  const g = AVATAR_GRADIENTS[Math.abs(Math.floor(hue / 40)) % AVATAR_GRADIENTS.length]
  // initials from real letters only — an emoji/punctuation "initial" renders
  // as an ugly glyph inside the circle; phone numbers keep their digits
  const letters = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(' ').map((w) => w[0]).filter(Boolean)
  const initials = letters.slice(0, 2).join('').toUpperCase()
  const [badUrl, setBadUrl] = useState<string | null>(null)
  const showImg = url && badUrl !== url
  return (
    <div
      className={cx('relative shrink-0 overflow-hidden rounded-full select-none', className)}
      style={{
        width: size, height: size,
        background: showImg ? undefined : `linear-gradient(160deg, ${g[0]}, ${g[1]})`,
        fontSize: size * 0.4,
      }}
      aria-hidden
    >
      {showImg ? (
        <img src={url} alt="" className="size-full object-cover" loading="lazy" decoding="async" onError={() => setBadUrl(url)} />
      ) : initials ? (
        <span className="grid size-full place-items-center font-semibold text-white/95" style={{ letterSpacing: '0.02em' }}>
          {initials}
        </span>
      ) : (
        // no usable letters (emoji-only or symbol name) — person glyph, not a
        // broken character
        <svg viewBox="0 0 24 24" className="size-full p-[22%] text-white/85" fill="currentColor" aria-hidden>
          <path d="M12 12a4.6 4.6 0 1 0-4.6-4.6A4.6 4.6 0 0 0 12 12Zm0 2.2c-3.7 0-8.4 1.9-8.4 5.6v.7a.8.8 0 0 0 .8.8h15.2a.8.8 0 0 0 .8-.8v-.7c0-3.7-4.7-5.6-8.4-5.6Z" />
        </svg>
      )}
      <span className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-black/[0.06] ring-inset" />
    </div>
  )
})

// ---------- Squircle app icon (settings nav) ----------
export function SquircleIcon({ icon, color, size = 28 }: { icon: ReactNode; color: string; size?: number }) {
  return (
    <div
      className="grid place-items-center rounded-[7px] text-white shrink-0"
      style={{ width: size, height: size, background: color, borderRadius: size * 0.28 }}
    >
      {icon}
    </div>
  )
}

// ---------- Toast host ----------
export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-6 left-1/2 z-[90] flex -translate-x-1/2 flex-col items-center gap-2"
    >
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 16, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={spring.pop}
            className="menu-material flex max-w-[min(480px,80vw)] items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium"
          >
            {t.icon === 'check' && <Check size={15} weight="bold" className="shrink-0 text-[var(--green)]" />}
            {t.icon === 'error' && <WarningCircle size={15} weight="bold" className="shrink-0 text-[var(--red)]" />}
            {t.icon === 'info' && <Info size={15} weight="bold" className="shrink-0 text-[var(--blue)]" />}
            <span className="truncate">{t.text}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

// ---------- Dialog ----------
export function Dialog({
  open, onClose, title, children, actions,
}: {
  open: boolean
  onClose: () => void
  title: string
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[80] grid place-items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <div className="absolute inset-0 bg-black/30" onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 4 }}
            transition={spring.pop}
            className="menu-material relative w-[320px] rounded-2xl p-5"
            role="alertdialog"
            aria-label={title}
          >
            <div className="text-[15px] font-semibold text-center">{title}</div>
            {children && <div className="mt-2 text-[13px] text-[var(--label-2)] text-center leading-relaxed">{children}</div>}
            <div className="mt-4 flex flex-col gap-1.5">{actions}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function DialogButton({
  children, destructive, onClick, primary,
}: { children: ReactNode; destructive?: boolean; primary?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'press w-full rounded-[10px] py-2 text-[15px]',
        primary ? 'font-semibold text-[var(--blue)]' : 'font-normal',
        destructive ? 'font-semibold text-[var(--red)]' : 'text-[var(--blue)]',
        'bg-[var(--fill-3)] hover:bg-[var(--fill-2)]',
      )}
    >
      {children}
    </button>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[5px] border border-[var(--separator-strong)] bg-[var(--fill-4)] px-1.5 py-0.5 font-sans text-[11px] font-medium text-[var(--label-2)] shadow-[0_1px_0_var(--separator)]">
      {children}
    </kbd>
  )
}
