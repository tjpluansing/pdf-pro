import { useEffect, useState } from 'react'
import type { PageText, PageTextOptions, StandardFont } from '../engine/pdfium'
import { parsePageRange } from './pageRange'

export type StampKind = 'watermark' | 'header-footer' | 'page-numbers'

interface Props {
  kind: StampKind
  pageCount: number
  onApply: (items: PageText[], options: PageTextOptions) => void
  onCancel: () => void
}

const FONTS: { value: StandardFont; label: string }[] = [
  { value: 'Helvetica', label: 'Sans' },
  { value: 'Helvetica-Bold', label: 'Sans bold' },
  { value: 'Times-Roman', label: 'Serif' },
  { value: 'Times-Bold', label: 'Serif bold' },
  { value: 'Courier', label: 'Monospace' },
]

const NUMBER_FORMATS = ['{page}', 'Page {page}', 'Page {page} of {pages}', '{page} / {pages}', '- {page} -']
type Slot = 'header-left' | 'header-center' | 'header-right' | 'footer-left' | 'footer-center' | 'footer-right'
const SLOTS: Slot[] = ['header-left', 'header-center', 'header-right', 'footer-left', 'footer-center', 'footer-right']
const TITLES: Record<StampKind, string> = {
  watermark: 'Add a watermark',
  'header-footer': 'Add headers and footers',
  'page-numbers': 'Add page numbers',
}

/** Watermark, header and footer, and page number settings. Applied to the document as one undoable step. */
export function StampDialog({ kind, pageCount, onApply, onCancel }: Props) {
  const [text, setText] = useState('CONFIDENTIAL')
  const [font, setFont] = useState<StandardFont>(kind === 'watermark' ? 'Helvetica-Bold' : 'Helvetica')
  const [size, setSize] = useState(kind === 'watermark' ? 72 : 10)
  const [color, setColor] = useState(kind === 'watermark' ? '#c8321f' : '#333333')
  const [opacity, setOpacity] = useState(30)
  const [rotation, setRotation] = useState(45)
  const [behind, setBehind] = useState(false)
  const [slots, setSlots] = useState<Record<Slot, string>>({
    'header-left': '',
    'header-center': '',
    'header-right': '',
    'footer-left': '',
    'footer-center': '',
    'footer-right': '',
  })
  const [format, setFormat] = useState(NUMBER_FORMATS[2])
  const [slot, setSlot] = useState<Slot>('footer-center')
  const [margin, setMargin] = useState(36)
  const [range, setRange] = useState('')
  const [startAt, setStartAt] = useState(1)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const pages = parsePageRange(range, pageCount)
  const style = { font, size, color }
  const fromSlot = (s: Slot, t: string): PageText => {
    const [where, align] = s.split('-') as ['header' | 'footer', 'left' | 'center' | 'right']
    return { kind: where, align, text: t, margin, ...style }
  }
  const items: PageText[] =
    kind === 'watermark'
      ? [{ kind: 'watermark', text, opacity: opacity / 100, rotation, behind, ...style }]
      : kind === 'page-numbers'
        ? [fromSlot(slot, format)]
        : SLOTS.filter((s) => slots[s].trim()).map((s) => fromSlot(s, slots[s]))
  const ready = typeof pages !== 'string' && items.some((i) => i.text.trim()) && size > 0

  const apply = () => {
    if (!ready || typeof pages === 'string') return
    onApply(items, { pages: pages.length === pageCount ? undefined : pages, startAt, date: new Date().toLocaleDateString() })
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="dialog stamp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={TITLES[kind]}
        onSubmit={(e) => {
          e.preventDefault()
          apply()
        }}
      >
        <h2>{TITLES[kind]}</h2>

        {kind === 'watermark' && (
          <>
            <label className="wide">
              Text
              <input autoFocus value={text} onChange={(e) => setText(e.target.value)} />
            </label>
            <div className="row">
              <label>
                Opacity {opacity}%
                <input type="range" min={5} max={100} step={5} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
              </label>
              <label>
                Angle
                <select value={rotation} onChange={(e) => setRotation(Number(e.target.value))}>
                  <option value={0}>Flat</option>
                  <option value={45}>Diagonal up</option>
                  <option value={-45}>Diagonal down</option>
                  <option value={90}>Vertical</option>
                </select>
              </label>
              <label>
                Layer
                <select value={behind ? 'behind' : 'over'} onChange={(e) => setBehind(e.target.value === 'behind')}>
                  <option value="over">Over the page</option>
                  <option value="behind">Behind the text</option>
                </select>
              </label>
            </div>
          </>
        )}

        {kind === 'header-footer' && (
          <>
            <div className="slots">
              {SLOTS.map((s, i) => (
                <input
                  key={s}
                  autoFocus={i === 0}
                  aria-label={s.replace('-', ' ')}
                  placeholder={`${s.startsWith('header') ? 'Header' : 'Footer'}, ${s.split('-')[1]}`}
                  value={slots[s]}
                  onChange={(e) => setSlots({ ...slots, [s]: e.target.value })}
                />
              ))}
            </div>
            <p className="hint">
              Type <code>{'{page}'}</code>, <code>{'{pages}'}</code> or <code>{'{date}'}</code> to fill in the page number, page count or today's date.
            </p>
          </>
        )}

        {kind === 'page-numbers' && (
          <div className="row">
            <label>
              Style
              <select autoFocus value={format} onChange={(e) => setFormat(e.target.value)}>
                {NUMBER_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f.replace('{page}', '1').replace('{pages}', String(pageCount))}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Position
              <select value={slot} onChange={(e) => setSlot(e.target.value as Slot)}>
                {SLOTS.map((s) => (
                  <option key={s} value={s}>
                    {s.startsWith('header') ? 'Top' : 'Bottom'} {s.split('-')[1]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <div className="row">
          <label>
            Font
            <select value={font} onChange={(e) => setFont(e.target.value as StandardFont)}>
              {FONTS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Size
            <input type="number" min={4} max={400} value={size} onChange={(e) => setSize(Number(e.target.value))} />
          </label>
          <label>
            Colour
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          {kind !== 'watermark' && (
            <label>
              Margin (pt)
              <input type="number" min={0} max={300} value={margin} onChange={(e) => setMargin(Number(e.target.value))} />
            </label>
          )}
        </div>

        <div className="row">
          <label>
            Pages
            <input placeholder={`All ${pageCount}`} value={range} onChange={(e) => setRange(e.target.value)} aria-invalid={typeof pages === 'string'} />
          </label>
          {kind !== 'watermark' && (
            <label>
              First number
              <input type="number" min={0} value={startAt} onChange={(e) => setStartAt(Number(e.target.value))} />
            </label>
          )}
        </div>
        {typeof pages === 'string' && <p className="hint error-text">{pages}</p>}
        {kind !== 'watermark' && <p className="hint">The first page of the document is numbered {startAt}.</p>}
        <p className="hint">Uses standard PDF fonts, which cover Western European letters.</p>

        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!ready}>
            Add
          </button>
        </div>
      </form>
    </div>
  )
}
