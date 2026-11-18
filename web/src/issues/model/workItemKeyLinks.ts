import { createWorkItemKeyPath } from '../../shared/routing/paths'
import { findWorkItemKeys } from '../../work-items/model/workItemKeys'

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
