import type { DocumentNode } from '@mukuroji/contracts'

/**
 * Upper bound of pages a single subtree export downloads, so one click cannot
 * fan out into an unbounded number of export requests.
 */
export const SUBTREE_EXPORT_PAGE_LIMIT = 200

/**
 * One node of a subtree export in depth-first order.
 */
export type SubtreeExportEntry = {
  /**
   * Permission-filtered tree node visible to the current user.
   */
  node: DocumentNode
  /**
   * Depth relative to the export root; the root itself is 0.
   */
  depth: number
}

/**
 * Exported content of one subtree node. Folders and nodes the user cannot
 * export carry no Markdown and only contribute a heading.
 */
export type SubtreeExportSection = SubtreeExportEntry & {
  /**
   * Markdown rendered by the per-document export API, if any.
   */
  markdown?: string
}

/**
 * Returns whether a node's own content is exported as Markdown.
 *
 * @param node - Tree node to inspect.
 * @returns True for exportable, active pages and templates.
 */
export function isMarkdownExportable(node: DocumentNode): boolean {
  return (
    (node.kind === 'page' || node.kind === 'template') &&
    node.capabilities.canExport &&
    !node.archivedAt
  )
}

/**
 * Collects the root and its active descendants from a permission-filtered
 * tree in depth-first order, siblings sorted by position.
 *
 * Only nodes present in `nodes` are included, so pages the server did not
 * return to the current user can never be part of the export.
 *
 * @param rootId - Document ID the export starts from.
 * @param nodes - Permission-filtered tree nodes returned by the API.
 * @returns Ordered entries, or an empty list when the root is not visible.
 */
export function collectSubtreeEntries(
  rootId: string,
  nodes: readonly DocumentNode[],
): SubtreeExportEntry[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const root = byId.get(rootId)
  if (!root || root.archivedAt) return []
  const children = new Map<string, DocumentNode[]>()
  for (const node of byId.values()) {
    if (!node.parentId || node.archivedAt) continue
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  }
  for (const siblings of children.values()) {
    siblings.sort(compareSiblings)
  }
  const entries: SubtreeExportEntry[] = []
  const visited = new Set<string>()
  const stack: SubtreeExportEntry[] = [{ node: root, depth: 0 }]
  while (stack.length > 0) {
    const entry = stack.pop()
    if (!entry || visited.has(entry.node.id)) continue
    visited.add(entry.node.id)
    entries.push(entry)
    const nested = children.get(entry.node.id) ?? []
    for (let index = nested.length - 1; index >= 0; index -= 1) {
      const child = nested[index]
      if (child) stack.push({ node: child, depth: entry.depth + 1 })
    }
  }
  return entries
}

/**
 * Joins per-page Markdown into one file whose heading levels follow the tree
 * hierarchy: each page's headings are demoted by its depth.
 *
 * @param sections - Ordered sections from {@link collectSubtreeEntries}.
 * @returns Combined Markdown document.
 */
export function buildSubtreeMarkdown(
  sections: readonly SubtreeExportSection[],
): string {
  const parts = sections.map((section) => {
    if (section.markdown !== undefined) {
      return demoteMarkdownHeadings(section.markdown.trim(), section.depth)
    }
    const level = Math.min(section.depth + 1, 6)
    return `${'#'.repeat(level)} ${section.node.title.trim() || 'Untitled'}`
  })
  return `${parts.join('\n\n')}\n`
}

/**
 * Demotes ATX headings outside fenced code blocks by `levels`, capping at h6.
 *
 * @param markdown - Markdown to rewrite.
 * @param levels - Number of levels to demote.
 * @returns Markdown with demoted headings.
 */
export function demoteMarkdownHeadings(
  markdown: string,
  levels: number,
): string {
  if (levels <= 0) return markdown
  let fence: string | undefined
  return markdown
    .split('\n')
    .map((line) => {
      const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
      if (fenceMatch?.[1]) {
        const marker = fenceMatch[1]
        if (fence === undefined) fence = marker
        else if (marker[0] === fence[0] && marker.length >= fence.length) {
          fence = undefined
        }
        return line
      }
      if (fence !== undefined) return line
      const heading = /^(#{1,6})(\s.*|)$/.exec(line)
      if (!heading?.[1]) return line
      const level = Math.min(heading[1].length + levels, 6)
      return `${'#'.repeat(level)}${heading[2] ?? ''}`
    })
    .join('\n')
}

/**
 * Builds a file-system safe Markdown file name for a subtree export.
 *
 * @param title - Root document title.
 * @returns File name ending in `.md`.
 */
export function subtreeExportFileName(title: string): string {
  const base = Array.from(title, (character) =>
    character.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(character)
      ? '_'
      : character,
  )
    .join('')
    .trim()
    .slice(0, 120)
  return `${base || 'documents'}.md`
}

/**
 * Orders siblings by fractional position, then title for stable output.
 *
 * @param left - First sibling.
 * @param right - Second sibling.
 * @returns Sort comparison result.
 */
function compareSiblings(left: DocumentNode, right: DocumentNode): number {
  if (left.position !== right.position) {
    return left.position < right.position ? -1 : 1
  }
  return left.title.localeCompare(right.title)
}
