// The few places where the desktop app (Tauri) and the browser differ.
import { isTauri } from '@tauri-apps/api/core'

export const isDesktop = isTauri()

/** Saves bytes under a name the user picks: a native Save dialog on desktop, a download in the browser. */
export async function saveCopy(name: string, bytes: Uint8Array): Promise<boolean> {
  if (isDesktop) {
    const [{ save }, { writeFile }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')])
    const path = await save({ defaultPath: name, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (!path) return false
    await writeFile(path, bytes)
    return true
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}
