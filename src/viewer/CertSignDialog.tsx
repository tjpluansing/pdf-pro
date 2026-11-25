import { useEffect, useState } from 'react'

export interface CertSignRequest {
  p12: Uint8Array
  fileName: string
  password: string
  reason: string
  location: string
  /** Show a signature box on the page; when false the signature is invisible. */
  visible: boolean
}

interface Props {
  /** Shown when the last attempt failed, e.g. a wrong password. */
  error?: string | null
  /** The certificate from the last attempt, so a retry only needs the password. */
  last?: CertSignRequest | null
  signed: number
  onSign: (req: CertSignRequest) => void
  onCancel: () => void
}

const REASON_KEY = 'pdfpro.signReason'
const LOCATION_KEY = 'pdfpro.signLocation'

function stored(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

/** Signing with a certificate file, as Acrobat's "Use a certificate" does. */
export function CertSignDialog({ error, last, signed, onSign, onCancel }: Props) {
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(last ? { name: last.fileName, bytes: last.p12 } : null)
  const [password, setPassword] = useState('')
  const [reason, setReason] = useState(() => last?.reason ?? stored(REASON_KEY))
  const [location, setLocation] = useState(() => last?.location ?? stored(LOCATION_KEY))
  const [visible, setVisible] = useState(last?.visible ?? true)

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
        aria-label="Sign with a certificate"
        onSubmit={(e) => {
          e.preventDefault()
          if (!file) return
          try {
            localStorage.setItem(REASON_KEY, reason)
            localStorage.setItem(LOCATION_KEY, location)
          } catch {
            // Only a convenience for next time.
          }
          onSign({ p12: file.bytes, fileName: file.name, password, reason: reason.trim(), location: location.trim(), visible })
        }}
      >
        <h2>Sign with a certificate</h2>
        <p className="hint">
          A certificate signature proves who signed and shows if the file changes afterwards. Choose your digital ID: a .p12 or .pfx file from your
          organisation or a certificate authority. It stays on this device.
        </p>
        {signed > 0 && <p className="hint">This file already has {signed === 1 ? 'a signature' : `${signed} signatures`}. Signing adds yours without changing them.</p>}
        <label>
          Digital ID file
          <input
            type="file"
            accept=".p12,.pfx,application/x-pkcs12"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (f) setFile({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })
            }}
          />
          {file && <span className="hint">{file.name}</span>}
        </label>
        <label>
          Password
          <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!!last} />
        </label>
        <label>
          Reason (optional)
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="I approve this document" />
        </label>
        <label>
          Location (optional)
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="City" />
        </label>
        <label className="check">
          <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
          Show the signature on the page
        </label>
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!file}>
            {visible ? 'Next: place signature' : 'Sign'}
          </button>
        </div>
      </form>
    </div>
  )
}
