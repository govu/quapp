import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Check, DeviceMobile, QrCode, ArrowClockwise } from '@phosphor-icons/react'
import QRCode from 'qrcode'
import { spring } from '../lib/util'
import { retryBoot, useStore } from '../store'

// deterministic pseudo-QR — shown in demo mode until the app hands us a real payload
function PseudoQR({ seed }: { seed: number }) {
  const cells = useMemo(() => {
    let s = seed
    const out: boolean[] = []
    for (let i = 0; i < 25 * 25; i++) {
      s = (s * 1664525 + 1013904223) >>> 0
      const finder =
        (Math.floor(i / 25) < 7 && i % 25 < 7) ||
        (Math.floor(i / 25) < 7 && i % 25 >= 18) ||
        (Math.floor(i / 25) >= 18 && i % 25 < 7)
      out.push(finder ? true : (s / 0xffffffff) > 0.52)
    }
    return out
  }, [seed])
  return (
    <svg viewBox="0 0 25 25" className="size-full" shapeRendering="crispEdges" aria-label="QR code">
      {cells.map((on, i) =>
        on ? <rect key={i} x={i % 25} y={Math.floor(i / 25)} width="1" height="1" className="fill-black" /> : null,
      )}
    </svg>
  )
}

/** real pairing QR served by the bridge — rendered at full fidelity for the phone camera */
function RealQR({ payload }: { payload: string }) {
  const [svg, setSvg] = useState('')
  useEffect(() => {
    let live = true
    void QRCode.toString(payload, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }).then((s) => {
      if (live) setSvg(s)
    })
    return () => { live = false }
  }, [payload])
  if (!svg) return <div className="size-full animate-pulse rounded-md bg-black/5" />
  return <div className="size-full [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />
}

const STEPS = [
  'Open WhatsApp on your phone',
  'Tap Menu → Linked devices → Link a device',
  'Point your phone at this screen',
]

export function Onboarding() {
  const qr = useStore((s) => s.qrString)
  const status = useStore((s) => s.bridgeStatus)
  const demoMode = useStore((s) => s.demoMode)
  const syncing = useStore((s) => s.syncing)
  const account = useStore((s) => s.account)
  const [demoScanned, setDemoScanned] = useState(false)
  const [seed, setSeed] = useState(1234567)

  // real scan: qr disappears once the phone accepts → confirmed connected
  const scanned = demoMode ? demoScanned : (!qr && !!account)

  // demo mode: the pseudo-QR "rotates"; in real mode the daemon rotates it for us
  useEffect(() => {
    if (qr || !demoMode) return
    const refresh = setInterval(() => setSeed((s) => s + 1), 20000)
    const scan = setTimeout(() => setDemoScanned(true), 3200)
    return () => { clearInterval(refresh); clearTimeout(scan) }
  }, [qr, demoMode])

  const statusLine =
    status === 'error'
      ? { text: 'Cannot reach the Quapp bridge', tone: 'error' as const }
      : syncing
        ? { text: `Syncing${syncing.progress != null ? ` ${syncing.progress}%` : ''} — ${syncing.chats} chats, ${syncing.messages.toLocaleString()} messages…`, tone: 'idle' as const }
        : scanned
          ? { text: 'Connected! Loading your chats…', tone: 'idle' as const }
          : qr
            ? { text: 'Waiting for scan…', tone: 'idle' as const }
            : { text: 'Connecting to WhatsApp…', tone: 'idle' as const }

  return (
    <div className="vibrancy grid h-full place-items-center">
      <div className="flex w-[640px] max-w-[92vw] flex-col items-center">
        <motion.div
          initial={{ opacity: 0, y: 14, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={spring.sheet}
          className="grid size-[68px] place-items-center rounded-[17px] bg-gradient-to-b from-[#1EA9FF] to-[#0A6BFF] shadow-[0_10px_30px_rgba(10,107,255,0.4)]"
        >
          <svg width="36" height="36" viewBox="0 0 64 64" aria-hidden>
            <path d="M32 13c-8.8 0-16 6.3-16 14 0 4.4 2.1 8.4 5.5 11L20 45l7.6-2.4c1.4.3 2.9.4 4.4.4 8.8 0 16-6.3 16-14S40.8 13 32 13z" fill="#fff" />
            <path d="M27 31l3.5-7 1.5 5 4-4-2.5 7-1.5-5z" fill="#0A6BFF" />
          </svg>
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...spring.sheet, delay: 0.06 }}
          className="mt-6 text-[28px] font-bold tracking-[-0.02em]"
        >
          Quapp
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...spring.sheet, delay: 0.1 }}
          className="mt-1.5 text-[15px] text-[var(--label-2)]"
        >
          WhatsApp, native and fast.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...spring.sheet, delay: 0.16 }}
          className="menu-material mt-8 flex items-center gap-8 rounded-[20px] p-7"
        >
          <div className="relative">
            <div className="size-[218px] overflow-hidden rounded-[14px] bg-white p-4 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]">
              <AnimatePresence mode="wait">
                <motion.div
                  key={qr ?? seed}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25 }}
                  className="size-full"
                >
                  {qr ? (
                    <RealQR payload={qr} />
                  ) : demoMode ? (
                    <PseudoQR seed={seed} />
                  ) : (
                    <div className="grid size-full place-items-center">
                      <span className="size-8 animate-spin rounded-full border-[3px] border-black/10 border-t-[var(--blue)]" />
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
            <AnimatePresence>
              {scanned && !qr && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="absolute inset-0 grid place-items-center rounded-[14px] bg-white/90 backdrop-blur-sm"
                >
                  <motion.div
                    initial={{ scale: 0.5 }}
                    animate={{ scale: 1 }}
                    transition={spring.bouncy}
                    className="grid size-16 place-items-center rounded-full bg-[var(--green)] text-white"
                  >
                    <Check size={34} weight="bold" />
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div>
            <div className="mb-4 flex items-center gap-2 text-[13px] font-medium text-[var(--label-2)]">
              <DeviceMobile size={17} /> Use WhatsApp on your phone
            </div>
            <ol className="flex flex-col gap-3">
              {STEPS.map((s, i) => (
                <li key={i} className="flex items-start gap-3 text-[14px] leading-[19px]">
                  <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-[var(--fill-3)] text-[11.5px] font-semibold text-[var(--label-2)]">
                    {i + 1}
                  </span>
                  {s}
                </li>
              ))}
            </ol>
            <div
              className="mt-5 flex items-center gap-2 text-[13.5px] font-medium"
              style={{ color: statusLine.tone === 'error' ? 'var(--red)' : 'var(--label-2)' }}
            >
              {status === 'connecting' && (
                <span className="size-3 animate-spin rounded-full border-2 border-[var(--fill-3)] border-t-[var(--blue)]" />
              )}
              {statusLine.text}
              {status === 'error' && (
                <button
                  onClick={retryBoot}
                  className="press ml-1 flex items-center gap-1.5 rounded-full bg-[var(--fill-3)] px-3 py-1 text-[12.5px] font-semibold text-[var(--label)] hover:bg-[var(--fill-2)]"
                >
                  <ArrowClockwise size={13} weight="bold" /> Retry
                </button>
              )}
            </div>
          </div>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="mt-6 flex items-center gap-1.5 text-[12px] text-[var(--label-3)]"
        >
          <QrCode size={14} /> Your messages stay on this device. End-to-end encrypted.
        </motion.p>
      </div>
    </div>
  )
}
