/**
 * Element of a parsed XML document.
 */
export type XmlElement = {
  /** Local name without the namespace prefix. */
  name: string
  /** Attributes by local name. */
  attributes: Record<string, string>
  /** Child elements and text in document order. */
  children: XmlNode[]
}

/**
 * Child of an XML element: an element or decoded text.
 */
export type XmlNode = XmlElement | string

/** Error for XML that this reader does not accept. */
export class XmlDocumentError extends Error {
  /**
   * Creates the error.
   *
   * @param message - Explanation of the rejected input.
   */
  constructor(message: string) {
    super(message)
    this.name = 'XmlDocumentError'
  }
}

/** Entities that XML defines without a document type declaration. */
const predefinedEntities = new Map([['lt', '<'], ['gt', '>'], ['amp', '&'], ['quot', '"'], ['apos', "'"]])

/** Deepest element nesting accepted, so a hostile file cannot exhaust the stack. */
const maxDepth = 64

/**
 * Parses an XML document into elements.
 *
 * Only the XML that spreadsheet and project files use is read: a document type declaration is
 * rejected, so no external or custom entity is ever expanded.
 *
 * @param text - XML text.
 * @returns The root element.
 * @throws XmlDocumentError when the text is not well-formed or declares a document type.
 */
export function parseXmlDocument(text: string): XmlElement {
  const source = text.replace(/^\ufeff/u, '')
  const stack: XmlElement[] = []
  let root: XmlElement | undefined
  let index = 0
  while (index < source.length) {
    const open = source.indexOf('<', index)
    const textEnd = open < 0 ? source.length : open
    if (textEnd > index) {
      const value = decodeXmlEntities(source.slice(index, textEnd))
      const parent = stack[stack.length - 1]
      if (parent) parent.children.push(value)
      else if (value.trim()) throw new XmlDocumentError('Text appears outside the root element.')
    }
    if (open < 0) break
    if (source.startsWith('<?', open)) {
      index = requireIndex(source.indexOf('?>', open), 'A processing instruction is not closed.') + 2
      continue
    }
    if (source.startsWith('<!--', open)) {
      index = requireIndex(source.indexOf('-->', open), 'A comment is not closed.') + 3
      continue
    }
    if (source.startsWith('<![CDATA[', open)) {
      const end = requireIndex(source.indexOf(']]>', open), 'A CDATA section is not closed.')
      const parent = stack[stack.length - 1]
      if (!parent) throw new XmlDocumentError('CDATA appears outside the root element.')
      parent.children.push(source.slice(open + 9, end))
      index = end + 3
      continue
    }
    if (source.startsWith('<!', open)) {
      throw new XmlDocumentError('Document type declarations are not supported.')
    }
    const close = findTagEnd(source, open)
    const tag = source.slice(open + 1, close)
    index = close + 1
    if (tag.startsWith('/')) {
      const name = localName(tag.slice(1).trim())
      const element = stack.pop()
      if (!element || element.name !== name) throw new XmlDocumentError(`Unexpected closing tag </${name}>.`)
      continue
    }
    const selfClosing = tag.endsWith('/')
    const element = parseStartTag(selfClosing ? tag.slice(0, -1) : tag)
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(element)
    else if (root) throw new XmlDocumentError('A document can have only one root element.')
    else root = element
    if (!selfClosing) {
      stack.push(element)
      if (stack.length > maxDepth) throw new XmlDocumentError('Elements are nested too deeply.')
    }
  }
  if (!root || stack.length > 0) throw new XmlDocumentError('The document is not complete.')
  return root
}

/**
 * Lists the child elements of an element, optionally with one name.
 *
 * @param element - Parent element.
 * @param name - Local name to keep.
 * @returns Matching child elements in order.
 */
export function childElements(element: XmlElement, name?: string): XmlElement[] {
  return element.children.filter((child): child is XmlElement =>
    typeof child !== 'string' && (name === undefined || child.name === name))
}

/**
 * Finds the first child element with a name.
 *
 * @param element - Parent element.
 * @param name - Local name.
 * @returns The child, if any.
 */
export function childElement(element: XmlElement, name: string): XmlElement | undefined {
  return childElements(element, name)[0]
}

/**
 * Joins all text inside an element.
 *
 * @param element - Element to read.
 * @returns Its decoded text content.
 */
export function textContent(element: XmlElement | undefined): string {
  if (!element) return ''
  return element.children.map((child) => typeof child === 'string' ? child : textContent(child)).join('')
}

/**
 * Escapes text for an XML element or attribute value.
 *
 * Characters that XML 1.0 cannot carry are dropped.
 *
 * @param value - Text to write.
 * @returns Escaped text.
 */
export function escapeXml(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/gu, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Finds the `>` that ends a tag, skipping quoted attribute values.
 *
 * @param source - Document text.
 * @param open - Index of the tag's `<`.
 * @returns Index of the closing `>`.
 */
function findTagEnd(source: string, open: number) {
  let quote: string | undefined
  for (let index = open + 1; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === quote) quote = undefined
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return index
    }
  }
  throw new XmlDocumentError('A tag is not closed.')
}

/**
 * Parses the name and attributes of a start tag.
 *
 * @param tag - Tag text between `<` and `>` without a trailing `/`.
 * @returns The element without children.
 */
function parseStartTag(tag: string): XmlElement {
  const nameMatch = /^\s*([^\s/>]+)/u.exec(tag)
  if (!nameMatch) throw new XmlDocumentError('A tag has no name.')
  const attributes: Record<string, string> = {}
  const attributePattern = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/gu
  const rest = tag.slice(nameMatch[0].length)
  let consumed = 0
  for (const match of rest.matchAll(attributePattern)) {
    if (rest.slice(consumed, match.index).trim()) throw new XmlDocumentError('An attribute is malformed.')
    consumed = match.index + match[0].length
    attributes[localName(match[1]!)] = decodeXmlEntities(match[3] ?? match[4] ?? '')
  }
  if (rest.slice(consumed).trim()) throw new XmlDocumentError('An attribute is malformed.')
  return { name: localName(nameMatch[1]!), attributes, children: [] }
}

/**
 * Removes the namespace prefix of a name.
 *
 * @param name - Qualified name.
 * @returns The local name.
 */
function localName(name: string) {
  const separator = name.indexOf(':')
  return separator < 0 ? name : name.slice(separator + 1)
}

/**
 * Decodes the predefined and numeric character references.
 *
 * @param value - Raw text.
 * @returns Decoded text.
 * @throws XmlDocumentError for any other entity.
 */
function decodeXmlEntities(value: string) {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);/gu, (_match, entity: string) => {
    if (entity.startsWith('#')) {
      const codePoint = entity.startsWith('#x')
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10)
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        throw new XmlDocumentError('A character reference is invalid.')
      }
      return String.fromCodePoint(codePoint)
    }
    const decoded = predefinedEntities.get(entity)
    if (decoded === undefined) throw new XmlDocumentError(`The entity &${entity}; is not supported.`)
    return decoded
  })
}

/**
 * Requires that a search found its target.
 *
 * @param index - Search result.
 * @param message - Error message when it did not.
 * @returns The index.
 */
function requireIndex(index: number, message: string) {
  if (index < 0) throw new XmlDocumentError(message)
  return index
}
