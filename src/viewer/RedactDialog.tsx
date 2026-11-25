import { useEffect } from 'react'

interface Props {
  marks: number
  pages: number
  onApply: () => void
  onCancel: () => void
}

/** Last check before redacting: what goes, and that it is for good once saved. */
export function RedactDialog({ marks, pages, onApply, onCancel }: Props) {
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
        aria-label="Apply redactions"
        onSubmit={(e) => {
          e.preventDefault()
          onApply()
        }}
      >
        <h2>Apply redactions</h2>
        <p>
          {marks} marked area{marks === 1 ? '' : 's'} on {pages} page{pages === 1 ? '' : 's'} will be blacked out, and what is underneath deleted from the
          file: text, the parts of pictures, drawings, comments and form fields.
        </p>
        <p className="hint">
          You can still undo until you save. In the saved copy the content is gone for good and can't be searched, copied or recovered.
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary danger" autoFocus>
            Redact
          </button>
        </div>
      </form>
    </div>
  )
}
