import { useEffect, useState } from 'react'
import { COMPRESS_PRESETS, type CompressOptions } from '../engine/pdfium'

type Preset = keyof typeof COMPRESS_PRESETS

const CHOICES: { preset: Preset; label: string; detail: string }[] = [
  { preset: 'high', label: 'High quality', detail: 'Images up to 220 dpi. Good for printing.' },
  { preset: 'balanced', label: 'Balanced', detail: 'Images up to 150 dpi. Good for email and the web.' },
  { preset: 'smallest', label: 'Smallest file', detail: 'Images up to 96 dpi. Fine on screen, soft in print.' },
]

interface Props {
  onApply: (options: CompressOptions) => void
  onCancel: () => void
}

/** Pick how hard to compress. Text, vector art and forms are never changed, only large photos. */
export function CompressDialog({ onApply, onCancel }: Props) {
  const [preset, setPreset] = useState<Preset>('balanced')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="dialog stamp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Reduce file size"
        onSubmit={(e) => {
          e.preventDefault()
          onApply(COMPRESS_PRESETS[preset])
        }}
      >
        <h2>Reduce file size</h2>
        <p className="hint">Shrinks large photos and scans. Text, drawings and form fields stay exactly as they are.</p>
        {CHOICES.map((c) => (
          <label key={c.preset} className="check choice">
            <input type="radio" name="preset" checked={preset === c.preset} onChange={() => setPreset(c.preset)} />
            <span>
              <strong>{c.label}</strong>
              <br />
              <span className="hint">{c.detail}</span>
            </span>
          </label>
        ))}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" autoFocus>
            Compress
          </button>
        </div>
      </form>
    </div>
  )
}
