import { describe, expect, it } from 'vitest'
import { Conversation, MODEL } from '../src/viewer/assistant'

/** A streamed reply as the Messages API sends it: two text blocks, the first citing pages 2 to 3. */
function sse(texts: { text: string; pages?: [number, number] }[]) {
  const events: [string, unknown][] = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
  ]
  texts.forEach((t, index) => {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: t.pages ? [] : null } }])
    if (t.pages) {
      const citation = { type: 'page_location', cited_text: 'x', document_index: 0, document_title: 'lease.pdf', start_page_number: t.pages[0], end_page_number: t.pages[1] }
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'citations_delta', citation } }])
    }
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t.text } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
  })
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }])
  events.push(['message_stop', { type: 'message_stop' }])
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
}

describe('assistant conversation', () => {
  it('sends the PDF once with citations and caching, and reads cited pages', async () => {
    const bodies: Record<string, unknown>[] = []
    const headers: Headers[] = []
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      headers.push(new Headers(init.headers))
      const reply = bodies.length === 1 ? [{ text: 'Rent is $1,350 a month.', pages: [2, 3] as [number, number] }, { text: ' Nothing else.' }] : [{ text: 'No pets.', pages: [1, 1] as [number, number] }]
      return new Response(sse(reply), { headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof globalThis.fetch

    const conv = new Conversation('sk-ant-test', new Uint8Array([37, 80, 68, 70]), 'lease.pdf', fetch)
    const seen: number[] = []
    const first = await conv.ask('What is the rent?', (p) => seen.push(p.length))
    expect(first).toEqual([
      { text: 'Rent is $1,350 a month.', pages: [2] },
      { text: ' Nothing else.', pages: [] },
    ])
    expect(seen.length).toBeGreaterThan(0)

    const req = bodies[0] as { model: string; fallbacks: string; messages: { content: { type: string; source?: { data: string }; citations?: unknown; cache_control?: unknown }[] }[] }
    expect(req.model).toBe(MODEL)
    expect(req.fallbacks).toBe('default')
    expect(headers[0].get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')
    expect(headers[0].get('authorization')).toBe('Bearer sk-ant-test')
    const doc = req.messages[0].content[0]
    expect(doc.type).toBe('document')
    expect(doc.source?.data).toBe(btoa('%PDF'))
    expect(doc.citations).toEqual({ enabled: true })
    expect(doc.cache_control).toEqual({ type: 'ephemeral' })

    // A follow-up keeps the earlier turn (with the document) and adds only the new question.
    const second = await conv.ask('Are pets allowed?', () => {})
    expect(second).toEqual([{ text: 'No pets.', pages: [1] }])
    const msgs = (bodies[1] as { messages: { role: string; content: { type: string }[] }[] }).messages
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(msgs[0].content[0].type).toBe('document')
    expect(msgs[2].content).toEqual([{ type: 'text', text: 'Are pets allowed?' }])
  })
})
