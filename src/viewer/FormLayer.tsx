import { useState } from 'react'
import type { FieldValue, FormField } from '../engine/pdfium'

interface Props {
  fields: FormField[]
  zoom: number
  onChange: (field: FormField, value: FieldValue) => void
  /** A signature field was clicked: place a signature in it. */
  onSign: (field: FormField) => void
}

/**
 * HTML inputs over a page's form fields, so filling a form feels like any
 * web form: Tab moves between fields, typing is instant, and the browser's
 * own spell check and autofill work. Values go to the PDF on blur or change.
 */
export function FormLayer({ fields, zoom, onChange, onSign }: Props) {
  return (
    <div className="form-layer">
      {fields.map((f) => (
        <Field key={`${f.index}:${f.value}:${f.checked}`} f={f} zoom={zoom} onChange={onChange} onSign={onSign} />
      ))}
    </div>
  )
}

function Field({ f, zoom, onChange, onSign }: { f: FormField; zoom: number; onChange: Props['onChange']; onSign: Props['onSign'] }) {
  const [text, setText] = useState(f.value)
  // Shown at once; the saved state arrives with the next field list and re-keys this input.
  const [checked, setChecked] = useState(!!f.checked)
  const style: React.CSSProperties = {
    left: f.rect.x * zoom,
    top: f.rect.y * zoom,
    width: f.rect.width * zoom,
    height: f.rect.height * zoom,
    fontSize: Math.max(8, Math.min(f.multiline ? 12 : f.rect.height * 0.62, 14)) * zoom,
  }
  const label = f.label || f.name
  const common = {
    className: `field field-${f.type}${f.required ? ' required' : ''}`,
    style,
    title: label,
    'aria-label': label,
    disabled: f.readOnly,
    required: f.required,
  }
  const commitText = () => {
    if (text !== f.value) onChange(f, { text })
  }

  switch (f.type) {
    case 'text':
      return f.multiline ? (
        <textarea {...common} value={text} maxLength={f.maxLength} onChange={(e) => setText(e.target.value)} onBlur={commitText} />
      ) : (
        <input
          {...common}
          type={f.password ? 'password' : 'text'}
          value={text}
          maxLength={f.maxLength}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      )
    case 'checkbox':
    case 'radio':
      return (
        <input
          {...common}
          type={f.type}
          name={f.type === 'radio' ? f.name : undefined}
          checked={checked}
          onChange={(e) => {
            // A radio button can't be turned off by clicking it again.
            if (f.type === 'radio' && !e.target.checked) return
            setChecked(e.target.checked)
            onChange(f, { checked: e.target.checked })
          }}
        />
      )
    case 'combo':
    case 'list': {
      const selected = (f.options ?? []).flatMap((o, i) => (o.selected ? [String(i)] : []))
      return (
        <select
          {...common}
          multiple={f.multiSelect}
          size={f.type === 'list' ? Math.max(2, Math.floor(f.rect.height / 14)) : undefined}
          value={f.multiSelect ? selected : (selected[0] ?? '')}
          onChange={(e) => onChange(f, { selected: [...e.target.selectedOptions].map((o) => Number(o.value)) })}
        >
          {f.type === 'combo' && selected.length === 0 && <option value="">{f.value}</option>}
          {(f.options ?? []).map((o, i) => (
            <option key={i} value={String(i)}>
              {o.label}
            </option>
          ))}
        </select>
      )
    }
    case 'signature':
      return (
        <button {...common} className="field field-signature" onClick={() => onSign(f)}>
          Sign here
        </button>
      )
    default:
      return null
  }
}
