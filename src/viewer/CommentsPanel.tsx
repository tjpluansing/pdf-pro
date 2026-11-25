import { useEffect, useRef, useState } from 'react'
import type { Annotation, AnnotKind } from '../engine/pdfium'

const LABELS: Record<AnnotKind, string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'Strikethrough',
  squiggly: 'Squiggly underline',
  note: 'Note',
  freetext: 'Text box',
  ink: 'Drawing',
  square: 'Rectangle',
  circle: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  stamp: 'Stamp',
  other: 'Annotation',
}

interface Props {
  annotations: Annotation[] | null
  selectedId: string | null
  author: string
  onAuthor: (name: string) => void
  onSelect: (a: Annotation) => void
  onComment: (a: Annotation, contents: string) => void
  onDelete: (a: Annotation) => void
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''

/** The list of comments and markup down the right side in Comment mode. */
export function CommentsPanel({ annotations, selectedId, author, onAuthor, onSelect, onComment, onDelete }: Props) {
  const [filter, setFilter] = useState('')
  const q = filter.trim().toLowerCase()
  const shown = (annotations ?? []).filter(
    (a) => !q || `${a.contents} ${a.author} ${LABELS[a.kind]}`.toLowerCase().includes(q),
  )
  const list = useRef<HTMLOListElement>(null)

  useEffect(() => {
    list.current?.querySelector('.comment.on')?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  return (
    <aside className="comments" aria-label="Comments">
      <div className="comments-head">
        <strong>Comments</strong>
        <span className="count">{annotations ? annotations.length : '…'}</span>
      </div>
      <label className="comments-field">
        Your name{' '}
        <input
          defaultValue={author}
          placeholder="Shown on new comments"
          onBlur={(e) => onAuthor(e.currentTarget.value.trim())}
        />
      </label>
      <input
        className="comments-field"
        type="search"
        placeholder="Filter comments"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {annotations && annotations.length === 0 && (
        <p className="hint comments-empty">No comments yet. Pick a tool above and mark up the page.</p>
      )}
      <ol ref={list} className="comment-list">
        {shown.map((a) => (
          <Comment
            key={`${a.pageIndex}:${a.id}`}
            a={a}
            on={a.id === selectedId}
            onSelect={() => onSelect(a)}
            onComment={(text) => onComment(a, text)}
            onDelete={() => onDelete(a)}
          />
        ))}
      </ol>
    </aside>
  )
}

function Comment({
  a,
  on,
  onSelect,
  onComment,
  onDelete,
}: {
  a: Annotation
  on: boolean
  onSelect: () => void
  onComment: (text: string) => void
  onDelete: () => void
}) {
  const box = useRef<HTMLTextAreaElement>(null)
  // A note that was just placed has no text yet: put the cursor in its box.
  useEffect(() => {
    if (on && a.kind === 'note' && !a.contents) box.current?.focus()
  }, [on, a.kind, a.contents])

  return (
    <li className={on ? 'comment on' : 'comment'} onClick={onSelect}>
      <div className="comment-meta">
        <span className="swatch" style={{ background: a.color ?? 'transparent' }} />
        <span className="comment-kind">{LABELS[a.kind]}</span>
        <span className="comment-page">p. {a.pageIndex + 1}</span>
        <button
          className="icon"
          aria-label={`Delete ${LABELS[a.kind].toLowerCase()} on page ${a.pageIndex + 1}`}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          ×
        </button>
      </div>
      {(a.author || a.modified) && (
        <div className="comment-by">
          {a.author}
          {a.author && a.modified ? ' · ' : ''}
          {when(a.modified)}
        </div>
      )}
      <textarea
        ref={box}
        key={a.contents}
        className="comment-text"
        defaultValue={a.contents}
        placeholder={a.kind === 'freetext' ? 'Text' : 'Add a comment'}
        rows={Math.min(6, Math.max(1, a.contents.split('\n').length))}
        onBlur={(e) => {
          const v = e.currentTarget.value
          if (v !== a.contents) onComment(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.blur()
          if (e.key === 'Escape') {
            e.currentTarget.value = a.contents
            e.currentTarget.blur()
          }
        }}
      />
    </li>
  )
}
