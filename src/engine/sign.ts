/**
 * Digital signatures with a certificate (a .p12 or .pfx file), the way
 * Acrobat's "Use a certificate" signs, and checking the signatures a file
 * already has.
 *
 * Signing appends an incremental update to the file instead of rewriting
 * it, so earlier signatures stay valid: a signature field and its
 * appearance, then a CMS signature (adbe.pkcs7.detached, SHA-256) over
 * every byte of the file except the signature itself.
 */
import forge from 'node-forge'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFObject } from 'pdf-lib'

/** Bytes reserved for the signature; a certificate chain of a few certificates fits easily. */
const SIGNATURE_BYTES = 16384

export interface Signer {
  /** The certificate's common name, or its organisation. */
  name: string
  /** CMS signature over `data`, as DER bytes. */
  sign(data: Uint8Array, time: Date): Uint8Array
}

export class SignError extends Error {}

/** Opens a .p12/.pfx file. Throws SignError when the password is wrong or there is no usable key. */
export function signerFromP12(p12: Uint8Array, password: string): Signer {
  let parsed: forge.pkcs12.Pkcs12Pfx
  try {
    parsed = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(binary(p12)), false, password)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (/MAC|password|decrypt/i.test(msg)) throw new SignError('The certificate password is not right.')
    throw new SignError('This is not a certificate file PDF Pro can read. Use a .p12 or .pfx file that holds your certificate and private key.')
  }
  const keyBags = [
    ...(parsed.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(parsed.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ]
  const key = keyBags.find((b) => b.key)?.key as forge.pki.rsa.PrivateKey | undefined
  if (!key) throw new SignError('This certificate file has no private key, or uses a key type other than RSA, so it cannot sign.')
  const certs = (parsed.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c)
  // The signing certificate is the one whose public key matches the private key.
  const cert = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.equals(key.n))
  if (!cert) throw new SignError('This certificate file has no certificate for its private key.')
  const now = new Date()
  if (now < cert.validity.notBefore || now > cert.validity.notAfter) {
    throw new SignError(`This certificate is only valid from ${day(cert.validity.notBefore)} to ${day(cert.validity.notAfter)}.`)
  }
  return {
    name: certName(cert),
    sign(data, time) {
      const p7 = forge.pkcs7.createSignedData()
      p7.content = forge.util.createBuffer(binary(data))
      p7.addCertificate(cert)
      for (const c of certs) if (c !== cert) p7.addCertificate(c)
      p7.addSigner({
        key,
        certificate: cert,
        digestAlgorithm: forge.pki.oids.sha256,
        authenticatedAttributes: [
          { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
          { type: forge.pki.oids.messageDigest },
          // forge's typings say string, but it takes a Date.
          { type: forge.pki.oids.signingTime, value: time as unknown as string },
        ],
      })
      p7.sign({ detached: true })
      return bytesOf(forge.asn1.toDer(p7.toAsn1()).getBytes())
    },
  }
}

export interface SignOptions {
  pageIndex: number
  /** Where the signature shows, in PDF user space (left, bottom, right, top); omit for an invisible signature. */
  rect?: [number, number, number, number]
  reason?: string
  location?: string
  /** For tests. */
  time?: Date
}

/** Signs the file. `bytes` must be the file exactly as it is to be kept. */
export async function signPdf(bytes: Uint8Array, signer: Signer, options: SignOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
  const ctx = doc.context
  if (ctx.trailerInfo.Encrypt) throw new SignError('Remove the password protection before signing (Tools).')
  const prev = lastStartXref(bytes)
  const usesXrefStream = !ascii(bytes, prev, 4).startsWith('xref')
  const time = options.time ?? new Date()

  // pdf-lib does not count cross-reference and object streams, so take the trailer's /Size too.
  let next = Math.max(ctx.largestObjectNumber + 1, trailerSize(bytes, prev))
  const alloc = () => PDFRef.of(next++)
  const out = new Writer(bytes)
  const offsets = new Map<number, { offset: number; gen: number }>()
  const writeObject = (ref: PDFRef, body: string | Uint8Array) => {
    offsets.set(ref.objectNumber, { offset: out.length, gen: ref.generationNumber })
    out.text(`${ref.objectNumber} ${ref.generationNumber} obj\n`)
    if (typeof body === 'string') out.text(body)
    else out.bytes(body)
    out.text('\nendobj\n')
  }

  const fieldName = uniqueFieldName(doc)
  const page = doc.getPage(options.pageIndex)
  const sigRef = alloc()
  const widgetRef = alloc()

  // The signature value: placeholders for the byte range and the signature, filled in at the end.
  const placeholder = '0'.repeat(SIGNATURE_BYTES * 2)
  const sigDict =
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached ` +
    `/ByteRange [0 ${RANGE_SLOT} ${RANGE_SLOT} ${RANGE_SLOT}] /Contents <${placeholder}> ` +
    `/M ${pdfString(pdfDate(time))} /Name ${pdfString(signer.name)}` +
    (options.reason ? ` /Reason ${pdfString(options.reason)}` : '') +
    (options.location ? ` /Location ${pdfString(options.location)}` : '') +
    ` >>`

  // The visible part: a widget on the page with a drawn appearance.
  const rect = options.rect ?? [0, 0, 0, 0]
  let ap = ''
  if (options.rect) {
    const apRef = alloc()
    const fontRef = alloc()
    const [x0, y0, x1, y1] = rect
    const content = appearance(x1 - x0, y1 - y0, signer.name, time, options.reason)
    writeObject(fontRef, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
    writeObject(
      apRef,
      concat(
        enc(`<< /Type /XObject /Subtype /Form /BBox [0 0 ${num(x1 - x0)} ${num(y1 - y0)}] /Resources << /Font << /Helv ${fontRef} >> >> /Length ${content.length} >>\nstream\n`),
        content,
        enc('\nendstream'),
      ),
    )
    ap = ` /AP << /N ${apRef} >>`
  }
  writeObject(
    widgetRef,
    `<< /Type /Annot /Subtype /Widget /FT /Sig /T ${pdfString(fieldName)} /V ${sigRef} /F 132 /P ${page.ref} /Rect [${rect.map(num).join(' ')}]${ap} >>`,
  )

  // Add the widget to the page's annotations and the field to the form.
  const changed = new Map<string, { ref: PDFRef; obj: PDFObject }>()
  const touch = (ref: PDFRef, obj: PDFObject) => changed.set(ref.tag, { ref, obj })
  appendTo(ctx, page.node, PDFName.of('Annots'), widgetRef, page.ref, touch)
  const catalogRef = ctx.trailerInfo.Root as PDFRef
  const catalog = doc.catalog
  const formEntry = catalog.get(PDFName.of('AcroForm'))
  let form: PDFDict
  let formOwner: PDFRef
  if (formEntry instanceof PDFRef) {
    form = ctx.lookup(formEntry, PDFDict)
    formOwner = formEntry
  } else if (formEntry instanceof PDFDict) {
    form = formEntry
    formOwner = catalogRef
  } else {
    form = ctx.obj({}) as PDFDict
    catalog.set(PDFName.of('AcroForm'), form)
    formOwner = catalogRef
  }
  form.set(PDFName.of('SigFlags'), PDFNumber.of(3))
  touch(formOwner, ctx.lookup(formOwner)!)
  appendTo(ctx, form, PDFName.of('Fields'), widgetRef, formOwner, touch)

  const sigOffset = out.length
  writeObject(sigRef, sigDict)
  for (const { ref, obj } of changed.values()) writeObject(ref, obj.toString())

  // Cross-reference section for the new and changed objects, pointing back to the last one.
  const trailer = [`/Root ${catalogRef}`]
  if (ctx.trailerInfo.Info) trailer.push(`/Info ${ctx.trailerInfo.Info}`)
  if (ctx.trailerInfo.ID) trailer.push(`/ID ${ctx.trailerInfo.ID}`)
  trailer.push(`/Prev ${prev}`)
  let xrefAt: number
  if (usesXrefStream) {
    const xrefRef = alloc()
    xrefAt = out.length
    offsets.set(xrefRef.objectNumber, { offset: xrefAt, gen: 0 })
    const nums = [...offsets.keys()].sort((a, b) => a - b)
    const data = new Uint8Array(nums.length * 7)
    nums.forEach((n, i) => {
      const { offset, gen } = offsets.get(n)!
      data[i * 7] = 1
      for (let b = 0; b < 4; b++) data[i * 7 + 1 + b] = (offset >>> (8 * (3 - b))) & 0xff
      data[i * 7 + 5] = (gen >> 8) & 0xff
      data[i * 7 + 6] = gen & 0xff
    })
    out.text(`${xrefRef.objectNumber} 0 obj\n<< /Type /XRef /Size ${next} /W [1 4 2] /Index [${nums.map((n) => `${n} 1`).join(' ')}] ${trailer.join(' ')} /Length ${data.length} >>\nstream\n`)
    out.bytes(data)
    out.text('\nendstream\nendobj\n')
  } else {
    xrefAt = out.length
    const nums = [...offsets.keys()].sort((a, b) => a - b)
    out.text('xref\n')
    for (const n of nums) {
      const { offset, gen } = offsets.get(n)!
      out.text(`${n} 1\n${String(offset).padStart(10, '0')} ${String(gen).padStart(5, '0')} n\r\n`)
    }
    out.text(`trailer\n<< /Size ${next} ${trailer.join(' ')} >>\n`)
  }
  out.text(`startxref\n${xrefAt}\n%%EOF\n`)

  // Fill in the byte range, then sign everything but the signature's own hex string.
  const file = out.finish()
  const contentsStart = indexOf(file, enc(`/Contents <${placeholder.slice(0, 16)}`), sigOffset) + '/Contents '.length
  const contentsEnd = contentsStart + placeholder.length + 2
  const range = [0, contentsStart, contentsEnd, file.length - contentsEnd]
  const rangeAt = indexOf(file, enc(`/ByteRange [0 ${RANGE_SLOT}`), sigOffset) + '/ByteRange ['.length
  file.set(enc(`0 ${range.slice(1).map((n) => String(n).padEnd(RANGE_SLOT.length, ' ')).join(' ')}`), rangeAt)

  const signed = concat(file.subarray(0, contentsStart), file.subarray(contentsEnd))
  const cms = signer.sign(signed, time)
  if (cms.length > SIGNATURE_BYTES) throw new SignError('The certificate chain is too large to fit in the signature.')
  file.set(enc(hex(cms)), contentsStart + 1)
  return file
}

/** Width of each byte-range number slot; ten digits covers files up to 9 GB. */
const RANGE_SLOT = '0000000000'

/** Adds `item` to the array at dict[key], making the array if needed and recording what changed. */
function appendTo(
  ctx: PDFDocument['context'],
  dict: PDFDict,
  key: PDFName,
  item: PDFRef,
  owner: PDFRef,
  touch: (ref: PDFRef, obj: PDFObject) => void,
) {
  const entry = dict.get(key)
  if (entry instanceof PDFRef) {
    const arr = ctx.lookup(entry, PDFArray)
    arr.push(item)
    touch(entry, arr)
    return
  }
  if (entry instanceof PDFArray) entry.push(item)
  else dict.set(key, ctx.obj([item]))
  touch(owner, ctx.lookup(owner)!)
}

/** Signature1, Signature2…, whichever is free. Reads the form directly: pdf-lib's getForm() would add objects. */
function uniqueFieldName(doc: PDFDocument): string {
  const ctx = doc.context
  const taken = new Set<string>()
  const seen = new Set<PDFObject>()
  const walk = (obj: PDFObject | undefined, prefix: string) => {
    const dict = obj instanceof PDFRef ? ctx.lookup(obj) : obj
    if (!(dict instanceof PDFDict) || seen.has(dict)) return
    seen.add(dict)
    const t = dict.lookup(PDFName.of('T'))
    const name = t instanceof PDFString || t instanceof PDFHexString ? prefix + t.decodeText() : prefix
    if (name) taken.add(name)
    const kids = dict.lookup(PDFName.of('Kids'))
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), name ? `${name}.` : '')
  }
  const form = doc.catalog.lookup(PDFName.of('AcroForm'))
  const fields = form instanceof PDFDict ? form.lookup(PDFName.of('Fields')) : undefined
  if (fields instanceof PDFArray) for (let i = 0; i < fields.size(); i++) walk(fields.get(i), '')
  let i = 1
  while (taken.has(`Signature${i}`)) i++
  return `Signature${i}`
}

/** Text drawn in the signature box: who signed, when, and why. */
function appearance(width: number, height: number, name: string, time: Date, reason?: string): Uint8Array {
  const lines = [`Digitally signed by ${name}`, `Date: ${time.toISOString().slice(0, 16).replace('T', ' ')} UTC`]
  if (reason) lines.push(`Reason: ${reason}`)
  const size = Math.max(5, Math.min(11, height / (lines.length * 1.35 + 0.6), ...lines.map((l) => (width - 8) / (l.length * 0.55))))
  const lead = size * 1.3
  let y = height - 4 - size
  const ops = ['q', '0.2 0.35 0.75 RG 1 w', `0.5 0.5 ${num(width - 1)} ${num(height - 1)} re S`, 'BT', `/Helv ${num(size)} Tf`, '0.1 0.1 0.1 rg']
  for (const line of lines) {
    ops.push(`1 0 0 1 4 ${num(y)} Tm ${pdfString(winAnsi(line))} Tj`)
    y -= lead
  }
  ops.push('ET', 'Q')
  return latin1(ops.join('\n'))
}

// ---------- checking signatures ----------

export type SignatureStatus =
  /** The signed bytes are unchanged and the signature matches the signer's certificate. */
  | 'valid'
  /** Valid, but the file was changed after this signature (later updates were appended). */
  | 'changed-after'
  /** The signed bytes were altered, or the signature does not match. */
  | 'invalid'
  /** A kind of signature PDF Pro cannot check, such as ECDSA. */
  | 'unknown'

export interface SignatureCheck {
  status: SignatureStatus
  signer: string
  /** When the signer says they signed, as an ISO date. */
  time?: string
  reason?: string
  subFilter: string
  /** Why the status is not 'valid', in a sentence. */
  detail?: string
  /** The signer's certificate is its own issuer, so nobody vouches for who it names. */
  selfSigned: boolean
}

const DIGESTS: Record<string, () => forge.md.MessageDigest> = {
  [forge.pki.oids.sha1]: () => forge.md.sha1.create(),
  [forge.pki.oids.sha256]: () => forge.md.sha256.create(),
  [forge.pki.oids.sha384]: () => forge.md.sha384.create(),
  [forge.pki.oids.sha512]: () => forge.md.sha512.create(),
}

/** Checks one signature against the bytes of the file as it was opened. */
export function checkSignature(file: Uint8Array, byteRange: number[], contents: Uint8Array, subFilter: string, reason?: string, pdfTime?: string): SignatureCheck {
  const base = { signer: 'Unknown signer', subFilter, reason, time: pdfTime, selfSigned: false }
  if (byteRange.length !== 4 || byteRange[0] !== 0) return { ...base, status: 'invalid', detail: 'The signature does not cover the start of the file.' }
  const [, len1, start2, len2] = byteRange
  if (start2 + len2 > file.length || len1 > start2) return { ...base, status: 'invalid', detail: 'The signature points past the end of the file.' }
  if (!/pkcs7|CAdES/i.test(subFilter)) return { ...base, status: 'unknown', detail: `PDF Pro cannot check ${subFilter} signatures yet.` }

  let msg: ReturnType<typeof forge.pkcs7.messageFromAsn1>
  try {
    msg = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(binary(berToDer(contents))))
  } catch {
    return { ...base, status: 'unknown', detail: 'The signature uses a key type or format PDF Pro cannot read yet.' }
  }
  const signed = msg as unknown as {
    certificates: forge.pki.Certificate[]
    rawCapture: { signature: string; authenticatedAttributes?: forge.asn1.Asn1[]; digestAlgorithm: string }
  }
  const raw = signed.rawCapture
  const digestOid = forge.asn1.derToOid(raw.digestAlgorithm)
  const md = DIGESTS[digestOid]
  if (!md || !raw.authenticatedAttributes) return { ...base, status: 'unknown', detail: 'The signature uses a hash or layout PDF Pro cannot check yet.' }

  // The hash of the signed bytes must match the one inside the signature...
  const content = md()
  content.update(binary(file.subarray(0, len1)))
  content.update(binary(file.subarray(start2, start2 + len2)))
  let claimed: string | undefined
  let signingTime: string | undefined
  for (const attr of raw.authenticatedAttributes) {
    const [oid, values] = attr.value as forge.asn1.Asn1[]
    const type = forge.asn1.derToOid(oid.value as string)
    const first = (values.value as forge.asn1.Asn1[])[0]
    if (type === forge.pki.oids.messageDigest) claimed = first.value as string
    if (type === forge.pki.oids.signingTime) {
      try {
        signingTime = (first.type === forge.asn1.Type.UTCTIME ? forge.asn1.utcTimeToDate(first.value as string) : forge.asn1.generalizedTimeToDate(first.value as string)).toISOString()
      } catch {
        // Keep the time from the signature dictionary instead.
      }
    }
  }
  // ...and the signature over those attributes must verify with a certificate inside it.
  const attrs = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, raw.authenticatedAttributes)
  const attrDigest = md()
  attrDigest.update(forge.asn1.toDer(attrs).getBytes())
  const cert = signed.certificates.find((c) => {
    try {
      return (c.publicKey as forge.pki.rsa.PublicKey).verify(attrDigest.digest().getBytes(), raw.signature)
    } catch {
      return false
    }
  })
  const result = {
    ...base,
    signer: cert ? certName(cert) : signed.certificates[0] ? certName(signed.certificates[0]) : base.signer,
    time: signingTime ?? pdfTime,
    selfSigned: !!cert && cert.isIssuer(cert),
  }
  if (claimed !== content.digest().getBytes()) return { ...result, status: 'invalid', detail: 'The document was altered after it was signed.' }
  if (!cert) return { ...result, status: 'invalid', detail: 'The signature does not match the certificate it carries.' }
  if (start2 + len2 < file.length) return { ...result, status: 'changed-after', detail: 'The signed version is intact, but the file has had changes added since it was signed.' }
  return { ...result, status: 'valid' }
}

// ---------- helpers ----------

function certName(cert: forge.pki.Certificate): string {
  const get = (name: string) => cert.subject.getField(name)?.value as string | undefined
  return get('CN') ?? get('O') ?? get('E') ?? 'Unknown signer'
}

function lastStartXref(bytes: Uint8Array): number {
  const tail = ascii(bytes, Math.max(0, bytes.length - 2048), 2048)
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail) ?? [...tail.matchAll(/startxref\s+(\d+)/g)].pop()
  if (!m) throw new SignError('This file has no cross-reference table PDF Pro can append to. Save a copy first, then sign the copy.')
  return Number(m[1])
}

/** /Size of the last cross-reference section: one more than its highest object number. */
function trailerSize(bytes: Uint8Array, at: number): number {
  const section = String.fromCharCode(...bytes.subarray(at, Math.min(bytes.length, at + 4096)))
  const tail = section.startsWith('xref') ? ascii(bytes, Math.max(at, bytes.length - 4096), 4096) : section
  const m = /\/Size\s+(\d+)/.exec(tail)
  return m ? Number(m[1]) : 0
}

class Writer {
  private chunks: Uint8Array[] = []
  length = 0
  constructor(start: Uint8Array) {
    this.bytes(start)
    if (start[start.length - 1] !== 0x0a && start[start.length - 1] !== 0x0d) this.text('\n')
  }
  text(s: string) {
    this.bytes(latin1(s))
  }
  bytes(b: Uint8Array) {
    this.chunks.push(b)
    this.length += b.length
  }
  finish(): Uint8Array {
    return concat(...this.chunks)
  }
}

const enc = (s: string) => latin1(s)

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length))
}

function binary(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return s
}

function bytesOf(s: string): Uint8Array {
  return latin1(s)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  throw new SignError('Could not place the signature in the file.')
}

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/**
 * The first BER element of `b` (signature contents are zero-padded to their
 * reserved size) as DER. Some signers, NSS among them, write indefinite
 * lengths, which forge's parser does not accept.
 */
export function berToDer(b: Uint8Array): Uint8Array {
  const parse = (at: number): { der: Uint8Array; end: number } => {
    const start = at
    const tag = b[at++]
    if ((tag & 0x1f) === 0x1f) while (b[at++] & 0x80); // multi-byte tag
    const tagBytes = b.subarray(start, at)
    const constructed = (tag & 0x20) !== 0
    let len = b[at++]
    if (len === 0x80) {
      if (!constructed) throw new SignError('Malformed signature.')
      const kids: Uint8Array[] = []
      while (!(b[at] === 0 && b[at + 1] === 0)) {
        if (at >= b.length) throw new SignError('Malformed signature.')
        const k = parse(at)
        kids.push(k.der)
        at = k.end
      }
      return { der: tlv(tagBytes, concat(...kids)), end: at + 2 }
    }
    if (len & 0x80) {
      const n = len & 0x7f
      len = 0
      for (let i = 0; i < n; i++) len = len * 256 + b[at++]
    }
    const end = at + len
    if (end > b.length) throw new SignError('Malformed signature.')
    if (!constructed) return { der: b.subarray(start, end), end }
    const kids: Uint8Array[] = []
    for (let p = at; p < end; ) {
      const k = parse(p)
      kids.push(k.der)
      p = k.end
    }
    return { der: tlv(tagBytes, concat(...kids)), end }
  }
  return parse(0).der
}

function tlv(tag: Uint8Array, value: Uint8Array): Uint8Array {
  const n = value.length
  let len: number[]
  if (n < 0x80) len = [n]
  else {
    const bytes: number[] = []
    for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff)
    len = [0x80 | bytes.length, ...bytes]
  }
  return concat(tag, Uint8Array.from(len), value)
}

/** A PDF literal string; text outside Latin-1 is written as UTF-16 so names in any script survive. */
function pdfString(s: string): string {
  if ([...s].every((c) => c.charCodeAt(0) < 256)) return PDFString.of(s.replace(/[\\()]/g, '\\$&')).toString()
  let h = 'feff'
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, '0')
  return `<${h}>`
}

/** Drops characters Helvetica's WinAnsi encoding cannot show. */
function winAnsi(s: string): string {
  return [...s].map((c) => (c.charCodeAt(0) < 256 ? c : '?')).join('')
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

const num = (n: number) => (Math.round(n * 100) / 100).toString()
const day = (d: Date) => d.toISOString().slice(0, 10)
