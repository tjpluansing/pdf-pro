// Desktop only: tells the user when a newer PDF Pro is out and installs it.
//
// The app checks the release feed a few seconds after launch and then twice a
// day. The download is verified against the updater public key baked into the
// app before anything is installed, so a tampered file is refused.
import { useCallback, useEffect, useState } from 'react'
import type { Update } from '@tauri-apps/plugin-updater'
import { isDesktop } from './platform'

const FIRST_CHECK_MS = 5_000
const RECHECK_MS = 12 * 60 * 60 * 1000

type State =
  | { kind: 'idle' }
  | { kind: 'available'; update: Update; notesOpen: boolean }
  | { kind: 'downloading'; update: Update; percent: number | null }
  | { kind: 'restarting' }
  | { kind: 'error'; update: Update; message: string }

/**
 * Looks for an update. Returns null when there is none, or when this build has
 * no updater (local and PR builds), so those stay quiet.
 */
async function findUpdate(): Promise<Update | null> {
  const { check } = await import('@tauri-apps/plugin-updater')
  try {
    return await check({ timeout: 30_000 })
  } catch (e) {
    // No updater in this build, offline, or the feed is unreachable: try again later.
    console.info('Update check skipped:', e)
    return null
  }
}

export function UpdateBanner({ unsaved }: { unsaved: boolean }) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [dismissed, setDismissed] = useState<string | null>(null)

  useEffect(() => {
    if (!isDesktop) return
    let stopped = false
    const run = async () => {
      const update = await findUpdate()
      if (stopped || !update) return
      setState((s) => (s.kind === 'idle' || s.kind === 'available' ? { kind: 'available', update, notesOpen: false } : s))
    }
    const first = setTimeout(run, FIRST_CHECK_MS)
    const again = setInterval(run, RECHECK_MS)
    return () => {
      stopped = true
      clearTimeout(first)
      clearInterval(again)
    }
  }, [])

  const install = useCallback(async (update: Update) => {
    setState({ kind: 'downloading', update, percent: null })
    try {
      let total = 0
      let done = 0
      await update.downloadAndInstall((e) => {
        if (e.event === 'Started') total = e.data.contentLength ?? 0
        else if (e.event === 'Progress') {
          done += e.data.chunkLength
          if (total) setState({ kind: 'downloading', update, percent: Math.min(100, Math.round((done / total) * 100)) })
        }
      })
      // Windows closes the app itself to run the installer; macOS needs a relaunch.
      setState({ kind: 'restarting' })
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (e) {
      setState({ kind: 'error', update, message: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  if (state.kind === 'idle') return null
  if (state.kind === 'available' && dismissed === state.update.version) return null

  return (
    <div className="update-bar" role="status">
      {state.kind === 'available' && (
        <>
          <span>
            <strong>PDF Pro {state.update.version}</strong> is available (you have {state.update.currentVersion}).
            {unsaved && ' Save your work first: PDF Pro restarts to finish the update.'}
          </span>
          {state.update.body && (
            <button onClick={() => setState({ ...state, notesOpen: !state.notesOpen })} aria-expanded={state.notesOpen}>
              What's new
            </button>
          )}
          <button className="primary" onClick={() => void install(state.update)}>
            Install and restart
          </button>
          <button onClick={() => setDismissed(state.update.version)}>Later</button>
          {state.notesOpen && state.update.body && <pre className="update-notes">{state.update.body}</pre>}
        </>
      )}
      {state.kind === 'downloading' && (
        <span>
          Downloading PDF Pro {state.update.version}
          {state.percent === null ? '…' : ` (${state.percent}%)`}
        </span>
      )}
      {state.kind === 'restarting' && <span>Restarting PDF Pro…</span>}
      {state.kind === 'error' && (
        <>
          <span>The update couldn't be installed: {state.message}</span>
          <button onClick={() => void install(state.update)}>Try again</button>
          <button
            onClick={() => {
              setDismissed(state.update.version)
              setState({ kind: 'available', update: state.update, notesOpen: false })
            }}
          >
            Later
          </button>
        </>
      )}
    </div>
  )
}
