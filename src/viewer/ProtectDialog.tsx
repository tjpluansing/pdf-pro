import { useEffect, useState } from 'react'
import type { Permissions } from '../engine/pdfium'

interface Props {
  /** Current restrictions, shown as the starting point. */
  permissions: Permissions
  onApply: (openPassword: string, ownerPassword: string, permissions: Permissions) => void
  onCancel: () => void
}

const LABELS: Record<keyof Permissions, string> = {
  print: 'Printing',
  copy: 'Copying text and images',
  edit: 'Changing pages and content',
  comment: 'Comments and filling in forms',
}

/** Set an open password, restrictions, and the permissions password that lifts them. */
export function ProtectDialog({ permissions, onApply, onCancel }: Props) {
  const [open, setOpen] = useState('')
  const [open2, setOpen2] = useState('')
  const [owner, setOwner] = useState('')
  const [allow, setAllow] = useState(permissions)
  const restricted = Object.values(allow).some((v) => !v)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const problem =
    open !== open2
      ? 'The open passwords do not match'
      : restricted && !owner
        ? 'Set a permissions password, or the restrictions could not be lifted'
        : owner && owner === open
          ? 'Use a different permissions password from the open password'
          : !open && !owner
            ? 'Set an open password, restrictions, or both'
            : null

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="dialog stamp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Protect with a password"
        onSubmit={(e) => {
          e.preventDefault()
          if (!problem) onApply(open, owner, allow)
        }}
      >
        <h2>Protect with a password</h2>
        <fieldset>
          <legend>Open password</legend>
          <p className="hint">Needed to open the file. Leave blank to let anyone open it.</p>
          <div className="row">
            <label>
              Password
              <input type="password" autoFocus autoComplete="new-password" value={open} onChange={(e) => setOpen(e.target.value)} />
            </label>
            <label>
              Again
              <input type="password" autoComplete="new-password" value={open2} onChange={(e) => setOpen2(e.target.value)} />
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Restrictions</legend>
          <p className="hint">What people who open the file may do. The permissions password lifts these.</p>
          {(Object.keys(LABELS) as (keyof Permissions)[]).map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={allow[k]} onChange={(e) => setAllow({ ...allow, [k]: e.target.checked })} /> Allow{' '}
              {LABELS[k].toLowerCase()}
            </label>
          ))}
          <label>
            Permissions password
            <input type="password" autoComplete="new-password" value={owner} onChange={(e) => setOwner(e.target.value)} />
          </label>
        </fieldset>
        <p className="hint">
          Encrypted with AES-256. Write the passwords down: PDF Pro can't recover them. Restrictions are honoured by most PDF apps but are not a
          guarantee.
        </p>
        {problem && (open || open2 || owner || restricted) && <p className="hint error-text">{problem}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!!problem}>
            Protect
          </button>
        </div>
      </form>
    </div>
  )
}
