import type { DocumentNode, DocumentScope } from '@mukuroji/contracts'
import { getDocumentTreePage } from '../api/documents'
import { exportDocument } from '../api/exports'
import {
  SUBTREE_EXPORT_PAGE_LIMIT,
  buildSubtreeMarkdown,
  collectSubtreeEntries,
  isMarkdownExportable,
  subtreeExportFileName,
  type SubtreeExportSection,
} from '../model/subtreeExport'

/**
 * Maximum tree pages read while resolving a subtree export.
 */
const subtreeTreePageLimit = 50

/**
 * Result of a subtree Markdown export.
 */
export type DocumentSubtreeExport = {
  /**
   * Download file name.
   */
  fileName: string
  /**
   * Combined Markdown content.
   */
  content: string
  /**
   * Number of pages whose content was exported.
   */
  pageCount: number
}

/**
 * Raised instead of returning a silently truncated subtree export.
 */
export class DocumentSubtreeExportLimitError extends Error {
  /**
   * Creates the error.
   *
   * @param message - Description of the exceeded limit.
   */
  constructor(message: string) {
    super(message)
    this.name = 'DocumentSubtreeExportLimitError'
  }
}

/**
 * Exports a document and its descendants as one Markdown file.
 *
 * The tree comes from the permission-filtered tree API and each page body
 * comes from the per-document export API, so the server's view and export
 * checks apply to every page in the result.
 *
 * @param accessToken - Bearer token of the current user.
 * @param root - Document to start from.
 * @param signal - Optional abort signal.
 * @returns Combined Markdown and its file name.
 * @throws DocumentSubtreeExportLimitError when the tree or page count is too
 * large to export completely, or the root is not in the active tree.
 */
export async function exportDocumentSubtreeMarkdown(
  accessToken: string,
  root: { id: string; title: string; scope: DocumentScope },
  signal?: AbortSignal,
): Promise<DocumentSubtreeExport> {
  const nodes: DocumentNode[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    if (pages >= subtreeTreePageLimit) {
      throw new DocumentSubtreeExportLimitError(
        'The document tree is too large to export at once.',
      )
    }
    const response = await getDocumentTreePage(accessToken, {
      ...(cursor ? { cursor } : {}),
      ...(root.scope.type === 'project'
        ? { projectId: root.scope.projectId }
        : {}),
      signal,
    })
    nodes.push(...response.nodes)
    cursor = response.nextCursor
    pages += 1
  } while (cursor)
  const entries = collectSubtreeEntries(root.id, nodes)
  if (entries.length === 0) {
    throw new DocumentSubtreeExportLimitError(
      'The document is not in the active document tree.',
    )
  }
  const exportable = entries.filter((entry) => isMarkdownExportable(entry.node))
  if (exportable.length > SUBTREE_EXPORT_PAGE_LIMIT) {
    throw new DocumentSubtreeExportLimitError(
      `A subtree export is limited to ${SUBTREE_EXPORT_PAGE_LIMIT} pages.`,
    )
  }
  const sections: SubtreeExportSection[] = []
  let pageCount = 0
  for (const entry of entries) {
    if (isMarkdownExportable(entry.node)) {
      const rendered = await exportDocument(
        accessToken,
        entry.node.id,
        'markdown',
        signal,
      )
      if (rendered.delivery === 'inline') {
        sections.push({ ...entry, markdown: rendered.content })
        pageCount += 1
        continue
      }
    }
    if (entry.node.kind !== 'whiteboard' || entry.depth === 0) {
      sections.push(entry)
    }
  }
  return {
    fileName: subtreeExportFileName(root.title),
    content: buildSubtreeMarkdown(sections),
    pageCount,
  }
}
