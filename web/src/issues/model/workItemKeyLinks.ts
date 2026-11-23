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

/** Options of the key link remark plugin. */
export type WorkItemKeyLinkOptions = {
  /** Key prefixes that exist in the Workspace; when omitted, every key-shaped word is linked. */
  prefixes?: ReadonlySet<string>
}

/**
 * Remark plugin that turns Work Item keys in Markdown text into links to the key's page.
 *
 * @param options - Known key prefixes, so words such as `UTF-8` stay text.
 * @returns A transformer that rewrites the Markdown syntax tree in place.
 */
export function remarkWorkItemKeyLinks(options: WorkItemKeyLinkOptions = {}) {
  return (tree: MarkdownNode) => {
    linkWorkItemKeys(tree, options.prefixes)
  }
}

/**
 * Replaces text children that contain keys with text and link nodes.
 *
 * @param node - Node whose children are rewritten.
 * @param prefixes - Known key prefixes, or undefined to link every key-shaped word.
 */
function linkWorkItemKeys(node: MarkdownNode, prefixes: ReadonlySet<string> | undefined) {
  if (!node.children || nodesWithoutKeyLinks.has(node.type)) return
  node.children = node.children.flatMap((child) => {
    if (child.type !== 'text' || !child.value) {
      linkWorkItemKeys(child, prefixes)
      return [child]
    }
    return splitTextAtWorkItemKeys(child.value, prefixes)
  })
}

/**
 * Splits one text value into text and key link nodes.
 *
 * @param value - Text node value.
 * @param prefixes - Known key prefixes, or undefined to link every key-shaped word.
 * @returns The same text as nodes, with each key as a link.
 */
function splitTextAtWorkItemKeys(value: string, prefixes: ReadonlySet<string> | undefined): MarkdownNode[] {
  const nodes: MarkdownNode[] = []
  let offset = 0
  for (const { key, index } of findWorkItemKeys(value, prefixes)) {
    if (index > offset) nodes.push({ type: 'text', value: value.slice(offset, index) })
    nodes.push({ type: 'link', url: createWorkItemKeyPath(key), children: [{ type: 'text', value: key }] })
    offset = index + key.length
  }
  if (offset < value.length) nodes.push({ type: 'text', value: value.slice(offset) })
  return nodes
}
