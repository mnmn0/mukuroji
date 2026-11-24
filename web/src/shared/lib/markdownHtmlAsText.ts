/** The Markdown syntax tree shape this module reads and writes. */
type MarkdownNode = {
  /** mdast node kind, such as `html` or `text`. */
  type: string
  /** Literal text of a `text` or `html` node. */
  value?: string
  /** Child nodes of a parent node. */
  children?: MarkdownNode[]
}

/**
 * Remark plugin that turns raw HTML in Markdown into literal text, so prose such as `<div>` stays
 * readable without ever being parsed as HTML.
 *
 * @returns A transformer that rewrites the Markdown syntax tree in place.
 */
export function remarkHtmlAsText() {
  return (tree: MarkdownNode) => {
    convertHtmlNodes(tree)
  }
}

/**
 * Rewrites every `html` node below one node into a `text` node with the same source.
 *
 * @param node - Node whose descendants are rewritten.
 */
function convertHtmlNodes(node: MarkdownNode) {
  for (const child of node.children ?? []) {
    if (child.type === 'html') {
      child.type = 'text'
      continue
    }
    convertHtmlNodes(child)
  }
}
