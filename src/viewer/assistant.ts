/**
 * AI summaries and questions about the open document, answered by Claude.
 *
 * Each user brings their own Anthropic API key, kept only on this device.
 * The PDF itself is sent (so Claude sees tables and scans, not just text),
 * with citations on, so every answer can point at the pages it came from.
 * The document is cached on the first request, so follow-up questions about
 * the same file cost a fraction of the first.
 */
import Anthropic from '@anthropic-ai/sdk'

export const MODEL = 'claude-opus-5-5'
const KEY_STORE = 'pdfpro.anthropicKey'
/** The API takes requests up to 32 MB; base64 adds a third. */
export const MAX_PDF_BYTES = 22 * 1024 * 1024
export const MAX_PAGES = 600

const SYSTEM = `You are the assistant built into PDF Pro, a PDF editor. The user has one document open and is asking about it.
Answer from the document only. If the document does not say, reply that it does not, rather than guessing.
Write plain text: short paragraphs, and lines starting with "- " for lists. Do not use headings, tables or other Markdown.
Keep answers as short as the question allows.`

export const SUMMARY_PROMPT = `Summarize this document. Start with two or three sentences on what it is and its purpose. Then list the key points. Finish with any dates, deadlines, amounts, names or obligations a reader must not miss, if there are any.`

export function savedKey(): string {
  try {
    return localStorage.getItem(KEY_STORE) ?? ''
  } catch {
    return ''
  }
}

export function saveKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_STORE, key)
    else localStorage.removeItem(KEY_STORE)
  } catch {
    // Private windows can refuse storage; the key then lasts for this session only.
  }
}

/** A stretch of the answer, with the pages it was drawn from. */
export interface AnswerPart {
  text: string
  pages: number[]
}

export interface Turn {
  question: string
  /** Shown instead of the question for the built-in summary request. */
  label?: string
  parts: AnswerPart[]
  status: 'streaming' | 'done' | 'error'
  error?: string
}

/** One conversation about one version of one document. */
export class Conversation {
  private client: Anthropic
  private history: Anthropic.Beta.BetaMessageParam[] = []
  private document: Anthropic.Beta.BetaRequestDocumentBlock

  /** `fetch` is for tests. */
  constructor(key: string, pdf: Uint8Array, title: string, fetch?: typeof globalThis.fetch) {
    // The key is the user's own and stays on their device; the request goes straight to Anthropic.
    this.client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, fetch, maxRetries: fetch ? 0 : 2 })
    this.document = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: toBase64(pdf) },
      title,
      citations: { enabled: true },
      cache_control: { type: 'ephemeral' },
    }
  }

  /** Asks a question, calling `onText` with the answer so far as it streams in. */
  async ask(question: string, onText: (parts: AnswerPart[]) => void, signal?: AbortSignal): Promise<AnswerPart[]> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = this.history.length
      ? [{ type: 'text', text: question }]
      : [this.document, { type: 'text', text: question }]
    const messages: Anthropic.Beta.BetaMessageParam[] = [...this.history, { role: 'user', content }]

    const stream = this.client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: 'medium' },
        system: SYSTEM,
        messages,
        // If a safety check declines the request, the API retries it on a model chosen for that case.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { signal },
    )
    stream.on('contentBlock', () => onText(partsOf(stream.currentMessage?.content ?? [])))
    stream.on('text', () => onText(partsOf(stream.currentMessage?.content ?? [])))
    const message = await stream.finalMessage()
    if (message.stop_reason === 'refusal') throw new Error('Claude declined to answer this. Try rewording the question.')
    const parts = partsOf(message.content)
    // Keep the whole reply, not just its text, so later questions continue the same conversation.
    this.history = [...messages, { role: 'assistant', content: message.content as Anthropic.Beta.BetaContentBlockParam[] }]
    return parts
  }
}

function partsOf(content: Anthropic.Beta.BetaContentBlock[]): AnswerPart[] {
  const parts: AnswerPart[] = []
  for (const block of content) {
    if (block.type !== 'text') continue
    const pages = new Set<number>()
    for (const c of block.citations ?? []) {
      if (c.type !== 'page_location') continue
      for (let p = c.start_page_number; p < Math.max(c.end_page_number, c.start_page_number + 1); p++) pages.add(p)
    }
    parts.push({ text: block.text, pages: [...pages].sort((a, b) => a - b) })
  }
  return parts
}

/** Turns an API failure into a sentence for the user. */
export function describeAiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic did not accept the API key. Check it in the assistant settings.'
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use Claude. Check its workspace in the Anthropic Console.'
  if (err instanceof Anthropic.RateLimitError) return 'Too many requests for this API key just now. Wait a minute and try again.'
  if (err instanceof Anthropic.BadRequestError) return `Claude could not read this request: ${err.message}`
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach Anthropic. Check the internet connection.'
  if (err instanceof Anthropic.APIError) return `Claude is unavailable right now (${err.status ?? 'error'}). Try again shortly.`
  return err instanceof Error ? err.message : String(err)
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
