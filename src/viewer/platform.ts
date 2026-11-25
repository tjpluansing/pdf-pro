// The few places where the desktop app (Tauri) and the browser differ.
import { isTauri } from '@tauri-apps/api/core'

export const isDesktop = isTauri()

const TYPES = {
  pdf: { label: 'PDF', mime: 'application/pdf' },
  docx: { label: 'Word document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
}

/** Saves bytes under a name the user picks: a native Save dialog on desktop, a download in the browser. */
export async function saveCopy(name: string, bytes: Uint8Array, type: keyof typeof TYPES = 'pdf'): Promise<boolean> {
  if (isDesktop) {
    const [{ save }, { writeFile }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')])
    const path = await save({ defaultPath: name, filters: [{ name: TYPES[type].label, extensions: [type] }] })
    if (!path) return false
    await writeFile(path, bytes)
    return true
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: TYPES[type].mime }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}

/** Office files that the desktop app can turn into PDF with LibreOffice. */
export const OFFICE_EXTENSIONS = ['doc', 'docx', 'odt', 'rtf', 'txt', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp']

export const isOfficeFile = (name: string) => OFFICE_EXTENSIONS.includes(name.split('.').pop()?.toLowerCase() ?? '')

/** Replaces a file name's extension. */
export const withExtension = (name: string, ext: string) => `${name.replace(/\.[^./\\]+$/, '')}.${ext}`

/**
 * Converts a file with LibreOffice, which only the desktop app has: an Office
 * file to PDF, or a PDF to a Word document.
 */
export async function convertFile(name: string, bytes: Uint8Array, to: 'pdf' | 'docx'): Promise<Uint8Array> {
  if (!isDesktop) throw new Error('Converting Office files needs the PDF Pro desktop app.')
  const { invoke } = await import('@tauri-apps/api/core')
  const out = await invoke<ArrayBuffer>('convert', bytes, { headers: { 'x-name': name, 'x-to': to } })
  return new Uint8Array(out)
}
