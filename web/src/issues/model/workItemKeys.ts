import { isCanonicalWorkItemKey } from '@mukuroji/contracts'
import { createWorkItemKeyPath } from '../../shared/routing/paths'

/**
 * Finds `ABC-123` keys that stand alone in text, so `x-ABC-1` or `ABC-12a` are not keys.
 * Kept in step with the key format in `@mukuroji/contracts`.
 */
const workItemKeyInTextPattern = /(?<![\p{L}\p{N}_-])[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8}(?![\p{L}\p{N}_-])/gu

/** One Work Item key found in text. */
export type WorkItemKeyMatch = {
  /** The canonical key, such as `PT-12`. */
  key: string
  /** UTF-16 offset of the key in the text. */
  index: number
}

/**
 * Finds the Work Item keys written in plain text.
 *
 * @param text - Text such as a comment or a description.
 * @returns Each key in the order it appears, without duplicates removed.
 */
export function findWorkItemKeys(text: string): WorkItemKeyMatch[] {
  return Array.from(text.matchAll(workItemKeyInTextPattern), (match) => ({
    key: match[0],
    index: match.index,
  }))
}

/**
 * Reads what a person typed as a Work Item key, accepting lower case and surrounding spaces.
 *
 * @param value - Typed text, such as a search keyword.
 * @returns The canonical key, or undefined when the text is not one key.
 */
export function readWorkItemKeyInput(value: string | undefined): string | undefined {
  const candidate = value?.trim().toUpperCase()
  return candidate && isCanonicalWorkItemKey(candidate) ? candidate : undefined
}

/** The Markdown syntax tree shape this module reads and writes. */
type MarkdownNode = {
  /** mdast node kind, such as `text`, `link`, or `inlineCode`. */
  type: string
  /** Literal text of a `text` or code node. */
  value?: string
  /** Destination of a `link` node. */
  url?: string
  /** Child nodes of a parent node, such as a paragraph or a link. */
  children?: MarkdownNode[]
}

/** Nodes whose text must stay as written: links already point somewhere, and code is literal. */
const nodesWithoutKeyLinks = new Set(['code', 'definition', 'html', 'inlineCode', 'link', 'linkReference'])

/**
 * Remark plugin that turns Work Item keys in Markdown text into links to the key's page.
 *
 * @returns A transformer that rewrites the Markdown syntax tree in place.
 */
export function remarkWorkItemKeyLinks() {
  return (tree: MarkdownNode) => {
    linkWorkItemKeys(tree)
  }
}

/**
 * Replaces text children that contain keys with text and link nodes.
 *
 * @param node - Node whose children are rewritten.
 */
function linkWorkItemKeys(node: MarkdownNode) {
  if (!node.children || nodesWithoutKeyLinks.has(node.type)) return
  node.children = node.children.flatMap((child) => {
    if (child.type !== 'text' || !child.value) {
      linkWorkItemKeys(child)
      return [child]
    }
    return splitTextAtWorkItemKeys(child.value)
  })
}

/**
 * Splits one text value into text and key link nodes.
 *
 * @param value - Text node value.
 * @returns The same text as nodes, with each key as a link.
 */
function splitTextAtWorkItemKeys(value: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = []
  let offset = 0
  for (const { key, index } of findWorkItemKeys(value)) {
    if (index > offset) nodes.push({ type: 'text', value: value.slice(offset, index) })
    nodes.push({ type: 'link', url: createWorkItemKeyPath(key), children: [{ type: 'text', value: key }] })
    offset = index + key.length
  }
  if (offset < value.length) nodes.push({ type: 'text', value: value.slice(offset) })
  return nodes
}
