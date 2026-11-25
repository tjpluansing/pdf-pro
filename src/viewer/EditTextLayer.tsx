import { useEffect, useRef, useState } from 'react'
import type { TextLine } from '../engine/pdfium'
import type { DocHandle } from './client'

interface Props {
  doc: DocHandle
  pageIndex: number
  zoom: number
  busy: boolean
  onEdit: (line: TextLine, text: string) => void
  onError: (err: unknown) => void
}

/**
 * Edit text mode for one page: every line of text gets an outline on hover;
 * click one to retype it in place. Enter or clicking away saves, Escape cancels.
 * Lines load the first time the pointer comes over the page.
 */
export function EditTextLayer({ doc, pageIndex, zoom, busy, onEdit, onError }: Props) {
  const [wanted, setWanted] = useState(false)
  const [lines, setLines] = useState<TextLine[] | null>(null)
  const [editing, setEditing] = useState<{ line: TextLine; text: string } | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!wanted) return
    let live = true
    doc.textLines(pageIndex).then((l) => live && setLines(l), onError)
    return () => {
      live = false
    }
  }, [doc, pageIndex, wanted, onError])

  const editingLine = editing?.line
  useEffect(() => {
    if (editingLine) input.current?.select()
  }, [editingLine])

  const finish = (save: boolean) => {
    if (!editing) return
    setEditing(null)
    if (save && editing.text !== editing.line.text) onEdit(editing.line, editing.text)
  }

  return (
    <div className="edit-text-layer" onPointerEnter={() => setWanted(true)} onFocus={() => setWanted(true)}>
      {lines?.map((line) =>
        editing?.line === line ? null : (
          <button
            key={line.objects.join()}
            type="button"
            className="text-line"
            disabled={busy}
            title="Click to edit this line"
            aria-label={`Edit “${line.text}”`}
            style={{ left: line.rect.x * zoom - 2, top: line.rect.y * zoom - 2, width: line.rect.width * zoom + 4, height: line.rect.height * zoom + 4 }}
            onClick={() => setEditing({ line, text: line.text })}
          />
        ),
      )}
      {editing && (
        <input
          ref={input}
          className="text-line-input"
          aria-label="Line text"
          value={editing.text}
          spellCheck
          style={{
            left: editing.line.rect.x * zoom - 3,
            top: editing.line.rect.y * zoom - 3,
            minWidth: editing.line.rect.width * zoom + 24,
            width: `${Math.max(editing.text.length, 4) * 0.6 * editing.line.size * zoom + 24}px`,
            height: editing.line.rect.height * zoom + 6,
            fontSize: editing.line.size * zoom,
            color: editing.line.color,
            fontWeight: editing.line.bold ? 700 : 400,
            fontStyle: editing.line.italic ? 'italic' : 'normal',
            fontFamily: editing.line.mono ? 'Courier New, monospace' : editing.line.serif ? 'Times New Roman, serif' : 'Helvetica, Arial, sans-serif',
          }}
          onChange={(e) => setEditing({ ...editing, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') finish(true)
            if (e.key === 'Escape') finish(false)
            e.stopPropagation()
          }}
          onBlur={() => finish(true)}
        />
      )}
    </div>
  )
}
