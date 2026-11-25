import { useEffect, useRef, useState } from 'react'
import { Conversation, MAX_PAGES, MAX_PDF_BYTES, SUMMARY_PROMPT, describeAiError, saveKey, savedKey, type Turn } from './assistant'
import type { DocHandle } from './client'

interface Props {
  doc: DocHandle
  fileName: string
  onOpenPage: (pageIndex: number) => void
  onClose: () => void
}

/**
 * Side panel for summaries and questions about the open document. A new
 * conversation starts whenever the document changes, so answers always
 * match what is on screen.
 */
export function AssistantPanel({ doc, fileName, onOpenPage, onClose }: Props) {
  const [key, setKey] = useState(savedKey)
  const [editingKey, setEditingKey] = useState(() => !savedKey())
  const [turns, setTurns] = useState<Turn[]>([])
  const [question, setQuestion] = useState('')
  const conversation = useRef<{ version: number; conv: Conversation } | null>(null)
  const abort = useRef<AbortController | null>(null)
  const log = useRef<HTMLDivElement>(null)
  const busy = turns.some((t) => t.status === 'streaming')

  // A different file, or an edit, makes earlier answers stale.
  useEffect(() => {
    abort.current?.abort()
    conversation.current = null
    setTurns([])
  }, [doc.version, fileName])

  useEffect(() => () => abort.current?.abort(), [])

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight })
  }, [turns])

  const problem = doc.security.encrypted
    ? 'This file is password protected. Remove the protection (Tools) to use the assistant.'
    : doc.pageCount > MAX_PAGES
      ? `The assistant reads up to ${MAX_PAGES} pages; this file has ${doc.pageCount}. Extract the pages you need first (Organize pages).`
      : null

  const ask = async (text: string, label?: string) => {
    if (!text.trim() || busy || problem || !key) return
    const index = turns.length
    const update = (patch: Partial<Turn>) => setTurns((ts) => ts.map((t, i) => (i === index ? { ...t, ...patch } : t)))
    setTurns((ts) => [...ts, { question: text, label, parts: [], status: 'streaming' }])
    setQuestion('')
    const controller = new AbortController()
    abort.current = controller
    try {
      if (!conversation.current || conversation.current.version !== doc.version) {
        const bytes = await doc.save()
        if (bytes.length > MAX_PDF_BYTES) {
          throw new Error(`This file is ${(bytes.length / 1048576).toFixed(0)} MB; the assistant reads files up to ${MAX_PDF_BYTES / 1048576} MB. Try Reduce file size (Tools) first.`)
        }
        conversation.current = { version: doc.version, conv: new Conversation(key, bytes, fileName) }
      }
      const parts = await conversation.current.conv.ask(text, (p) => update({ parts: p }), controller.signal)
      update({ parts, status: 'done' })
    } catch (err) {
      if (controller.signal.aborted) update({ status: 'done' })
      else update({ status: 'error', error: describeAiError(err) })
    }
  }

  const storeKey = (value: string) => {
    const k = value.trim()
    saveKey(k)
    setKey(k)
    setEditingKey(!k)
    conversation.current = null
  }

  return (
    <aside className="assistant" aria-label="AI assistant">
      <div className="comments-head">
        <strong>AI assistant</strong>
        <span>
          {key && !editingKey && (
            <button className="link" onClick={() => setEditingKey(true)}>
              API key
            </button>
          )}
          <button className="link" onClick={onClose} aria-label="Close assistant">
            ✕
          </button>
        </span>
      </div>

      {editingKey ? (
        <form
          className="assistant-key"
          onSubmit={(e) => {
            e.preventDefault()
            storeKey(String(new FormData(e.currentTarget).get('key') ?? ''))
          }}
        >
          <p>
            Summaries and answers come from Claude, using your own Anthropic API key. Get one at console.anthropic.com. It is kept on this
            device only, and the open document is sent to Anthropic when you ask.
          </p>
          <input name="key" type="password" autoComplete="off" placeholder="sk-ant-…" defaultValue={key} aria-label="Anthropic API key" />
          <span className="assistant-key-actions">
            <button type="submit">Save key</button>
            {key && (
              <button type="button" onClick={() => storeKey('')}>
                Forget key
              </button>
            )}
          </span>
        </form>
      ) : problem ? (
        <p className="assistant-note">{problem}</p>
      ) : (
        <>
          <div className="assistant-log" ref={log} aria-live="polite">
            {turns.length === 0 && (
              <div className="assistant-empty">
                <button onClick={() => void ask(SUMMARY_PROMPT, 'Summarize this document')}>Summarize this document</button>
                <p className="assistant-note">Or ask a question below. Answers show the pages they come from.</p>
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className="assistant-turn">
                <div className="assistant-q">{t.label ?? t.question}</div>
                <div className="assistant-a">
                  {t.parts.map((p, j) => (
                    <span key={j}>
                      {p.text}
                      {p.pages.map((n) => (
                        <button key={n} className="cite" onClick={() => onOpenPage(n - 1)} title={`Go to page ${n}`}>
                          p. {n}
                        </button>
                      ))}
                    </span>
                  ))}
                  {t.status === 'streaming' && !t.parts.length && <span className="assistant-note">Reading the document…</span>}
                  {t.status === 'error' && <span className="assistant-error">{t.error}</span>}
                </div>
              </div>
            ))}
          </div>
          <form
            className="assistant-ask"
            onSubmit={(e) => {
              e.preventDefault()
              void ask(question)
            }}
          >
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void ask(question)
                }
              }}
              placeholder="Ask about this document"
              aria-label="Question"
              rows={2}
            />
            {busy ? (
              <button type="button" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            ) : (
              <button type="submit" disabled={!question.trim()}>
                Ask
              </button>
            )}
          </form>
          {turns.length > 0 && !busy && (
            <button className="link assistant-summary-again" onClick={() => void ask(SUMMARY_PROMPT, 'Summarize this document')}>
              Summarize this document
            </button>
          )}
        </>
      )}
    </aside>
  )
}
