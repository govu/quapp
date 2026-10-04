import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { cx, spring } from '../lib/util'

export interface MenuItem {
  label: string
  icon?: ReactNode
  destructive?: boolean
  disabled?: boolean
  onClick?: () => void
  separatorAbove?: boolean
  trailing?: ReactNode
}

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
  /** optional emoji quick-reaction row rendered above the items */
  reactions?: { list: string[]; onPick: (e: string) => void }
}

let openMenu: ((s: MenuState) => void) | null = null

export function showContextMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[], reactions?: MenuState['reactions']) {
  e.preventDefault?.()
  openMenu?.({ x: e.clientX, y: e.clientY, items, reactions })
}

/** single global context menu — vibrancy material, springs from the trigger point */
export function ContextMenuHost() {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0, ox: 0, oy: 0 })

  useLayoutEffect(() => {
    openMenu = (m) => {
      setMenu(m)
      const w = 240, h = (m.reactions ? 52 : 0) + m.items.length * 34 + 16
      const x = Math.min(m.x, window.innerWidth - w - 8)
      const y = Math.min(m.y, window.innerHeight - h - 8)
      setPos({ x, y, ox: m.x - x, oy: m.y - y })
    }
    return () => { openMenu = null }
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', key)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', key)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  return createPortal(
    <AnimatePresence>
      {menu && (
        <motion.div
          ref={ref}
          initial={{ opacity: 0, scale: 0.86 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.1 } }}
          transition={spring.pop}
          style={{ left: pos.x, top: pos.y, transformOrigin: `${pos.ox}px ${pos.oy}px` }}
          className="menu-material fixed z-[85] w-60 rounded-[13px] p-1.5"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {menu.reactions && (
            <div className="mb-1 flex items-center justify-between border-b border-[var(--separator)] px-1 pb-1.5">
              {menu.reactions.list.map((e) => (
                <button
                  key={e}
                  className="press rounded-lg p-1 text-[22px] leading-none hover:bg-[var(--fill-2)]"
                  onClick={() => { menu.reactions!.onPick(e); setMenu(null) }}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
          {menu.items.map((it, i) => (
            <div key={i}>
              {it.separatorAbove && <div className="mx-3 my-1 border-t border-[var(--separator)]" />}
              <button
                disabled={it.disabled}
                className={cx(
                  'press flex w-full items-center gap-2.5 rounded-[9px] px-3 py-[7px] text-left text-[14px]',
                  it.destructive ? 'text-[var(--red)]' : 'text-[var(--label)]',
                  it.disabled ? 'opacity-40' : 'hover:bg-[var(--fill-2)]',
                )}
                onClick={() => { setMenu(null); it.onClick?.() }}
              >
                {it.icon && <span className="shrink-0 opacity-80">{it.icon}</span>}
                <span className="flex-1 truncate">{it.label}</span>
                {it.trailing}
              </button>
            </div>
          ))}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
