/**
 * Parses a page range such as "1-3, 5, 8-" into 0-based page indexes.
 * Blank means every page. Returns an error message for anything it can't read.
 */
export function parsePageRange(input: string, pageCount: number): number[] | string {
  const text = input.trim()
  if (!text) return Array.from({ length: pageCount }, (_, i) => i)
  const pages = new Set<number>()
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part) ?? /^(\d+)()$/.exec(part)
    if (!m || (!m[1] && !m[2])) return `“${part}” is not a page or a range like 2-5`
    const single = !part.match(/[-–]/)
    const from = m[1] ? Number(m[1]) : 1
    const to = single ? from : m[2] ? Number(m[2]) : pageCount
    if (from < 1 || to > pageCount || from > to) return `Pages go from 1 to ${pageCount}`
    for (let p = from; p <= to; p++) pages.add(p - 1)
  }
  return [...pages].sort((a, b) => a - b)
}
