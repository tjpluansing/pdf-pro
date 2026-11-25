/**
 * Interactive form fields (AcroForm widgets) and image stamps for signatures.
 *
 * PDFium only lets you change a field through its form-fill environment, the
 * same path a user's typing takes, so every call opens one for the page,
 * focuses the widget, makes the change and regenerates the widget's
 * appearance so the value shows in other readers and in print.
 */
import type { WrappedPdfiumModule } from '@embedpdf/pdfium'
import { boxToView, pageFrame, toPage, type ViewRect } from './annotations'

export type FieldType = 'text' | 'checkbox' | 'radio' | 'combo' | 'list' | 'button' | 'signature' | 'unknown'

const FIELD_TYPES: Record<number, FieldType> = {
  1: 'button',
  2: 'checkbox',
  3: 'radio',
  4: 'combo',
  5: 'list',
  6: 'text',
  7: 'signature',
}

const WIDGET = 20
const STAMP = 13

// Field flags (PDF 32000-1, 12.7.3.1 and the per-type tables).
const READ_ONLY = 1 << 0
const REQUIRED = 1 << 1
const MULTILINE = 1 << 12
const PASSWORD = 1 << 13
const COMBO_EDIT = 1 << 18
const MULTI_SELECT = 1 << 21

export interface FormField {
  pageIndex: number
  /** Position of the widget in the page's annotation list. */
  index: number
  /** Fully qualified field name; widgets of one field share it. */
  name: string
  /** The field's tooltip (/TU), shown as its label when present. */
  label: string
  type: FieldType
  rect: ViewRect
  value: string
  /** Checkboxes and radio buttons. */
  checked?: boolean
  /** The value a checkbox or radio button stands for when on. */
  exportValue?: string
  options?: { label: string; selected: boolean }[]
  readOnly: boolean
  required: boolean
  multiline: boolean
  password: boolean
  multiSelect: boolean
  /** Signature fields that already hold a digital signature. */
  signed?: boolean
  /** Combo boxes that also accept typed text. */
  editable: boolean
  maxLength?: number
}

export type FieldValue = { text: string } | { checked: boolean } | { selected: number[] }

function readString(m: WrappedPdfiumModule, call: (buf: number, len: number) => number): string {
  const len = call(0, 0)
  if (len <= 2) return ''
  const buf = m.pdfium.wasmExports.malloc(len)
  try {
    call(buf, len)
    return m.pdfium.UTF16ToString(buf)
  } finally {
    m.pdfium.wasmExports.free(buf)
  }
}

/**
 * A document's form-fill environment. PDFium needs one to edit fields and to
 * draw them (FPDF_RenderPageBitmap skips widgets), so each open document keeps
 * one for its lifetime.
 */
export class FormEnv {
  readonly handle: number
  private readonly info: number
  private readonly m: WrappedPdfiumModule

  constructor(m: WrappedPdfiumModule, doc: number) {
    this.m = m
    this.info = m.PDFiumExt_OpenFormFillInfo()
    this.handle = m.PDFiumExt_InitFormFillEnvironment(doc, this.info)
    if (!this.handle) {
      m.PDFiumExt_CloseFormFillInfo(this.info)
      throw new Error('PDFium could not start form filling for this document')
    }
  }

  /** Runs `fn` with the environment attached to a loaded page. */
  withPage<T>(page: number, fn: (form: number) => T): T {
    this.m.FORM_OnAfterLoadPage(page, this.handle)
    try {
      return fn(this.handle)
    } finally {
      this.m.FORM_OnBeforeClosePage(page, this.handle)
    }
  }

  close() {
    this.m.PDFiumExt_ExitFormFillEnvironment(this.handle)
    this.m.PDFiumExt_CloseFormFillInfo(this.info)
  }
}

export function readFields(m: WrappedPdfiumModule, env: FormEnv, page: number, pageIndex: number): FormField[] {
  if (!m.FPDFPage_GetAnnotCount(page)) return []
  const f = pageFrame(m, page)
  return env.withPage(page, (form) => {
    const out: FormField[] = []
    const count = m.FPDFPage_GetAnnotCount(page)
    const p = m.pdfium.wasmExports.malloc(16)
    try {
      for (let i = 0; i < count; i++) {
        const annot = m.FPDFPage_GetAnnot(page, i)
        if (!annot) continue
        try {
          if (m.FPDFAnnot_GetSubtype(annot) !== WIDGET) continue
          if (!m.FPDFAnnot_GetRect(annot, p)) continue
          const [left, top, right, bottom] = [0, 4, 8, 12].map((o) => m.pdfium.getValue(p + o, 'float'))
          const type = FIELD_TYPES[m.FPDFAnnot_GetFormFieldType(form, annot)] ?? 'unknown'
          const flags = m.FPDFAnnot_GetFormFieldFlags(form, annot)
          const field: FormField = {
            pageIndex,
            index: i,
            name: readString(m, (b, l) => m.FPDFAnnot_GetFormFieldName(form, annot, b, l)),
            label: readString(m, (b, l) => m.FPDFAnnot_GetFormFieldAlternateName(form, annot, b, l)),
            type,
            rect: boxToView(f, left, top, right, bottom),
            value: readString(m, (b, l) => m.FPDFAnnot_GetFormFieldValue(form, annot, b, l)),
            readOnly: !!(flags & READ_ONLY),
            required: !!(flags & REQUIRED),
            multiline: type === 'text' && !!(flags & MULTILINE),
            password: type === 'text' && !!(flags & PASSWORD),
            multiSelect: type === 'list' && !!(flags & MULTI_SELECT),
            editable: type === 'combo' && !!(flags & COMBO_EDIT),
          }
          // A signed field's widget carries the signature as /V; it shows its own appearance.
          if (type === 'signature') field.signed = !!m.FPDFAnnot_HasKey(annot, 'V')
          if (type === 'checkbox' || type === 'radio') {
            field.checked = !!m.FPDFAnnot_IsChecked(form, annot)
            field.exportValue = readString(m, (b, l) => m.FPDFAnnot_GetFormFieldExportValue(form, annot, b, l))
          }
          if (type === 'combo' || type === 'list') {
            const n = m.FPDFAnnot_GetOptionCount(form, annot)
            field.options = Array.from({ length: Math.max(0, n) }, (_, k) => ({
              label: readString(m, (b, l) => m.FPDFAnnot_GetOptionLabel(form, annot, k, b, l)),
              selected: !!m.FPDFAnnot_IsOptionSelected(form, annot, k),
            }))
          }
          if (type === 'text' && m.FPDFAnnot_GetNumberValue(annot, 'MaxLen', p)) {
            const max = m.pdfium.getValue(p, 'float')
            if (max > 0) field.maxLength = Math.round(max)
          }
          out.push(field)
        } finally {
          m.FPDFPage_CloseAnnot(annot)
        }
      }
    } finally {
      m.pdfium.wasmExports.free(p)
    }
    return out
  })
}

const RETURN = 13

/** Sets a field through the widget at `index`. Throws when the widget is gone or refuses. */
export function setField(m: WrappedPdfiumModule, env: FormEnv, page: number, index: number, value: FieldValue): void {
  env.withPage(page, (form) => {
    const annot = m.FPDFPage_GetAnnot(page, index)
    if (!annot) throw new Error('That form field is no longer on the page')
    try {
      if (m.FPDFAnnot_GetSubtype(annot) !== WIDGET) throw new Error('That is not a form field')
      if (m.FPDFAnnot_GetFormFieldFlags(form, annot) & READ_ONLY) throw new Error('This field is read-only')
      if (!m.FORM_SetFocusedAnnot(form, annot)) throw new Error('PDFium could not focus the field')
      try {
        if ('text' in value) {
          m.FORM_SelectAllText(form, page)
          const bytes = (value.text.length + 1) * 2
          const buf = m.pdfium.wasmExports.malloc(bytes)
          try {
            m.pdfium.stringToUTF16(value.text, buf, bytes)
            m.FORM_ReplaceSelection(form, page, buf)
          } finally {
            m.pdfium.wasmExports.free(buf)
          }
        } else if ('checked' in value) {
          // PDFium toggles a focused checkbox or radio button on Return, like a keyboard user would.
          if (!!m.FPDFAnnot_IsChecked(form, annot) !== value.checked) m.FORM_OnChar(form, page, RETURN, 0)
        } else {
          const n = m.FPDFAnnot_GetOptionCount(form, annot)
          const want = new Set(value.selected)
          // Clear first, then select, so single-choice fields end on the right option.
          for (let k = 0; k < n; k++) if (!want.has(k) && m.FPDFAnnot_IsOptionSelected(form, annot, k)) m.FORM_SetIndexSelected(form, page, k, false)
          for (const k of want) if (k >= 0 && k < n) m.FORM_SetIndexSelected(form, page, k, true)
        }
      } finally {
        m.FORM_ForceToKillFocus(form)
      }
      m.EPDFAnnot_GenerateFormFieldAP(annot)
    } finally {
      m.FPDFPage_CloseAnnot(annot)
    }
  })
}

/** An RGBA image, such as a drawn or typed signature. */
export interface StampImage {
  width: number
  height: number
  /** Unpremultiplied RGBA, width * height * 4 bytes. */
  rgba: Uint8Array | Uint8ClampedArray
}

/**
 * Places an image as a Stamp annotation (how Acrobat's Fill & Sign stores
 * signatures), so it can be selected, moved and deleted like a comment.
 */
export function addImageStamp(
  m: WrappedPdfiumModule,
  doc: number,
  page: number,
  rect: ViewRect,
  image: StampImage,
  id: string,
  setCommon: (annot: number) => boolean,
): void {
  const f = pageFrame(m, page)
  const { width, height, rgba } = image
  if (rgba.length !== width * height * 4) throw new Error('Signature image has the wrong size')
  const annot = m.EPDFPage_CreateAnnot(page, STAMP)
  if (!annot) throw new Error('PDFium could not create a stamp')
  const pixels = m.pdfium.wasmExports.malloc(width * height * 4)
  let bitmap = 0
  let image0 = 0
  let ok = false
  try {
    // PDFium bitmaps are BGRA.
    const heap = (m.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8
    for (let i = 0; i < width * height; i++) {
      const s = i * 4
      heap[pixels + s] = rgba[s + 2]
      heap[pixels + s + 1] = rgba[s + 1]
      heap[pixels + s + 2] = rgba[s]
      heap[pixels + s + 3] = rgba[s + 3]
    }
    bitmap = m.FPDFBitmap_CreateEx(width, height, 4, pixels, width * 4)
    image0 = bitmap ? m.FPDFPageObj_NewImageObj(doc) : 0
    if (!image0 || !m.FPDFImageObj_SetBitmap(page, 0, image0, bitmap)) throw new Error('PDFium could not embed the signature image')

    // The image object is a unit square; scale it to the box, then move it to the box's
    // bottom-left corner in page space. Rotated pages get the matching rotation.
    const quarter = f.rotation
    const [w, h] = quarter % 2 ? [rect.height, rect.width] : [rect.width, rect.height]
    const corners = [
      toPage(f, { x: rect.x, y: rect.y }),
      toPage(f, { x: rect.x + rect.width, y: rect.y + rect.height }),
    ]
    const left = Math.min(corners[0].x, corners[1].x)
    const bottom = Math.min(corners[0].y, corners[1].y)
    const rot = [
      [1, 0, 0, 1, 0, 0],
      [0, 1, -1, 0, 1, 0],
      [-1, 0, 0, -1, 1, 1],
      [0, -1, 1, 0, 0, 1],
    ][quarter]
    // A page shown turned clockwise needs its picture turned the other way to look upright.
    // Rotate the unit square within 0..1 first, then scale and place it.
    m.FPDFPageObj_Transform(image0, rot[0], rot[1], rot[2], rot[3], rot[4], rot[5])
    m.FPDFPageObj_Transform(image0, w, 0, 0, h, left, bottom)

    // The rect must be set first: PDFium sizes the appearance's bounding box from it.
    const sp = m.pdfium.wasmExports.malloc(16)
    try {
      ;[left, bottom + h, left + w, bottom].forEach((v, k) => m.pdfium.setValue(sp + k * 4, v, 'float'))
      if (!m.FPDFAnnot_SetRect(annot, sp)) throw new Error('PDFium could not place the signature')
    } finally {
      m.pdfium.wasmExports.free(sp)
    }
    if (!m.FPDFAnnot_AppendObject(annot, image0)) throw new Error('PDFium could not attach the signature image')
    image0 = 0 // owned by the annotation now
    const nameBytes = (id.length + 1) * 2
    const np = m.pdfium.wasmExports.malloc(nameBytes)
    m.pdfium.stringToUTF16(id, np, nameBytes)
    m.FPDFAnnot_SetStringValue(annot, 'NM', np)
    m.pdfium.wasmExports.free(np)
    if (!setCommon(annot)) throw new Error('PDFium could not label the signature')
    ok = true
  } finally {
    if (image0) m.FPDFPageObj_Destroy(image0)
    if (bitmap) m.FPDFBitmap_Destroy(bitmap)
    m.pdfium.wasmExports.free(pixels)
    if (!ok) {
      const n = m.FPDFPage_GetAnnotCount(page)
      m.FPDFPage_CloseAnnot(annot)
      m.FPDFPage_RemoveAnnot(page, n - 1)
    } else m.FPDFPage_CloseAnnot(annot)
  }
  m.FPDFPage_GenerateContent(page)
}
