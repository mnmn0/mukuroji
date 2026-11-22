import type { DocumentBlock } from '@mukuroji/contracts'
import {
  convertMarkdownToDocument,
  titleFromMarkdownFileName,
  type MarkdownImportErrorCode,
} from './markdownImport'

/** Most Markdown files one folder import creates pages from. */
export const MARKDOWN_FOLDER_IMPORT_MAX_FILES = 200

/**
 * Most folder levels an import may create. The server allows a tree depth of
 * 32, and the deepest page sits one level below its folder.
 */
const MAX_FOLDER_DEPTH = 31

/** Most characters a page or folder title may hold, matching the server. */
const MAX_TITLE_LENGTH = 500

/** File extensions read as Markdown when importing a folder. */
const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdown|mkd)$/iu

/** Directory names skipped when importing a folder. */
const SKIPPED_DIRECTORIES = new Set(['node_modules'])

/** URL scheme at the start of a link target, such as `https:`. */
const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/u

/**
 * Reason a folder cannot be imported. Besides the reasons one page can fail,
 * a folder can hold no Markdown file, too many files, or too deep a tree.
 */
export type MarkdownFolderImportErrorCode =
  | MarkdownImportErrorCode
  | 'no-markdown-files'
  | 'too-many-files'
  | 'too-deep'

/**
 * Why a folder import created nothing, and which file caused it.
 */
export type MarkdownFolderImportFailure = {
  /** Why the folder cannot be imported. */
  code: MarkdownFolderImportErrorCode
  /** File that failed, when one file is the reason. */
  path?: string
}

/**
 * One Markdown file read from the chosen folder.
 */
export type MarkdownFolderFile = {
  /** Path inside the chosen folder with `/` separators, including its name. */
  path: string
  /** Markdown text of the file. */
  source: string
}

/**
 * Files and destination chosen for one folder import.
 */
export type MarkdownFolderImportRequest = {
  /** Markdown files of the folder, in any order. */
  files: MarkdownFolderFile[]
  /** Project that owns the new pages; omission creates them in the Workspace. */
  projectId?: string
}

/**
 * Folder Document the import creates for one directory.
 */
export type MarkdownFolderPlanFolder = {
  /** Directory path, which identifies the folder within the plan. */
  key: string
  /** Folder title, the directory name. */
  title: string
  /** Key of the parent folder; omission puts it at the root of the scope. */
  parentKey?: string
  /** Order among all planned nodes, used for the sibling position. */
  order: number
}

/**
 * Page the import creates for one Markdown file.
 */
export type MarkdownFolderPlanPage = {
  /** File path, which identifies the page within the plan. */
  key: string
  /** Page title. */
  title: string
  /** Key of the parent folder; omission puts it at the root of the scope. */
  parentKey?: string
  /** Order among all planned nodes, used for the sibling position. */
  order: number
  /**
   * Page blocks. Links to other imported pages hold placeholders that
   * {@link resolveImportedPageLinks} replaces once those pages exist.
   */
  blocks: DocumentBlock[]
}

/**
 * Folders and pages to create, in an order where each parent comes first.
 */
export type MarkdownFolderImportPlan = {
  /** Folders, parents before children. */
  folders: MarkdownFolderPlanFolder[]
  /**
   * Pages, ordered so that the pages a page links to come before it where
   * links do not form a cycle.
   */
  pages: MarkdownFolderPlanPage[]
  /** Key of the folder that holds everything, when there is exactly one. */
  rootKey?: string
  /** Placeholder link targets, by the key of the page they point to. */
  placeholders: Map<string, string>
}

/**
 * Plan of a folder import, or why the folder cannot be imported.
 */
export type MarkdownFolderPlanResult =
  | {
      /** Discriminator of a successful plan. */
      ok: true
      /** Folders and pages to create. */
      plan: MarkdownFolderImportPlan
    }
  | {
      /** Discriminator of a failed plan. */
      ok: false
      /** Why the folder cannot be imported. */
      code: MarkdownFolderImportErrorCode
      /** File that failed, when one file is the reason. */
      path?: string
    }

/**
 * Options for planning a folder import.
 */
export type MarkdownFolderPlanOptions = {
  /** Returns a fresh ID with the given prefix. */
  createId: (prefix: string) => string
}

/**
 * Checks whether a file in the chosen folder is imported, which is when it
 * has a Markdown extension and no directory on its path is hidden or
 * `node_modules`.
 *
 * @param path - Path inside the chosen folder with `/` separators.
 * @returns Whether the file becomes a page.
 */
export function isImportableMarkdownPath(path: string): boolean {
  const segments = path.split('/')
  const directories = segments.slice(0, -1)
  const name = segments.at(-1) ?? ''
  return (
    MARKDOWN_EXTENSION.test(name) &&
    !name.startsWith('.') &&
    directories.every(
      (segment) => !segment.startsWith('.') && !SKIPPED_DIRECTORIES.has(segment),
    )
  )
}

/**
 * Converts the Markdown files of a folder into the folders and pages to
 * create, keeping the directory tree.
 *
 * Every directory becomes a folder and every file a page. A relative link
 * from one file to another, such as `[Setup](../guide/setup.md#install)`,
 * points at the page made from that file; a link to a directory points at
 * its `README.md` or `index.md`. Links to files outside the import stay as
 * written. Nothing is created when any file cannot become a page.
 *
 * @param files - Markdown files of the folder.
 * @param options - ID factory.
 * @returns The plan, or why the folder cannot be imported.
 */
export function planMarkdownFolderImport(
  files: readonly MarkdownFolderFile[],
  options: MarkdownFolderPlanOptions,
): MarkdownFolderPlanResult {
  const sorted = files
    .map((file) => ({ ...file, path: normalizeFilePath(file.path) }))
    .filter((file) => file.path !== '')
    .sort((left, right) => comparePaths(left.path, right.path))
  if (sorted.length === 0) return { ok: false, code: 'no-markdown-files' }
  if (sorted.length > MARKDOWN_FOLDER_IMPORT_MAX_FILES) {
    return { ok: false, code: 'too-many-files' }
  }

  const keys = new Set(sorted.map((file) => file.path))
  const lowerCaseKeys = new Map<string, string>()
  for (const key of keys) {
    const lower = key.toLowerCase()
    if (!lowerCaseKeys.has(lower)) lowerCaseKeys.set(lower, key)
  }
  const nonce = options.createId('import')
  const placeholders = new Map<string, string>()
  sorted.forEach((file, index) => {
    placeholders.set(file.path, `/documents/__import-${nonce}-${index}__`)
  })

  const folderKeys = new Set<string>()
  for (const file of sorted) {
    const directories = file.path.split('/').slice(0, -1)
    if (directories.length > MAX_FOLDER_DEPTH) {
      return { ok: false, code: 'too-deep', path: file.path }
    }
    for (let depth = 1; depth <= directories.length; depth += 1) {
      folderKeys.add(directories.slice(0, depth).join('/'))
    }
  }

  const nodeKeys = [...folderKeys, ...keys].sort(comparePaths)
  const orderOf = new Map(nodeKeys.map((key, index) => [key, index]))
  const folders = [...folderKeys]
    .sort(comparePaths)
    .map((key): MarkdownFolderPlanFolder => {
      const parentKey = parentOf(key)
      return {
        key,
        title: (key.split('/').at(-1) ?? key).slice(0, MAX_TITLE_LENGTH),
        order: orderOf.get(key) ?? 0,
        ...(parentKey ? { parentKey } : {}),
      }
    })

  const pages: MarkdownFolderPlanPage[] = []
  const linksOf = new Map<string, Set<string>>()
  for (const file of sorted) {
    const links = new Set<string>()
    const name = file.path.split('/').at(-1) ?? file.path
    const converted = convertMarkdownToDocument(file.source, {
      createId: options.createId,
      fallbackTitle: titleFromMarkdownFileName(name) || name,
      resolveLink: (href) => {
        const target = resolveRelativeLink(file.path, href, keys, lowerCaseKeys)
        if (target === undefined) return undefined
        links.add(target)
        return placeholders.get(target)
      },
    })
    if (!converted.ok) return { ok: false, code: converted.code, path: file.path }
    linksOf.set(file.path, links)
    const parentKey = parentOf(file.path)
    pages.push({
      key: file.path,
      title: converted.title,
      order: orderOf.get(file.path) ?? 0,
      blocks: converted.blocks,
      ...(parentKey ? { parentKey } : {}),
    })
  }

  const topLevel = folders.filter((folder) => folder.parentKey === undefined)
  const rootKey =
    topLevel.length === 1 && pages.every((page) => page.parentKey !== undefined)
      ? topLevel[0]?.key
      : undefined
  return {
    ok: true,
    plan: {
      folders,
      pages: orderByLinks(pages, linksOf),
      placeholders,
      ...(rootKey ? { rootKey } : {}),
    },
  }
}

/**
 * Replaces the placeholders of links to pages that now exist with the paths
 * of those pages. Placeholders of pages not yet created stay.
 *
 * @param blocks - Planned page blocks.
 * @param placeholders - Placeholder link targets by page key.
 * @param documentIds - IDs of the pages created so far, by page key.
 * @returns Blocks with resolved links; unchanged blocks keep their identity.
 */
export function resolveImportedPageLinks(
  blocks: readonly DocumentBlock[],
  placeholders: ReadonlyMap<string, string>,
  documentIds: ReadonlyMap<string, string>,
): DocumentBlock[] {
  const replacements: [string, string][] = []
  for (const [key, placeholder] of placeholders) {
    const id = documentIds.get(key)
    if (id !== undefined) {
      replacements.push([placeholder, `/documents/${encodeURIComponent(id)}`])
    }
  }
  const replace = (text: string) => {
    if (!text.includes('/documents/__import-')) return text
    let result = text
    for (const [placeholder, path] of replacements) {
      result = result.replaceAll(placeholder, path)
    }
    return result
  }
  return blocks.map((block) => mapBlockText(block, replace))
}

/**
 * Checks whether a block still links to a page through a placeholder.
 *
 * @param block - Page block.
 * @param placeholders - Placeholder link targets by page key.
 * @returns Whether the block holds any placeholder.
 */
export function hasImportPlaceholder(
  block: DocumentBlock,
  placeholders: ReadonlyMap<string, string>,
): boolean {
  let found = false
  mapBlockText(block, (text) => {
    if (!found && text.includes('/documents/__import-')) {
      for (const placeholder of placeholders.values()) {
        if (text.includes(placeholder)) {
          found = true
          break
        }
      }
    }
    return text
  })
  return found
}

/**
 * Applies a text transform to every text and URL a block stores.
 *
 * @param block - Page block.
 * @param transform - Text transform.
 * @returns The same block when nothing changed, otherwise a copy.
 */
function mapBlockText(
  block: DocumentBlock,
  transform: (text: string) => string,
): DocumentBlock {
  switch (block.type) {
    case 'paragraph':
    case 'heading': {
      const text = transform(block.text)
      return text === block.text ? block : { ...block, text }
    }
    case 'embed': {
      const url = transform(block.url)
      return url === block.url ? block : { ...block, url }
    }
    case 'checklist': {
      const items = block.items.map((item) => {
        const text = transform(item.text)
        return text === item.text ? item : { ...item, text }
      })
      return items.every((item, index) => item === block.items[index])
        ? block
        : { ...block, items }
    }
    case 'table': {
      const columns = block.columns.map(transform)
      const rows = block.rows.map((row) => {
        const cells = row.cells.map((cell) => {
          const text = transform(cell.text)
          return text === cell.text ? cell : { ...cell, text }
        })
        return cells.every((cell, index) => cell === row.cells[index])
          ? row
          : { ...row, cells }
      })
      const unchanged =
        columns.every((column, index) => column === block.columns[index]) &&
        rows.every((row, index) => row === block.rows[index])
      return unchanged ? block : { ...block, columns, rows }
    }
    case 'code':
    case 'diagram':
      return block
  }
}

/**
 * Resolves a link target written in one imported file to another imported
 * file.
 *
 * @param fromPath - Path of the file that holds the link.
 * @param href - Link target as written.
 * @param keys - Paths of the imported files.
 * @param lowerCaseKeys - Imported paths by their lower-case form.
 * @returns Path of the target file, or undefined when the link points
 *   elsewhere.
 */
function resolveRelativeLink(
  fromPath: string,
  href: string,
  keys: ReadonlySet<string>,
  lowerCaseKeys: ReadonlyMap<string, string>,
): string | undefined {
  if (href === '' || href.startsWith('/') || href.startsWith('#') || URL_SCHEME.test(href)) {
    return undefined
  }
  const end = href.search(/[?#]/u)
  const pathPart = end === -1 ? href : href.slice(0, end)
  if (pathPart === '') return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    return undefined
  }
  const segments = fromPath.split('/').slice(0, -1)
  for (const segment of decoded.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  const target = segments.join('/')
  const candidates = MARKDOWN_EXTENSION.test(target)
    ? [target]
    : [`${target}/README.md`, `${target}/index.md`, `${target}.md`]
  for (const candidate of candidates) {
    if (keys.has(candidate)) return candidate
  }
  for (const candidate of candidates) {
    const match = lowerCaseKeys.get(candidate.toLowerCase())
    if (match !== undefined) return match
  }
  return undefined
}

/**
 * Orders pages so the pages each one links to come first, keeping path order
 * among pages that do not depend on each other. Pages in a cycle follow path
 * order, and their remaining links are resolved after all pages exist.
 *
 * @param pages - Pages in path order.
 * @param linksOf - Keys of the pages each page links to.
 * @returns Pages in creation order.
 */
function orderByLinks(
  pages: readonly MarkdownFolderPlanPage[],
  linksOf: ReadonlyMap<string, ReadonlySet<string>>,
): MarkdownFolderPlanPage[] {
  const byKey = new Map(pages.map((page) => [page.key, page]))
  const visited = new Set<string>()
  const ordered: MarkdownFolderPlanPage[] = []
  for (const page of pages) {
    if (visited.has(page.key)) continue
    visited.add(page.key)
    const stack: { key: string; links: string[] }[] = [
      { key: page.key, links: [...(linksOf.get(page.key) ?? [])].sort(comparePaths) },
    ]
    while (stack.length > 0) {
      const top = stack.at(-1)
      if (!top) break
      const next = top.links.shift()
      if (next === undefined) {
        stack.pop()
        const done = byKey.get(top.key)
        if (done) ordered.push(done)
        continue
      }
      if (visited.has(next)) continue
      visited.add(next)
      stack.push({ key: next, links: [...(linksOf.get(next) ?? [])].sort(comparePaths) })
    }
  }
  return ordered
}

/**
 * Normalizes a file path from the browser: `/` separators, no leading or
 * empty segments.
 *
 * @param path - Path as the browser reported it.
 * @returns The normalized path, or an empty string for an empty path.
 */
function normalizeFilePath(path: string): string {
  return path
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/')
}

/**
 * Returns the directory part of a path.
 *
 * @param path - Folder or file path.
 * @returns The parent directory path, or undefined at the top level.
 */
function parentOf(path: string): string | undefined {
  const index = path.lastIndexOf('/')
  return index === -1 ? undefined : path.slice(0, index)
}

/**
 * Compares paths segment by segment, so a directory's entries stay together
 * and siblings sort by name.
 *
 * @param left - First path.
 * @param right - Second path.
 * @returns Sort comparison result.
 */
function comparePaths(left: string, right: string): number {
  const leftSegments = left.split('/')
  const rightSegments = right.split('/')
  const length = Math.min(leftSegments.length, rightSegments.length)
  for (let index = 0; index < length; index += 1) {
    const a = leftSegments[index] ?? ''
    const b = rightSegments[index] ?? ''
    if (a !== b) return a < b ? -1 : 1
  }
  return leftSegments.length - rightSegments.length
}
