import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '../store'
import { motion, AnimatePresence } from 'motion/react'
import {
  ArrowUp, FileArrowUp, Image as ImageIcon, Microphone,
  Plus, Smiley, X,
} from '@phosphor-icons/react'
import type { Chat } from '../bridge/types'
import { spring } from '../lib/util'
import { doEdit, send, sendFiles, setDraft, setEditing, setReplyTo, setTypingNotify, useStore } from '../store'
import { EMOJI } from '../lib/emoji'

// ---------- emoji picker (native system emoji, compact) ----------
function EmojiPicker({ onPick, onClose }: { onPick: (e: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    if (!q) return EMOJI
    const l = q.toLowerCase()
    return EMOJI.map((g) => ({ ...g, items: g.items.filter((e) => e.n.includes(l)) })).filter((g) => g.items.length)
  }, [q])
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: 4 }}
      transition={spring.pop}
      style={{ transformOrigin: 'bottom left' }}
      className="menu-material absolute bottom-14 left-3 z-40 flex h-[340px] w-[330px] flex-col rounded-2xl p-2"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="px-1.5 pb-1.5">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
          placeholder="Search emoji"
          className="w-full rounded-[8px] bg-[var(--fill-3)] px-2.5 py-[6px] text-[13.5px] outline-none placeholder:text-[var(--label-3)]"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        {groups.map((g) => (
          <div key={g.name}>
            <div className="px-1.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--label-3)]">{g.name}</div>
            <div className="grid grid-cols-8">
              {g.items.map((e) => (
                <button
                  key={e.e}
                  onClick={() => onPick(e.e)}
                  className="press grid aspect-square place-items-center rounded-lg text-[24px] hover:bg-[var(--fill-2)]"
                  title={e.n}
                >
                  {e.e}
                </button>
              ))}
            </div>
          </div>
        ))}
        {groups.length === 0 && (
          <div className="grid h-32 place-items-center text-[13px] text-[var(--label-3)]">No results</div>
        )}
      </div>
    </motion.div>
  )
}

// ---------- attach sheet ----------
function AttachMenu({ onPick, onClose }: { onPick: (kind: 'image' | 'doc') => void; onClose: () => void }) {
  const items = [
    { icon: <ImageIcon size={20} />, label: 'Photos & videos', sub: 'Send images or clips', k: 'image' as const },
    { icon: <FileArrowUp size={20} />, label: 'Document', sub: 'Any file type', k: 'doc' as const },
  ]
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: 4 }}
      transition={spring.pop}
      style={{ transformOrigin: 'bottom left' }}
      className="menu-material absolute bottom-14 left-3 z-40 w-[240px] rounded-2xl p-1.5"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((it) => (
        <button
          key={it.k}
          onClick={() => { onPick(it.k); onClose() }}
          className="press flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left hover:bg-[var(--fill-2)]"
        >
          <span className="grid size-9 place-items-center rounded-[10px] bg-[var(--fill-3)] text-[var(--label-2)]">{it.icon}</span>
          <span>
            <span className="block text-[14px] font-medium">{it.label}</span>
            <span className="block text-[12px] text-[var(--label-3)]">{it.sub}</span>
          </span>
        </button>
      ))}
    </motion.div>
  )
}

// ---------- reply / edit banner ----------
function Banner() {
  const replyTo = useStore((s) => s.replyTo)
  const editing = useStore((s) => s.editing)
  const current = editing
    ? { title: 'Edit message', body: editing.content.kind === 'text' ? editing.content.text : '', onClose: () => setEditing(null), accent: 'var(--orange)' }
    : replyTo
      ? { title: replyTo.fromName, body: replyTo.preview, onClose: () => setReplyTo(null), accent: 'var(--blue)' }
      : null
  return (
    <AnimatePresence>
      {current && (
        <motion.div
          initial={{ opacity: 0, height: 0, y: 8 }}
          animate={{ opacity: 1, height: 'auto', y: 0 }}
          exit={{ opacity: 0, height: 0, y: 8 }}
          transition={spring.snappy}
          className="overflow-hidden"
        >
          <div className="mx-3 mb-2 flex items-center gap-3 rounded-[12px] bg-[var(--fill-3)] px-3 py-2" style={{ borderLeft: `3px solid ${current.accent}` }}>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold" style={{ color: current.accent }}>{current.title}</div>
              <div className="truncate text-[13px] text-[var(--label-2)]">{current.body}</div>
            </div>
            <button onClick={current.onClose} className="press rounded-full p-1 text-[var(--label-3)] hover:bg-[var(--fill-2)]" aria-label="Cancel">
              <X size={15} weight="bold" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ---------- composer ----------
export const Composer = memo(function Composer({ chat }: { chat: Chat }) {
  const [text, setText] = useState(() => useStore.getState().drafts.get(chat.id) ?? chat.draft ?? '')
  const [picker, setPicker] = useState<'none' | 'emoji' | 'attach'>('none')
  const [recording, setRecording] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const fileMode = useRef<'image' | 'doc'>('image')
  const editing = useStore((s) => s.editing)
  const enterToSend = useStore((s) => s.settings.enterToSend)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // restore draft / focus when switching chats
  useEffect(() => {
    setText(useStore.getState().drafts.get(chat.id) ?? chat.draft ?? '')
    setPicker('none')
    requestAnimationFrame(() => taRef.current?.focus())
  }, [chat.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // editing: prefill
  useEffect(() => {
    if (editing?.content.kind === 'text') {
      setText(editing.content.text)
      taRef.current?.focus()
      taRef.current?.setSelectionRange(text.length, text.length)
    }
  }, [editing]) // eslint-disable-line react-hooks/exhaustive-deps

  const autosize = () => {
    const ta = taRef.current
    if (ta) {
      ta.style.height = '0px'
      ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'
    }
  }
  useEffect(autosize, [text])

  const isChannel = chat.kind === 'channel'

  const doSend = () => {
    const t = text.trim()
    if (!t) return
    if (editing) {
      doEdit(chat.id, editing.id, t)
      setText('')
      setDraft(chat.id, '')
      return
    }
    send(chat.id, { kind: 'text', text: t })
    setText('')
    setDraft(chat.id, '')
    requestAnimationFrame(() => taRef.current?.focus())
  }

  /** wrap the current selection in a markup pair — Ctrl+B Ctrl+I Ctrl+E Ctrl+Shift+X */
  const wrapSelection = (marker: string) => {
    const ta = taRef.current
    if (!ta) return
    const s = ta.selectionStart ?? text.length
    const e = ta.selectionEnd ?? s
    const sel = text.slice(s, e) || 'text'
    const nt = text.slice(0, s) + marker + sel + marker + text.slice(e)
    setText(nt)
    setDraft(chat.id, nt)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(s + marker.length, s + marker.length + sel.length)
    })
  }

  const onKey = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'Enter' && (enterToSend ? !e.shiftKey : mod)) {
      e.preventDefault()
      doSend()
      return
    }
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase()
      if (k === 'b') { e.preventDefault(); wrapSelection('*'); return }
      if (k === 'i') { e.preventDefault(); wrapSelection('_'); return }
      if (k === 'e') { e.preventDefault(); wrapSelection('`'); return }
      if (k === 'x' && e.shiftKey) { e.preventDefault(); wrapSelection('~'); return }
    }
    if (e.key === 'ArrowUp' && !text && !editing) {
      // edit last own text message (WhatsApp behavior)
      const b = useStore.getState().buckets.get(chat.id)
      if (b) {
        for (let i = b.ids.length - 1; i >= 0; i--) {
          const m = b.map.get(b.ids[i])!
          if (m.from === 'me' && m.content.kind === 'text') { setEditing(m); break }
        }
      }
    }
    if (e.key === 'Escape') {
      if (editing) setEditing(null)
      else setPicker('none')
    }
  }

  const typingArmed = useRef(false)
  const notifyTyping = () => {
    clearTimeout(typingTimer.current)
    if (!typingArmed.current) {
      typingArmed.current = true
      setTypingNotify(chat.id, true) // one frame per 3s window, not per keystroke
    }
    typingTimer.current = setTimeout(() => {
      typingArmed.current = false
      setTypingNotify(chat.id, false)
    }, 3000)
  }

  const insertEmoji = (e: string) => {
    const ta = taRef.current
    const s = ta?.selectionStart ?? text.length
    const nt = text.slice(0, s) + e + text.slice(ta?.selectionEnd ?? s)
    setText(nt)
    setDraft(chat.id, nt) // the picker path bypassed onChange → drafts lost emoji inserts
    const caret = s + e.length
    requestAnimationFrame(() => { ta?.focus(); ta?.setSelectionRange(caret, caret) })
  }

  const attach = (kind: 'image' | 'doc') => {
    fileMode.current = kind
    fileRef.current?.click()
  }

  const onFiles = (files: FileList | null) => {
    if (files?.length) sendFiles(chat.id, files, fileMode.current === 'doc')
  }

  if (isChannel) {
    return (
      <div className="hairline-t chrome px-4 py-3 text-center text-[13px] text-[var(--label-2)]">
        Channels are read-only. Only admins can post.
      </div>
    )
  }

  return (
    <div className="relative">
      <Banner />
      <div className="chrome hairline-t relative flex items-end gap-2 px-3 py-2.5">
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          multiple
          accept={fileMode.current === 'image' ? 'image/*,video/*' : undefined}
          onChange={(e) => { onFiles(e.target.files); e.target.value = '' }}
        />
        <button
          onClick={() => setPicker(picker === 'attach' ? 'none' : 'attach')}
          className="press focus-ring mb-[3px] grid size-[34px] shrink-0 place-items-center rounded-full bg-[var(--fill-3)] text-[var(--label-2)] hover:bg-[var(--fill-2)]"
          aria-label="Attach"
        >
          <Plus size={19} weight="bold" />
        </button>

        <div className="relative min-w-0 flex-1">
          <textarea
            ref={taRef}
            value={text}
            rows={1}
            onChange={(e) => { setText(e.target.value); setDraft(chat.id, e.target.value); notifyTyping() }}
            onKeyDown={onKey}
            onPaste={(e) => {
              // pasted files attach like WhatsApp Web — images send as photos,
              // everything else as a document
              const files = e.clipboardData?.files
              if (files?.length) {
                e.preventDefault()
                fileMode.current = 'image'
                onFiles(files)
              }
            }}
            placeholder="Message"
            className="composer-input w-full resize-none rounded-[18px] border border-[var(--field-border)] bg-[var(--field)] py-[7px] pl-3.5 pr-10 text-[15px] leading-[20px] outline-none placeholder:text-[var(--label-3)] focus:border-[var(--blue)]/50"
            aria-label="Message"
          />
          <button
            onClick={() => setPicker(picker === 'emoji' ? 'none' : 'emoji')}
            className="press absolute bottom-[5px] right-[8px] rounded-full p-1 text-[var(--label-3)] hover:text-[var(--label-2)]"
            aria-label="Emoji"
          >
            <Smiley size={20} />
          </button>
        </div>

        <div className="mb-[3px] grid size-[34px] shrink-0 place-items-center">
          <AnimatePresence mode="popLayout" initial={false}>
            {text.trim() ? (
              <motion.button
                key="send"
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.6, opacity: 0 }}
                transition={spring.pop}
                onClick={doSend}
                className="press focus-ring grid size-[34px] place-items-center rounded-full bg-[var(--blue)] text-white shadow-[0_1px_4px_rgba(0,122,255,0.4)]"
                aria-label={editing ? 'Save' : 'Send'}
              >
                {editing ? <span className="text-[13px] font-semibold">✓</span> : <ArrowUp size={18} weight="bold" />}
              </motion.button>
            ) : (
              <motion.button
                key="mic"
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.6, opacity: 0 }}
                transition={spring.pop}
                onClick={() => setRecording(true)}
                className="press focus-ring grid size-[34px] place-items-center rounded-full text-[var(--label-2)] hover:bg-[var(--fill-2)]"
                aria-label="Voice message"
              >
                <Microphone size={20} />
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        <AnimatePresence>
          {picker === 'emoji' && <EmojiPicker onPick={insertEmoji} onClose={() => setPicker('none')} />}
          {picker === 'attach' && <AttachMenu onPick={attach} onClose={() => setPicker('none')} />}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {recording && <RecorderOverlay chat={chat} onDone={() => setRecording(false)} />}
      </AnimatePresence>
    </div>
  )
})

// ---------- voice recording overlay (real MediaRecorder) ----------
function RecorderOverlay({ chat, onDone }: { chat: Chat; onDone: () => void }) {
  const [sec, setSec] = useState(0)
  const [wave, setWave] = useState<number[]>([])
  const recRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const cancelled = useRef(false)
  const waveRef = useRef<number[]>([])

  useEffect(() => {
    let alive = true
    let tick: ReturnType<typeof setInterval>
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        if (!alive) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus'
          : ''
        const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
        recRef.current = rec
        chunksRef.current = []
        rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data) }
        rec.start(200)
        // live waveform from the analyser
        const ctx = new AudioContext()
        const src = ctx.createMediaStreamSource(stream)
        const an = ctx.createAnalyser()
        an.fftSize = 256
        src.connect(an)
        const buf = new Uint8Array(an.frequencyBinCount)
        const startedAt = Date.now()
        tick = setInterval(() => {
          // the tick is 220ms — sec must come from the wall clock or the
          // timer (and the sent duration) runs ~4.5× fast
          setSec(Math.floor((Date.now() - startedAt) / 1000))
          an.getByteTimeDomainData(buf)
          let peak = 0
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
          const h = 4 + (peak / 128) * 20
          waveRef.current = [...waveRef.current.slice(-46), h]
          setWave(waveRef.current)
        }, 220)
      })
      .catch(() => {
        toast('Microphone unavailable — check Windows permissions', 'error')
        onDone()
      })
    return () => {
      alive = false
      clearInterval(tick)
      cancelled.current = true
      recRef.current?.state !== 'inactive' && recRef.current?.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const finish = (sendIt: boolean) => {
    const rec = recRef.current
    if (!sendIt || !rec || chunksRef.current.length === 0) {
      onDone()
      return
    }
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
      const rd = new FileReader()
      rd.onload = () => {
        send(chat.id, {
          kind: 'audio',
          duration: Math.max(1, sec),
          waveform: waveRef.current.length ? waveRef.current.map((v) => Math.round(v)) : [4, 8, 6, 10],
          voice: true,
          url: String(rd.result),
        })
      }
      rd.readAsDataURL(blob)
    }
    rec.stop()
    onDone()
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-x-0 bottom-0 z-50 flex items-center gap-3 bg-[var(--bg)] px-4 py-3"
    >
      <button onClick={() => finish(false)} className="press rounded-full p-1.5 text-[var(--red)] hover:bg-[var(--fill-2)]" aria-label="Discard">
        <X size={20} weight="bold" />
      </button>
      <span className="size-2.5 animate-pulse rounded-full bg-[var(--red)]" />
      <span className="text-[15px] tabular-nums text-[var(--label-2)]">
        {Math.floor(sec / 60)}:{(sec % 60).toString().padStart(2, '0')}
      </span>
      <div className="flex h-6 flex-1 items-center gap-[2.5px] overflow-hidden">
        {wave.map((v, i) => (
          <span key={i} className="w-[3px] rounded-full bg-[var(--blue)]" style={{ height: v }} />
        ))}
        {!wave.length && <span className="text-[12px] text-[var(--label-3)]">Listening…</span>}
      </div>
      <button onClick={() => finish(true)} className="press grid size-[34px] place-items-center rounded-full bg-[var(--blue)] text-white" aria-label="Send voice message">
        <ArrowUp size={18} weight="bold" />
      </button>
    </motion.div>
  )
}
