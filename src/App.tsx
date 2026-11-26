import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PdfError, type Annotation, type NewAnnotation, type OutlineItem, type Point, type Rect, type SearchHit, type TextLayout, type TextLine } from './engine/pdfium'
import { AnnotLayer, MARKUP_TOOLS, type MarkupTool, type TextSelection, type Tool } from './viewer/AnnotLayer'
import { CommentsPanel } from './viewer/CommentsPanel'
import { FormLayer } from './viewer/FormLayer'
import { SignatureDialog } from './viewer/SignatureDialog'
import { savedSignature, signaturePixels, type SignatureKind } from './viewer/signature'
import type { FieldValue, FormField } from './engine/pdfium'
import { EngineClient, type DocHandle } from './viewer/client'
import { Organize } from './viewer/Organize'
import { PageCanvas } from './viewer/PageCanvas'
import { CompressDialog } from './viewer/CompressDialog'
import { recognizePages } from './viewer/recognize'
import { ProtectDialog } from './viewer/ProtectDialog'
import { StampDialog, type StampKind } from './viewer/StampDialog'
import type { CompressOptions, PageText, PageTextKind, PageTextOptions, Permissions } from './engine/pdfium'
import type { Edit } from './viewer/protocol'
import { UpdateBanner } from './viewer/UpdateBanner'
import { OFFICE_EXTENSIONS, convertFile, isDesktop, isOfficeFile, saveCopy, withExtension } from './viewer/platform'
import { printDocument } from './viewer/print'
import { RedactLayer, type RedactMark } from './viewer/RedactLayer'
import { RedactDialog } from './viewer/RedactDialog'
import { EditTextLayer } from './viewer/EditTextLayer'
import { CompareView } from './viewer/CompareView'
import { CertSignDialog, type CertSignRequest } from './viewer/CertSignDialog'
import { SignaturesBar } from './viewer/SignaturesBar'

// The assistant brings in the Claude SDK, so it loads the first time it is opened.
const AssistantPanel = lazy(() => import('./viewer/AssistantPanel').then((m) => ({ default: m.AssistantPanel })))

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: 'select', label: 'Select', key: 'v' },
  { tool: 'highlight', label: 'Highlight', key: 'h' },
  { tool: 'underline', label: 'Underline', key: 'u' },
  { tool: 'strikeout', label: 'Strikethrough', key: 'k' },
  { tool: 'note', label: 'Note', key: 'n' },
  { tool: 'freetext', label: 'Text box', key: 't' },
  { tool: 'ink', label: 'Draw', key: 'd' },
  { tool: 'square', label: 'Rectangle', key: 'r' },
  { tool: 'circle', label: 'Ellipse', key: 'e' },
  { tool: 'arrow', label: 'Arrow', key: 'a' },
  { tool: 'line', label: 'Line', key: 'l' },
]
const SIGN_TOOLS: { tool: Tool; label: string }[] = [
  { tool: 'select', label: 'Select' },
  { tool: 'freetext', label: 'Text' },
  { tool: 'check', label: '✓ Check' },
  { tool: 'cross', label: '✗ Cross' },
  { tool: 'date', label: 'Date' },
  { tool: 'signature', label: 'Signature' },
  { tool: 'initials', label: 'Initials' },
]
const SWATCHES = ['#ffd400', '#5fc35f', '#2a7ae2', '#d93025', '#1d1d1b']
const DEFAULT_COLORS: Record<Tool, string> = {
  select: '#ffd400',
  highlight: '#ffd400',
  underline: '#2a7ae2',
  strikeout: '#d93025',
  note: '#ffd400',
  freetext: '#1d1d1b',
  ink: '#d93025',
  square: '#d93025',
  circle: '#d93025',
  arrow: '#d93025',
  line: '#d93025',
  check: '#1d1d1b',
  cross: '#1d1d1b',
  date: '#1d1d1b',
  signature: '#1d1d1b',
  initials: '#1d1d1b',
}
const AUTHOR_KEY = 'pdfpro.author'

function storedAuthor(): string {
  try {
    return localStorage.getItem(AUTHOR_KEY) ?? ''
  } catch {
    return ''
  }
}

const typingIn = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
const THUMB_WIDTH = 120
const PAGE_GAP = 16

type Fit = 'width' | 'page' | null

function describeError(err: unknown): string {
  if (err instanceof PdfError) {
    switch (err.code) {
      case 'format':
      case 'file':
        return 'This file is damaged or is not a PDF.'
      case 'crash':
        return 'The PDF engine hit an internal error on this file. It has been restarted; please try another file.'
      default:
        return err.message
    }
  }
  return err instanceof Error ? err.message : String(err)
}

export default function App() {
  const [engine] = useState(() => new EngineClient())
  const [doc, setDoc] = useState<DocHandle | null>(null)
  const [locked, setLocked] = useState<{ name: string; bytes: Uint8Array; wrong: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState<Fit>('width')
  const [currentPage, setCurrentPage] = useState(0)
  const [sidebar, setSidebar] = useState<'pages' | 'outline'>('pages')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [activeHit, setActiveHit] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [mode, setMode] = useState<'view' | 'comment' | 'sign' | 'edit' | 'tools' | 'redact' | 'organize'>('view')
  const [signTool, setSignTool] = useState<Tool>('freetext')
  const [signColor, setSignColor] = useState('#1d1d1b')
  const [fields, setFields] = useState<FormField[] | null>(null)
  /** Where to put a signature once the user has made one. */
  const [signing, setSigning] = useState<{ kind: SignatureKind; place?: { pageIndex: number; at?: Point; fit?: Rect } } | null>(null)
  const [stamp, setStamp] = useState<StampKind | null>(null)
  const [protecting, setProtecting] = useState(false)
  const [compressing, setCompressing] = useState(false)
  const [redactMarks, setRedactMarks] = useState<RedactMark[]>([])
  const [confirmRedact, setConfirmRedact] = useState(false)
  /** The other version, while comparing the open file with it. */
  const [assistantOpen, setAssistantOpen] = useState(false)
  /** The certificate dialog, with the error from the last attempt. */
  const [certDialog, setCertDialog] = useState<{ error?: string } | null>(null)
  /** A certificate signature waiting for the user to click where it goes. */
  const [certPlacing, setCertPlacing] = useState<CertSignRequest | null>(null)
  const [certLast, setCertLast] = useState<CertSignRequest | null>(null)
  const [comparing, setComparing] = useState<{ older: DocHandle; name: string } | null>(null)
  const [pageTextKinds, setPageTextKinds] = useState<PageTextKind[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [colors, setColors] = useState(DEFAULT_COLORS)
  const [annots, setAnnots] = useState<Annotation[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [textSel, setTextSel] = useState<TextSelection | null>(null)
  const [author, setAuthor] = useState(storedAuthor)
  /** doc.version at the last open or save; anything newer is unsaved. */
  const [savedVersion, setSavedVersion] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const searchBox = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const compareInput = useRef<HTMLInputElement>(null)

  // Close the old document when another file replaces it or the app unmounts.
  // Edits hand back a new handle for the same document, which must stay open.
  const docId = doc?.id
  const docRef = useRef(doc)
  docRef.current = doc
  useEffect(() => {
    const opened = docRef.current
    return () => opened?.close()
  }, [docId])

  const dirty = !!doc && doc.version !== savedVersion

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const handleEngineError = useCallback((err: unknown) => {
    setError(describeError(err))
    // The worker restarts PDFium by itself after a crash; the open document is gone.
    if (err instanceof PdfError && err.code === 'crash') setDoc(null)
  }, [])

  const openBytes = useCallback(
    async (name: string, bytes: Uint8Array, password = '') => {
      setBusy('Opening…')
      try {
        const next = await engine.open(bytes, password)
        setError(null)
        setLocked(null)
        setFile({ name, bytes })
        setDoc(next)
        setSavedVersion(next.version)
        setHits([])
        setAnnots(null)
        setFields(null)
        setSelectedId(null)
        setTextSel(null)
        setQuery('')
        setRedactMarks([])
        setComparing((c) => {
          c?.older.close()
          return null
        })
        setCurrentPage(0)
        setFit('width')
        scroller.current?.scrollTo({ top: 0 })
      } catch (err) {
        if (err instanceof PdfError && err.code === 'password') setLocked({ name, bytes, wrong: password !== '' })
        else handleEngineError(err)
      } finally {
        setBusy(null)
      }
    },
    [engine, handleEngineError],
  )

  const openFile = useCallback(
    async (f: File) => {
      const bytes = new Uint8Array(await f.arrayBuffer())
      if (!isOfficeFile(f.name)) return openBytes(f.name, bytes)
      if (!isDesktop) {
        setError(`${f.name} is an Office file. Converting Word, Excel and PowerPoint files to PDF needs the PDF Pro desktop app.`)
        return
      }
      setBusy(`Converting ${f.name} to PDF…`)
      try {
        const pdf = await convertFile(f.name, bytes, 'pdf')
        await openBytes(withExtension(f.name, 'pdf'), pdf)
      } catch (err) {
        setError(describeError(err))
        setBusy(null)
      }
    },
    [openBytes],
  )

  const outline: OutlineItem[] = doc?.outline ?? []

  // Fit modes recompute the zoom from the widest page and the scroller size.
  useEffect(() => {
    const el = scroller.current
    if (!doc || !fit || !el) return
    const apply = () => {
      const first = doc.sizes[0]
      if (!first) return
      const availW = el.clientWidth - 2 * PAGE_GAP
      const availH = el.clientHeight - 2 * PAGE_GAP
      const z = fit === 'width' ? availW / first.width : Math.min(availW / first.width, availH / first.height)
      setZoom(Math.max(0.1, Math.min(4, z)))
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [doc, fit])

  const scrollToPage = useCallback((pageIndex: number) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-page="${pageIndex}"]`)
    el?.scrollIntoView({ block: 'start' })
  }, [])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const pages = el.querySelectorAll<HTMLElement>('.page')
    const mid = el.scrollTop + el.clientHeight / 3
    let found = 0
    for (const p of pages) {
      if (p.offsetTop <= mid) found = Number(p.dataset.page)
      else break
    }
    setCurrentPage(found)
  }, [])

  const stepZoom = (dir: 1 | -1) => {
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > zoom + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001)
    if (next) {
      setFit(null)
      setZoom(next)
    }
  }

  const runSearch = async (q: string) => {
    if (!doc) return
    setBusy('Searching…')
    try {
      const found = q.trim() ? await doc.search(q.trim()) : []
      setHits(found)
      setActiveHit(0)
      if (found[0]) scrollToPage(found[0].pageIndex)
    } catch (err) {
      handleEngineError(err)
    } finally {
      setBusy(null)
    }
  }

  const gotoHit = (dir: 1 | -1) => {
    if (!hits.length) return
    const next = (activeHit + dir + hits.length) % hits.length
    setActiveHit(next)
    scrollToPage(hits[next].pageIndex)
  }

  const applyEdit = useCallback(
    async (edit: Edit) => {
      if (!doc) throw new Error('No document is open')
      const next = await doc.edit(edit)
      setDoc(next)
      setHits([])
      return next
    },
    [doc],
  )

  const signWithCertificate = async (req: CertSignRequest, pageIndex: number, rect?: Rect) => {
    setCertLast(req)
    setBusy('Signing…')
    try {
      await applyEdit({ kind: 'certify', p12: req.p12, password: req.password, pageIndex, rect, reason: req.reason || undefined, location: req.location || undefined })
      setCertDialog(null)
      setNotice('Signed. Save a copy to keep the signed file; editing it afterwards would invalidate the signature.')
    } catch (err) {
      setCertDialog({ error: describeError(err) })
    } finally {
      setBusy(null)
    }
  }

  // The Tools bar offers to remove watermarks, headers and footers only when there are some.
  const toolsMode = mode === 'tools' && !!doc && !comparing
  const redactMode = mode === 'redact' && !!doc
  const editMode = mode === 'edit' && !!doc
  useEffect(() => {
    if (!toolsMode || !doc) return
    let live = true
    doc.pageTextKinds().then((k) => live && setPageTextKinds(k), handleEngineError)
    return () => {
      live = false
    }
  }, [toolsMode, doc, handleEngineError])

  const runTool = async (label: string, edit: Edit, done: string) => {
    setBusy(label)
    setNotice(null)
    try {
      await applyEdit(edit)
      setNotice(done)
    } catch (err) {
      handleEngineError(err)
    } finally {
      setBusy(null)
    }
  }

  const addPageText = (items: PageText[], options: PageTextOptions) => {
    setStamp(null)
    const n = options.pages?.length ?? doc?.pageCount ?? 0
    void runTool('Adding…', { kind: 'page-text', items, options }, `Added to ${n} page${n === 1 ? '' : 's'}. Save a copy to keep it.`)
  }

  const protect = (openPassword: string, ownerPassword: string, permissions: Permissions) => {
    setProtecting(false)
    const what = openPassword ? 'needs a password to open' : 'has restrictions'
    void runTool('Encrypting…', { kind: 'protect', openPassword, ownerPassword, permissions }, `The file now ${what}. Save a copy to keep it.`)
  }

  const compress = async (options: CompressOptions) => {
    setCompressing(false)
    setBusy('Compressing images…')
    setNotice(null)
    try {
      const r = (await applyEdit({ kind: 'compress', options })).compressed
      if (r) {
        const mb = (n: number) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`
        const pct = Math.round((1 - r.after / r.before) * 100)
        setNotice(`${r.images} image${r.images === 1 ? '' : 's'} compressed: ${mb(r.before)} → ${mb(r.after)} (${pct}% smaller). Save a copy to keep it.`)
      }
    } catch (err) {
      handleEngineError(err)
    } finally {
      setBusy(null)
    }
  }

  const recognize = async () => {
    if (!doc) return
    setNotice(null)
    try {
      const pages = await doc.ocrCandidates()
      if (pages.length === 0) {
        setNotice('Every page already has text, so there is nothing to recognise.')
        return
      }
      setBusy('Loading text recognition…')
      const found = await recognizePages(doc, pages, (done, total) => setBusy(`Recognising text: page ${Math.min(done + 1, total)} of ${total}…`))
      const withText = found.filter((p) => p.words.length)
      if (withText.length === 0) {
        setNotice('No text was found on the scanned pages.')
        return
      }
      setBusy('Adding the text…')
      await applyEdit({ kind: 'ocr', pages: withText })
      setNotice(`Text recognised on ${withText.length} page${withText.length === 1 ? '' : 's'}. You can now search, select and copy it.`)
    } catch (err) {
      handleEngineError(err)
    } finally {
      setBusy(null)
    }
  }

  const compareWith = async (f: File) => {
    setNotice(null)
    let bytes = new Uint8Array(await f.arrayBuffer())
    let name = f.name
    try {
      if (isOfficeFile(f.name)) {
        if (!isDesktop) {
          setNotice(`${f.name} is an Office file. Comparing with one needs the PDF Pro desktop app, which converts it first.`)
          return
        }
        setBusy(`Converting ${f.name} to PDF…`)
        bytes = await convertFile(f.name, bytes, 'pdf')
        name = withExtension(f.name, 'pdf')
      }
      setBusy('Opening the other version…')
      const older = await engine.open(bytes)
      setComparing((c) => {
        c?.older.close()
        return { older, name }
      })
    } catch (err) {
      if (err instanceof PdfError && err.code === 'password') setNotice(`${f.name} is password protected. Remove its password first, then compare.`)
      else handleEngineError(err)
    } finally {
      setBusy(null)
    }
  }

  const closeCompare = () => {
    comparing?.older.close()
    setComparing(null)
  }

  const exportWord = async () => {
    if (!doc || !file) return
    setNotice(null)
    if (!isDesktop) {
      setNotice('Exporting to Word needs the PDF Pro desktop app, which converts files with LibreOffice on your computer.')
      return
    }
    if (doc.security.encrypted) {
      setNotice('Remove the password protection first: Word conversion needs an unprotected file.')
      return
    }
    setBusy('Converting to Word…')
    try {
      const docx = await convertFile(file.name, await doc.save(), 'docx')
      setBusy(null)
      if (await saveCopy(withExtension(file.name, 'docx'), docx, 'docx')) setNotice('Saved as a Word document. Check the layout: complex pages may need tidying.')
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(null)
    }
  }

  const editText = async (line: TextLine, text: string) => {
    setBusy('Updating text…')
    setNotice(null)
    try {
      const next = await applyEdit({ kind: 'text', pageIndex: line.pageIndex, objects: line.objects, expected: line.text, text })
      const sub = next.replaced?.substitute
      setNotice(
        !text.trim()
          ? 'Line deleted.'
          : sub
            ? `The file's own font doesn't have every letter you typed, so this line now uses ${sub.replace('-', ' ')}.`
            : 'Text updated. Save a copy to keep it.',
      )
    } catch (err) {
      handleEngineError(err)
    } finally {
      setBusy(null)
    }
  }

  const addRedactMarks = (marks: Omit<RedactMark, 'id'>[]) =>
    setRedactMarks((old) => [...old, ...marks.map((m) => ({ ...m, id: crypto.randomUUID() }))])

  const markSearchResults = () => {
    const have = new Set(redactMarks.map((m) => `${m.pageIndex}:${m.rect.x}:${m.rect.y}`))
    addRedactMarks(hits.flatMap((h) => h.rects.map((rect) => ({ pageIndex: h.pageIndex, rect }))).filter((m) => !have.has(`${m.pageIndex}:${m.rect.x}:${m.rect.y}`)))
  }

  const applyRedactions = async () => {
    setConfirmRedact(false)
    const n = redactMarks.length
    setBusy('Redacting…')
    setNotice(null)
    try {
      await applyEdit({ kind: 'redact', marks: redactMarks.map(({ pageIndex, rect }) => ({ pageIndex, rect })) })
      setRedactMarks([])
      setHits([])
      setNotice(`${n} area${n === 1 ? '' : 's'} redacted. Save a copy to keep it: in the saved file the content is gone for good.`)
    } catch (err) {
      handleEngineError(err)
    } finally {
      setBusy(null)
    }
  }

  const unlockOwner = async (password: string) => {
    if (!doc) return
    try {
      setDoc(await doc.unlockOwner(password))
      setNotice('Unlocked. You can now change or remove the protection.')
    } catch (err) {
      handleEngineError(err)
    }
  }

  // Comment and Fill & Sign modes list every annotation; reload the list after each change.
  const commenting = mode === 'comment' && !!doc
  const signMode = mode === 'sign' && !!doc
  const editing = commenting || signMode
  useEffect(() => {
    if (!editing || !doc) return
    let live = true
    doc.annotations().then((list) => live && setAnnots(list), handleEngineError)
    return () => {
      live = false
    }
  }, [editing, doc, handleEngineError])

  // Fillable fields get HTML inputs in Read and Fill & Sign modes.
  const formsShown = !!doc?.hasForm && (mode === 'view' || mode === 'sign')
  useEffect(() => {
    if (!formsShown || !doc) return
    let live = true
    doc.formFields().then((list) => live && setFields(list), handleEngineError)
    return () => {
      live = false
    }
  }, [formsShown, doc, handleEngineError])
  const fieldsByPage = useMemo(() => {
    const map = new Map<number, FormField[]>()
    for (const f of fields ?? []) map.set(f.pageIndex, [...(map.get(f.pageIndex) ?? []), f])
    return map
  }, [fields])

  // Character boxes per page, kept until the document changes.
  const layouts = useMemo(() => {
    void doc
    return new Map<number, Promise<TextLayout>>()
  }, [doc])
  const loadLayout = useCallback(
    (pageIndex: number) => {
      let l = layouts.get(pageIndex)
      if (!l && doc) {
        l = doc.textLayout(pageIndex)
        layouts.set(pageIndex, l)
      }
      return l ?? Promise.reject(new Error('No document is open'))
    },
    [layouts, doc],
  )

  const annotEdit = useCallback(
    async (edit: Parameters<typeof applyEdit>[0]) => {
      try {
        await applyEdit(edit)
      } catch (err) {
        handleEngineError(err)
      }
    },
    [applyEdit, handleEngineError],
  )

  const createAnnot = useCallback(
    (spec: NewAnnotation) => {
      const id = crypto.randomUUID()
      setSelectedId(spec.kind === 'note' ? id : null)
      void annotEdit({ kind: 'annot-add', id, annot: { ...spec, author } })
    },
    [annotEdit, author],
  )
  const moveAnnot = useCallback(
    (a: Annotation, to: Point) => void annotEdit({ kind: 'annot-update', pageIndex: a.pageIndex, id: a.id, patch: { moveTo: to } }),
    [annotEdit],
  )
  const deleteAnnot = (a: Annotation) => {
    if (a.id === selectedId) setSelectedId(null)
    void annotEdit({ kind: 'annot-remove', pageIndex: a.pageIndex, id: a.id })
  }
  const setField = useCallback(
    (f: FormField, value: FieldValue) => void annotEdit({ kind: 'field', pageIndex: f.pageIndex, index: f.index, value }),
    [annotEdit],
  )

  /**
   * Puts the saved signature (or initials) on the page: centred on `at`, or
   * fitted inside `fit` for a signature field. Asks for one first if none is saved.
   */
  const placeSignature = async (kind: SignatureKind, pageIndex: number, at?: Point, fit?: Rect, url = savedSignature(kind)) => {
    if (!url) {
      setSigning({ kind, place: { pageIndex, at, fit } })
      return
    }
    try {
      const image = await signaturePixels(url)
      const aspect = image.width / image.height
      let rect: Rect
      if (fit) {
        const h = Math.min(fit.height, fit.width / aspect)
        const w = h * aspect
        rect = { x: fit.x + (fit.width - w) / 2, y: fit.y + (fit.height - h) / 2, width: w, height: h }
      } else {
        let h = kind === 'signature' ? 36 : 24
        let w = h * aspect
        if (w > 200) [w, h] = [200, 200 / aspect]
        const p = at ?? { x: 50, y: 50 }
        rect = { x: p.x - w / 2, y: p.y - h / 2, width: w, height: h }
      }
      const id = crypto.randomUUID()
      setSelectedId(id)
      await annotEdit({ kind: 'stamp', pageIndex, id, rect, image, author, label: kind === 'signature' ? 'Signature' : 'Initials' })
    } catch (err) {
      handleEngineError(err)
    }
  }

  const markSelection = (kind: MarkupTool) => {
    if (!textSel) return
    createAnnot({ kind, pageIndex: textSel.pageIndex, color: colors[kind], quads: textSel.rects })
    setTextSel(null)
  }
  const saveAuthor = (name: string) => {
    setAuthor(name)
    try {
      localStorage.setItem(AUTHOR_KEY, name)
    } catch {
      // Private windows may refuse storage; the name still applies until reload.
    }
  }

  // Copy selected page text with the usual shortcut.
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      if (!textSel || typingIn(document.activeElement)) return
      e.clipboardData?.setData('text/plain', textSel.text)
      e.preventDefault()
    }
    document.addEventListener('copy', onCopy)
    return () => document.removeEventListener('copy', onCopy)
  }, [textSel])

  const undo = async () => {
    if (!doc || doc.undoDepth === 0 || busy) return
    try {
      setDoc(await doc.undo())
      setHits([])
      setNotice(null)
      setSelectedId(null)
    } catch (err) {
      handleEngineError(err)
    }
  }

  const saveFile = useCallback(
    (name: string, bytes: Uint8Array) => saveCopy(name, bytes),
    [],
  )

  const download = async () => {
    if (!file || !doc) return
    try {
      if (!dirty) return await saveCopy(file.name, file.bytes)
      setBusy('Saving…')
      const version = doc.version
      if (await saveCopy(file.name, await doc.save())) setSavedVersion(version)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(null)
    }
  }

  const print = async () => {
    if (!doc || busy) return
    try {
      await printDocument(doc, (done, total) => setBusy(`Preparing page ${done} of ${total} for printing…`))
    } catch (err) {
      handleEngineError(err)
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key === 'f' && doc) {
        e.preventDefault()
        searchBox.current?.focus()
        searchBox.current?.select()
      } else if (mod && e.key === 'p' && doc) {
        e.preventDefault()
        void print()
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && doc) {
        if (typingIn(e.target)) return
        e.preventDefault()
        void undo()
      } else if (mod && e.key === 's' && doc) {
        e.preventDefault()
        void download()
      } else if (mod && e.key === 'o') {
        e.preventDefault()
        fileInput.current?.click()
      } else if (editing && !mod && !e.altKey && !typingIn(e.target)) {
        const t = commenting ? TOOLS.find((x) => x.key === e.key.toLowerCase()) : undefined
        const sel = annots?.find((a) => a.id === selectedId)
        if (t) setTool(t.tool)
        else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
          e.preventDefault()
          deleteAnnot(sel)
        } else if (e.key === 'Escape') {
          setSelectedId(null)
          setTextSel(null)
          setCertPlacing(null)
        }
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        stepZoom(1)
      } else if (mod && e.key === '-') {
        e.preventDefault()
        stepZoom(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const hitsByPage = useMemo(() => {
    const map = new Map<number, SearchHit[]>()
    for (const h of hits) map.set(h.pageIndex, [...(map.get(h.pageIndex) ?? []), h])
    return map
  }, [hits])

  const annotsByPage = useMemo(() => {
    const map = new Map<number, Annotation[]>()
    for (const a of annots ?? []) map.set(a.pageIndex, [...(map.get(a.pageIndex) ?? []), a])
    return map
  }, [annots])

  const pages = doc ? Array.from({ length: doc.pageCount }, (_, i) => i) : []
  const current = hits[activeHit]

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const f = e.dataTransfer.files[0]
        if (f) void openFile(f)
      }}
    >
      <header className="toolbar">
        <strong className="brand">PDF Pro</strong>
        <button onClick={() => fileInput.current?.click()}>Open</button>
        <input
          ref={fileInput}
          type="file"
          accept={['application/pdf', '.pdf', ...(isDesktop ? OFFICE_EXTENSIONS.map((e) => `.${e}`) : [])].join(',')}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void openFile(f)
            e.target.value = ''
          }}
        />
        <button onClick={() => void download()} disabled={!file || !!busy}>
          Save a copy
        </button>
        <button onClick={() => void print()} disabled={!doc || !!busy}>
          Print
        </button>
        <button onClick={() => setAssistantOpen((o) => !o)} disabled={!doc} aria-pressed={assistantOpen} title="Summaries and answers about this document, from Claude">
          Ask AI
        </button>
        <span className="filename" title={file?.name}>
          {file?.name}
          {dirty && <span className="dirty"> · edited</span>}
        </span>
        {doc && (
          <span className="modes" role="tablist">
            <button role="tab" aria-selected={mode === 'view'} onClick={() => setMode('view')}>
              Read
            </button>
            <button role="tab" aria-selected={mode === 'comment'} onClick={() => setMode('comment')}>
              Comment
            </button>
            <button role="tab" aria-selected={mode === 'sign'} onClick={() => setMode('sign')}>
              Fill &amp; Sign
            </button>
            <button role="tab" aria-selected={mode === 'edit'} onClick={() => setMode('edit')}>
              Edit text
            </button>
            <button role="tab" aria-selected={mode === 'tools'} onClick={() => setMode('tools')}>
              Tools
            </button>
            <button role="tab" aria-selected={mode === 'redact'} onClick={() => setMode('redact')}>
              Redact
            </button>
            <button role="tab" aria-selected={mode === 'organize'} onClick={() => setMode('organize')}>
              Organize pages
            </button>
            <button onClick={() => void undo()} disabled={!doc.undoDepth || !!busy} title="Undo (Ctrl+Z)">
              Undo
            </button>
          </span>
        )}
        {doc && mode !== 'organize' && (
          <>
            <span className="pager">
              Page{' '}
              <input
                aria-label="Page number"
                key={currentPage}
                defaultValue={currentPage + 1}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  const n = Number((e.target as HTMLInputElement).value)
                  if (n >= 1 && n <= doc.pageCount) scrollToPage(n - 1)
                }}
              />{' '}
              of {doc.pageCount}
            </span>
            <span className="zoom">
              <button onClick={() => stepZoom(-1)} aria-label="Zoom out">
                −
              </button>
              <span className="zoom-value">{Math.round(zoom * 100)}%</span>
              <button onClick={() => stepZoom(1)} aria-label="Zoom in">
                +
              </button>
              <button className={fit === 'width' ? 'on' : ''} onClick={() => setFit('width')}>
                Fit width
              </button>
              <button className={fit === 'page' ? 'on' : ''} onClick={() => setFit('page')}>
                Fit page
              </button>
            </span>
            <span className="search">
              <input
                ref={searchBox}
                type="search"
                placeholder="Find in document"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  if (hits.length && query.trim() === (e.currentTarget.dataset.last ?? '')) gotoHit(e.shiftKey ? -1 : 1)
                  else {
                    e.currentTarget.dataset.last = query.trim()
                    void runSearch(query)
                  }
                }}
              />
              {hits.length > 0 && (
                <>
                  <span className="count">
                    {activeHit + 1} of {hits.length >= 1000 ? '1000+' : hits.length}
                  </span>
                  <button onClick={() => gotoHit(-1)} aria-label="Previous match">
                    ↑
                  </button>
                  <button onClick={() => gotoHit(1)} aria-label="Next match">
                    ↓
                  </button>
                </>
              )}
            </span>
          </>
        )}
      </header>
      <UpdateBanner unsaved={dirty} />

      {busy && (
        <div className="status" role="status">
          {busy}
        </div>
      )}

      {locked && (
        <form
          className="unlock"
          onSubmit={(e) => {
            e.preventDefault()
            const pw = new FormData(e.currentTarget).get('password')
            void openBytes(locked.name, locked.bytes, String(pw ?? ''))
          }}
        >
          <label>
            {locked.wrong ? 'Wrong password. Try again' : `“${locked.name}” is password-protected`}:{' '}
            <input name="password" type="password" autoFocus autoComplete="off" aria-invalid={locked.wrong} />
          </label>
          <button type="submit">Open</button>
          <button type="button" onClick={() => setLocked(null)}>
            Cancel
          </button>
        </form>
      )}

      {error && (
        <div className="error" role="alert">
          {error}
          <button onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {commenting && (
        <div className="comment-bar" role="toolbar" aria-label="Comment tools">
          {TOOLS.map((t) => (
            <button
              key={t.tool}
              className={tool === t.tool ? 'on' : ''}
              aria-pressed={tool === t.tool}
              title={`${t.label} (${t.key.toUpperCase()})`}
              onClick={() => setTool(t.tool)}
            >
              {t.label}
            </button>
          ))}
          <span className="swatches" role="radiogroup" aria-label="Colour">
            {SWATCHES.map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={colors[tool] === c}
                aria-label={`Colour ${c}`}
                className={colors[tool] === c ? 'swatch-btn on' : 'swatch-btn'}
                style={{ background: c }}
                onClick={() => setColors({ ...colors, [tool]: c })}
              />
            ))}
          </span>
          {textSel && (
            <span className="sel-actions">
              <span className="count">Selected text:</span>
              {MARKUP_TOOLS.map((k) => (
                <button key={k} onClick={() => markSelection(k)}>
                  {TOOLS.find((t) => t.tool === k)!.label}
                </button>
              ))}
              <button onClick={() => void navigator.clipboard?.writeText(textSel.text)}>Copy</button>
            </span>
          )}
        </div>
      )}

      {signMode && (
        <div className="comment-bar" role="toolbar" aria-label="Fill and sign tools">
          {SIGN_TOOLS.map((t) => (
            <button key={t.tool} className={signTool === t.tool ? 'on' : ''} aria-pressed={signTool === t.tool} onClick={() => setSignTool(t.tool)}>
              {t.label}
            </button>
          ))}
          <span className="swatches" role="radiogroup" aria-label="Ink colour">
            {['#1d1d1b', '#1f3a93', '#d93025'].map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={signColor === c}
                aria-label={`Colour ${c}`}
                className={signColor === c ? 'swatch-btn on' : 'swatch-btn'}
                style={{ background: c }}
                onClick={() => setSignColor(c)}
              />
            ))}
          </span>
          <span className="sel-actions">
            {doc?.hasForm && <span className="count">{fields ? `${fields.filter((f) => f.type !== 'button').length} form fields` : ''}</span>}
            <button onClick={() => setSigning({ kind: 'signature' })}>{savedSignature('signature') ? 'Change signature' : 'Create signature'}</button>
            <button onClick={() => setCertDialog({})} disabled={!!busy} title="Sign with a digital ID (.p12 or .pfx)">
              Sign with certificate…
            </button>
          </span>
          {certPlacing && (
            <span className="count" role="status">
              Click on the page where the signature should go. Esc cancels.
            </span>
          )}
          {!certPlacing && notice && (
            <span className="count" role="status">
              {notice}
            </span>
          )}
        </div>
      )}

      {certDialog && doc && (
        <CertSignDialog
          error={certDialog.error}
          last={certDialog.error ? certLast : null}
          signed={doc.signatureCount}
          onCancel={() => setCertDialog(null)}
          onSign={(req) => {
            setCertDialog(null)
            if (req.visible) setCertPlacing(req)
            else void signWithCertificate(req, currentPage)
          }}
        />
      )}

      {doc && !comparing && mode !== 'organize' && <SignaturesBar doc={doc} onError={handleEngineError} />}

      {toolsMode && doc && (
        <div className="comment-bar" role="toolbar" aria-label="Tools">
          <button onClick={() => setStamp('watermark')}>Watermark</button>
          <button onClick={() => setStamp('header-footer')}>Header &amp; footer</button>
          <button onClick={() => setStamp('page-numbers')}>Page numbers</button>
          <button onClick={() => setCompressing(true)}>Reduce file size</button>
          <button onClick={() => void recognize()} disabled={!!busy}>
            Recognise text (OCR)
          </button>
          <button onClick={() => void exportWord()} disabled={!!busy} title={isDesktop ? undefined : 'Needs the PDF Pro desktop app'}>
            Export to Word
          </button>
          <button onClick={() => compareInput.current?.click()} disabled={!!busy} title="Show what changed between this file and another version of it">
            Compare with another version…
          </button>
          <input
            ref={compareInput}
            type="file"
            hidden
            accept={['.pdf', ...(isDesktop ? OFFICE_EXTENSIONS.map((x) => `.${x}`) : [])].join(',')}
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void compareWith(f)
            }}
          />
          {pageTextKinds.includes('watermark') && (
            <button onClick={() => void runTool('Removing…', { kind: 'page-text-remove', kinds: ['watermark'] }, 'Watermarks removed.')}>
              Remove watermarks
            </button>
          )}
          {(pageTextKinds.includes('header') || pageTextKinds.includes('footer')) && (
            <button onClick={() => void runTool('Removing…', { kind: 'page-text-remove', kinds: ['header', 'footer'] }, 'Headers and footers removed.')}>
              Remove headers &amp; footers
            </button>
          )}
          <span className="sel-actions">
            {!doc.security.encrypted ? (
              <button onClick={() => setProtecting(true)}>Protect with password</button>
            ) : doc.security.ownerUnlocked ? (
              <>
                <span className="count">🔒 Protected</span>
                <button onClick={() => setProtecting(true)}>Change protection</button>
                <button onClick={() => void runTool('Removing protection…', { kind: 'unprotect' }, 'Protection removed. Save a copy to keep it.')}>
                  Remove protection
                </button>
              </>
            ) : (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  const pw = String(new FormData(e.currentTarget).get('owner') ?? '')
                  if (pw) void unlockOwner(pw)
                }}
              >
                <span className="count">🔒 Protected. To change it, enter the permissions password:</span>
                <input name="owner" type="password" autoComplete="off" aria-label="Permissions password" />
                <button type="submit">Unlock</button>
              </form>
            )}
          </span>
          {notice && (
            <span className="count" role="status">
              {notice}
            </span>
          )}
        </div>
      )}

      {editMode && doc && (
        <div className="comment-bar" role="toolbar" aria-label="Edit text">
          <span className="count">Click any line to change it. Enter saves, Esc cancels, and an empty line is deleted.</span>
          {notice && (
            <span className="count" role="status">
              {notice}
            </span>
          )}
        </div>
      )}

      {redactMode && doc && (
        <div className="comment-bar" role="toolbar" aria-label="Redaction">
          <span className="count">Drag over anything to remove it for good.</span>
          {hits.length > 0 && <button onClick={markSearchResults}>Mark all {hits.length} search results</button>}
          {!hits.length && (
            <button onClick={() => searchBox.current?.focus()} title="Search for a name or number, then mark every match">
              Find text to redact…
            </button>
          )}
          {redactMarks.length > 0 && <button onClick={() => setRedactMarks([])}>Clear marks</button>}
          <button className="primary danger" disabled={!redactMarks.length || !!busy} onClick={() => setConfirmRedact(true)}>
            {redactMarks.length ? `Apply ${redactMarks.length} redaction${redactMarks.length === 1 ? '' : 's'}` : 'Apply redactions'}
          </button>
          {notice && (
            <span className="count" role="status">
              {notice}
            </span>
          )}
        </div>
      )}
      {confirmRedact && (
        <RedactDialog
          marks={redactMarks.length}
          pages={new Set(redactMarks.map((m) => m.pageIndex)).size}
          onApply={() => void applyRedactions()}
          onCancel={() => setConfirmRedact(false)}
        />
      )}

      {stamp && doc && <StampDialog kind={stamp} pageCount={doc.pageCount} onApply={addPageText} onCancel={() => setStamp(null)} />}
      {compressing && doc && <CompressDialog onApply={(o) => void compress(o)} onCancel={() => setCompressing(false)} />}
      {protecting && doc && <ProtectDialog permissions={doc.security.permissions} onApply={protect} onCancel={() => setProtecting(false)} />}

      {signing && (
        <SignatureDialog
          kind={signing.kind}
          author={author}
          onCancel={() => setSigning(null)}
          onDone={(url) => {
            const place = signing.place
            setSigning(null)
            if (place) void placeSignature(signing.kind, place.pageIndex, place.at, place.fit, url)
          }}
        />
      )}

      {doc && comparing && (
        <CompareView
          doc={doc}
          older={comparing.older}
          names={{ older: comparing.name, newer: file?.name ?? 'Current file' }}
          onClose={closeCompare}
          onError={handleEngineError}
        />
      )}

      {doc && !comparing && mode === 'organize' && (
        <Organize
          doc={doc}
          onEdit={applyEdit}
          onSaveFile={saveFile}
          baseName={(file?.name ?? 'document').replace(/\.pdf$/i, '')}
          onError={handleEngineError}
          onOpenPage={(i) => {
            setMode('view')
            requestAnimationFrame(() => scrollToPage(i))
          }}
        />
      )}

      <div className="body" hidden={(mode === 'organize' || !!comparing) && !!doc}>
        {doc && (
          <aside className="sidebar">
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={sidebar === 'pages'} onClick={() => setSidebar('pages')}>
                Pages
              </button>
              <button
                role="tab"
                aria-selected={sidebar === 'outline'}
                onClick={() => setSidebar('outline')}
                disabled={outline.length === 0}
              >
                Bookmarks
              </button>
            </div>
            {sidebar === 'pages' ? (
              <div className="thumbs">
                {pages.map((i) => (
                  <button key={i} className={i === currentPage ? 'thumb on' : 'thumb'} onClick={() => scrollToPage(i)}>
                    <PageCanvas
                      doc={doc}
                      pageIndex={i}
                      zoom={THUMB_WIDTH / doc.sizes[i].width}
                      className="thumb-page"
                      onError={handleEngineError}
                    />
                    <span>{i + 1}</span>
                  </button>
                ))}
              </div>
            ) : (
              <Outline items={outline} onPick={scrollToPage} />
            )}
          </aside>
        )}

        <main ref={scroller} className="pages" onScroll={onScroll}>
          {!doc && (
            <div className={dragging ? 'empty drag' : 'empty'}>
              <p>Drop a PDF here, or</p>
              <button onClick={() => fileInput.current?.click()}>Open a PDF</button>
              <p className="hint">Files stay on your device. Nothing is uploaded.</p>
            </div>
          )}
          {doc &&
            pages.map((i) => (
              <PageCanvas
                key={i}
                doc={doc}
                pageIndex={i}
                zoom={zoom}
                className="page"
                highlights={hitsByPage.get(i)?.filter((h) => h !== current).flatMap((h) => h.rects)}
                activeHighlight={current?.pageIndex === i ? current.rects : undefined}
                onError={handleEngineError}
                forms={!(formsShown && fields)}
              >
                <AnnotLayer
                  pageIndex={i}
                  zoom={zoom}
                  tool={commenting ? tool : signMode ? signTool : 'select'}
                  color={signMode ? signColor : colors[tool]}
                  annotations={editing ? (annotsByPage.get(i) ?? []) : []}
                  selectedId={selectedId}
                  loadLayout={loadLayout}
                  textSelection={textSel}
                  onTextSelection={setTextSel}
                  onSelect={setSelectedId}
                  onCreate={createAnnot}
                  onMove={moveAnnot}
                  onPlaceSignature={(pageIndex, at, kind) => void placeSignature(kind, pageIndex, at)}
                />
                {editMode && <EditTextLayer doc={doc} pageIndex={i} zoom={zoom} busy={!!busy} onEdit={(l, t) => void editText(l, t)} onError={handleEngineError} />}
                {redactMode && (
                  <RedactLayer
                    pageIndex={i}
                    zoom={zoom}
                    marks={redactMarks.filter((m) => m.pageIndex === i)}
                    onAdd={(m) => addRedactMarks([m])}
                    onRemove={(id) => setRedactMarks((old) => old.filter((m) => m.id !== id))}
                  />
                )}
                {certPlacing && (
                  <div
                    className="place-layer"
                    onClick={(e) => {
                      const box = e.currentTarget.getBoundingClientRect()
                      const size = doc.sizes[i]
                      const w = Math.min(200, size.width)
                      const h = Math.min(56, size.height)
                      const x = Math.max(0, Math.min(size.width - w, (e.clientX - box.left) / zoom - w / 2))
                      const y = Math.max(0, Math.min(size.height - h, (e.clientY - box.top) / zoom - h / 2))
                      const req = certPlacing
                      setCertPlacing(null)
                      void signWithCertificate(req, i, { x, y, width: w, height: h })
                    }}
                  />
                )}
                {formsShown && fields && (
                  <FormLayer
                    fields={fieldsByPage.get(i) ?? []}
                    zoom={zoom}
                    onChange={setField}
                    onSign={(f) => void placeSignature('signature', f.pageIndex, undefined, f.rect)}
                  />
                )}
              </PageCanvas>
            ))}
        </main>
        {commenting && (
          <CommentsPanel
            annotations={annots}
            selectedId={selectedId}
            author={author}
            onAuthor={saveAuthor}
            onSelect={(a) => {
              setSelectedId(a.id)
              const page = scroller.current?.querySelector<HTMLElement>(`[data-page="${a.pageIndex}"]`)
              const top = (page?.offsetTop ?? 0) + a.rect.y * zoom - 80
              scroller.current?.scrollTo({ top, behavior: 'smooth' })
            }}
            onComment={(a, contents) => void annotEdit({ kind: 'annot-update', pageIndex: a.pageIndex, id: a.id, patch: { contents } })}
            onDelete={deleteAnnot}
          />
        )}
        {assistantOpen && doc && (
          <Suspense fallback={<aside className="assistant" />}>
            <AssistantPanel
              doc={doc}
              fileName={file?.name ?? 'document.pdf'}
              onOpenPage={(i) => scrollToPage(Math.min(i, doc.pageCount - 1))}
              onClose={() => setAssistantOpen(false)}
            />
          </Suspense>
        )}
      </div>
    </div>
  )
}

function Outline({ items, onPick }: { items: OutlineItem[]; onPick: (page: number) => void }) {
  return (
    <ul className="outline">
      {items.map((item, i) => (
        <li key={i}>
          <button disabled={item.pageIndex === null} onClick={() => item.pageIndex !== null && onPick(item.pageIndex)}>
            {item.title || 'Untitled'}
          </button>
          {item.children.length > 0 && <Outline items={item.children} onPick={onPick} />}
        </li>
      ))}
    </ul>
  )
}
