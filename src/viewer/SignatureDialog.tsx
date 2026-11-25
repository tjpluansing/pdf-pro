import { useEffect, useRef, useState } from 'react'
import { INK, SCRIPT_FONTS, storeSignature, trimmed, type SignatureKind } from './signature'

interface Props {
  kind: SignatureKind
  author: string
  onDone: (dataUrl: string) => void
  onCancel: () => void
}

/** Create a signature or initials by drawing, typing or uploading an image. Saved in this browser only. */
export function SignatureDialog({ kind, author, onDone, onCancel }: Props) {
  const [tab, setTab] = useState<'draw' | 'type' | 'image'>('draw')
  const [typed, setTyped] = useState(() =>
    kind === 'initials'
      ? author
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => w[0]!.toUpperCase())
          .join('')
      : author,
  )
  const [font, setFont] = useState(0)
  const [hasInk, setHasInk] = useState(false)
  const [upload, setUpload] = useState<HTMLCanvasElement | null>(null)
  const pad = useRef<HTMLCanvasElement>(null)
  const last = useRef<{ x: number; y: number } | null>(null)
  const title = kind === 'signature' ? 'Create your signature' : 'Create your initials'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const clearPad = () => {
    const c = pad.current
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    setHasInk(false)
  }

  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * e.currentTarget.width, y: ((e.clientY - r.top) / r.height) * e.currentTarget.height }
  }

  const typedCanvas = () => {
    if (!typed.trim()) return null
    const c = document.createElement('canvas')
    c.width = 1200
    c.height = 300
    const ctx = c.getContext('2d')!
    ctx.fillStyle = INK
    ctx.font = `${kind === 'initials' ? 150 : 120}px ${SCRIPT_FONTS[font]}, cursive`
    ctx.textBaseline = 'middle'
    ctx.fillText(typed.trim(), 20, 150, 1160)
    return c
  }

  const loadImage = async (file: File) => {
    const img = new Image()
    img.src = URL.createObjectURL(file)
    try {
      await img.decode()
      const scale = Math.min(1, 1200 / img.naturalWidth)
      const c = document.createElement('canvas')
      c.width = Math.round(img.naturalWidth * scale)
      c.height = Math.round(img.naturalHeight * scale)
      const ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0, c.width, c.height)
      // Photos of signatures on paper: make the near-white background transparent.
      const d = ctx.getImageData(0, 0, c.width, c.height)
      for (let i = 0; i < d.data.length; i += 4) {
        const lum = (d.data[i] + d.data[i + 1] + d.data[i + 2]) / 3
        if (lum > 200) d.data[i + 3] = Math.max(0, Math.round(((235 - lum) / 35) * 255))
      }
      ctx.putImageData(d, 0, 0)
      setUpload(c)
    } finally {
      URL.revokeObjectURL(img.src)
    }
  }

  const source = tab === 'draw' ? (hasInk ? pad.current : null) : tab === 'type' ? typedCanvas() : upload
  const save = () => {
    const c = source && trimmed(source)
    if (!c) return
    const url = c.toDataURL('image/png')
    storeSignature(kind, url)
    onDone(url)
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <div className="tabs" role="tablist">
          {(['draw', 'type', 'image'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === 'draw' ? 'Draw' : t === 'type' ? 'Type' : 'Image'}
            </button>
          ))}
        </div>

        {tab === 'draw' && (
          <div className="sig-area">
            <canvas
              ref={pad}
              className="sig-pad"
              width={1200}
              height={360}
              aria-label="Draw here"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                last.current = at(e)
              }}
              onPointerMove={(e) => {
                if (!last.current) return
                const p = at(e)
                const ctx = e.currentTarget.getContext('2d')!
                ctx.strokeStyle = INK
                ctx.lineWidth = 7
                ctx.lineCap = 'round'
                ctx.lineJoin = 'round'
                ctx.beginPath()
                ctx.moveTo(last.current.x, last.current.y)
                ctx.lineTo(p.x, p.y)
                ctx.stroke()
                last.current = p
                setHasInk(true)
              }}
              onPointerUp={() => (last.current = null)}
            />
            <div className="sig-line">Draw with your mouse, trackpad or finger</div>
            <button onClick={clearPad} disabled={!hasInk}>
              Clear
            </button>
          </div>
        )}

        {tab === 'type' && (
          <div className="sig-area">
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={kind === 'signature' ? 'Your name' : 'Your initials'} />
            <div className="sig-fonts">
              {SCRIPT_FONTS.slice(0, 4).map((f, i) => (
                <button key={f} className={font === i ? 'on' : ''} style={{ fontFamily: `${f}, cursive` }} onClick={() => setFont(i)}>
                  {typed || 'Signature'}
                </button>
              ))}
            </div>
          </div>
        )}

        {tab === 'image' && (
          <div className="sig-area">
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => e.target.files?.[0] && void loadImage(e.target.files[0])} />
            {upload && <img className="sig-preview" src={upload.toDataURL()} alt="Uploaded signature" />}
            <p className="hint">A photo of your signature on white paper works; the white is removed.</p>
          </div>
        )}

        <p className="hint">Saved in this browser so you can reuse it. PDF Pro never uploads it.</p>
        <div className="dialog-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={save} disabled={!source}>
            Use this {kind}
          </button>
        </div>
      </div>
    </div>
  )
}
