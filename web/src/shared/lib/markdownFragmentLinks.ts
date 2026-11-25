/** The HTML syntax tree shape this module reads and writes. */
type HtmlNode = {
  /** hast node kind, such as `element` or `text`. */
  type: string
  /** Element name of an `element` node. */
  tagName?: string
  /** Element attributes of an `element` node. */
  properties?: Record<string, unknown>
  /** Child nodes of a parent node. */
  children?: HtmlNode[]
}

/** Options of {@link rehypePrefixFragmentLinks}. */
export type PrefixFragmentLinksOptions = {
  /** Start of the ids this Markdown made, such as its footnote ids, before sanitizing. */
  localPrefix: string
  /** Prefix the sanitizer put before every id. */
  prefix: string
}

/**
 * Id that the Markdown renderer gives every footnote heading whatever its prefix option, which
 * footnote references name in `aria-describedby`.
 */
const FOOTNOTE_LABEL_ID = 'footnote-label'

/**
 * Rehype plugin that keeps the ids of one Markdown body its own after sanitizing. The sanitizer
 * prefixes ids but not `#` links, so a link to `#<localPrefix>…` gets the same prefix. The
 * footnote heading id is always the same, so it and the references that name it get the local
 * prefix too. Links to other places stay as written.
 *
 * @param options - Start of this body's ids and the sanitizer's prefix.
 * @returns A transformer that rewrites the syntax tree in place.
 */
export function rehypePrefixFragmentLinks(options: PrefixFragmentLinksOptions) {
  return (tree: HtmlNode) => {
    prefixFragmentLinks(tree, {
      from: `#${options.localPrefix}`,
      label: `${options.prefix}${FOOTNOTE_LABEL_ID}`,
      localLabel: `${options.prefix}${options.localPrefix}${FOOTNOTE_LABEL_ID}`,
      to: `#${options.prefix}${options.localPrefix}`,
    })
  }
}

/** Rewrites that {@link prefixFragmentLinks} applies to one body. */
type FragmentRewrite = {
  /** Fragment start to replace. */
  from: string
  /** Fragment start that replaces it. */
  to: string
  /** Footnote heading id after sanitizing, shared by every body. */
  label: string
  /** Footnote heading id of this body. */
  localLabel: string
}

/**
 * Rewrites, below one node, the `href` of every link that starts with a local fragment, and the
 * footnote heading id and the references to it.
 *
 * @param node - Node whose descendants are rewritten.
 * @param rewrite - Values to replace and their replacements.
 */
function prefixFragmentLinks(node: HtmlNode, rewrite: FragmentRewrite) {
  for (const child of node.children ?? []) {
    const properties = child.properties
    if (properties) {
      const href = properties.href
      if (child.tagName === 'a' && typeof href === 'string' && href.startsWith(rewrite.from)) {
        properties.href = `${rewrite.to}${href.slice(rewrite.from.length)}`
      }
      if (properties.id === rewrite.label) properties.id = rewrite.localLabel
      const describedBy = properties.ariaDescribedBy
      if (Array.isArray(describedBy)) {
        properties.ariaDescribedBy = describedBy.map((id) => id === rewrite.label ? rewrite.localLabel : id)
      }
    }
    prefixFragmentLinks(child, rewrite)
  }
}

/** The Markdown syntax tree shape {@link remarkNumberFootnotes} reads and writes. */
type MarkdownTreeNode = {
  /** mdast node kind, such as `footnoteReference`. */
  type: string
  /** Normalized label of a footnote reference or definition. */
  identifier?: unknown
  /** Label of a footnote reference or definition as written. */
  label?: unknown
  /** Child nodes of a parent node. */
  children?: MarkdownTreeNode[]
}

/**
 * Remark plugin that renames every footnote label of one body to `f<n>`, numbered by first use.
 * The renderer names the n-th reuse of label `a` `fnref-a-n`, which is also the first reference
 * of a label `a-n`; numbered labels never end like a reuse, so every reference keeps its own id
 * and each footnote links back to its own reference. Footnotes show their number, not their
 * label, so the rendering does not change.
 *
 * @returns A transformer that rewrites the syntax tree in place.
 */
export function remarkNumberFootnotes() {
  return (tree: MarkdownTreeNode) => {
    const numbers = new Map<string, string>()
    const pending: MarkdownTreeNode[] = [tree]
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (
        (node.type === 'footnoteReference' || node.type === 'footnoteDefinition') &&
        typeof node.identifier === 'string'
      ) {
        const number = numbers.get(node.identifier) ?? `f${numbers.size + 1}`
        numbers.set(node.identifier, number)
        node.identifier = number
        node.label = number
      }
      if (node.children) pending.push(...node.children)
    }
  }
}
