import { useEffect, useState } from 'react'
import type { SignatureCheck } from '../engine/sign'
import type { DocHandle } from './client'

interface Props {
  doc: DocHandle
  onError: (err: unknown) => void
}

const when = (iso?: string) =>
  iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'an unknown time'

const STATUS: Record<SignatureCheck['status'], string> = {
  valid: 'Valid',
  'changed-after': 'Valid, with later changes',
  invalid: 'Invalid',
  unknown: 'Not checked',
}

/**
 * The bar Acrobat shows on signed files: whether each signature still holds,
 * and who signed. A certificate is only as trustworthy as whoever issued it,
 * and PDF Pro has no list of trusted issuers yet, so identities are shown as
 * not verified.
 */
export function SignaturesBar({ doc, onError }: Props) {
  const [result, setResult] = useState<{ checks: SignatureCheck[]; edited: boolean } | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let live = true
    if (!doc.signatureCount) {
      setResult(null)
      return
    }
    doc.signatures().then(
      (r) => live && setResult(r),
      (err) => live && onError(err),
    )
    return () => {
      live = false
    }
  }, [doc, onError])

  if (!doc.signatureCount || !result) return null
  const { checks, edited } = result
  const bad = checks.some((c) => c.status === 'invalid')
  const tone = edited || bad ? 'warn' : 'ok'
  const summary = edited
    ? 'This file is signed, and you have edited it. Saving it will invalidate the signatures. Undo your edits to keep them.'
    : bad
      ? `At least one signature is invalid: the document changed after it was signed, or the signature is broken.`
      : checks.length === 1
        ? `Signed by ${checks[0].signer} on ${when(checks[0].time)}. ${checks[0].status === 'changed-after' ? 'The signed version is intact; changes were added afterwards.' : 'The document has not changed since it was signed.'}`
        : `Signed ${checks.length} times. Every signed version is intact.`

  return (
    <div className={`sig-bar sig-${tone}`} role="status">
      <span className="sig-icon" aria-hidden="true">
        {tone === 'ok' ? '✓' : '!'}
      </span>
      <span className="sig-summary">{summary}</span>
      {checks.length > 0 && (
        <button className="link" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide signatures' : 'Signature details'}
        </button>
      )}
      {open && (
        <ol className="sig-list">
          {checks.map((c, i) => (
            <li key={i}>
              <strong>{c.signer}</strong> <span className={`sig-status sig-status-${c.status}`}>{STATUS[c.status]}</span>
              <div className="hint">
                Signed {when(c.time)}
                {c.reason ? ` · Reason: ${c.reason}` : ''}
                {` · ${c.subFilter}`}
              </div>
              {c.detail && <div className="hint">{c.detail}</div>}
              <div className="hint">
                {c.selfSigned
                  ? "Identity not verified: the signer issued this certificate to themselves, so nobody vouches for the name on it."
                  : "Identity not verified: PDF Pro doesn't check certificates against a list of trusted issuers yet."}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
