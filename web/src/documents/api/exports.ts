import type {
  DocumentNode,
  DocumentScope,
  ExportDocumentResponse,
} from '@mukuroji/contracts'
import { DocumentsApiError, resolveDocumentsApiBaseUrl } from './errors'
import { getDocumentTreePage } from './documents'
import {
  SUBTREE_EXPORT_PAGE_LIMIT,
  buildSubtreeMarkdown,
  collectSubtreeEntries,
  isMarkdownExportable,
  subtreeExportFileName,
  type SubtreeExportSection,
} from '../model/subtreeExport'
import { readRecord } from '../../shared/api/jsonValidation'

const documentsApiBaseUrl = resolveDocumentsApiBaseUrl(import.meta.env)

/**
 * Document または Whiteboard を canonical inline/download response で export します。
 */
export async function exportDocument(
  accessToken: string,
  documentId: string,
  format: 'markdown' | 'json' | 'svg',
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ format })
  return requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/export?${query.toString()}`,
    accessToken,
    { signal },
  ) as Promise<ExportDocumentResponse>
}

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
 */
export async function exportDocumentSubtreeMarkdown(
  accessToken: string,
  root: { id: string; title: string; scope: DocumentScope },
  signal?: AbortSignal,
): Promise<DocumentSubtreeExport> {
  const nodes: DocumentNode[] = []
  let cursor: string | undefined
  for (let page = 0; page < subtreeTreePageLimit; page += 1) {
    const response = await getDocumentTreePage(accessToken, {
      ...(cursor ? { cursor } : {}),
      ...(root.scope.type === 'project'
        ? { projectId: root.scope.projectId }
        : {}),
      signal,
    })
    nodes.push(...response.nodes)
    cursor = response.nextCursor
    if (!cursor) break
  }
  const entries = collectSubtreeEntries(root.id, nodes)
  const sections: SubtreeExportSection[] = []
  let pageCount = 0
  for (const entry of entries) {
    if (
      isMarkdownExportable(entry.node) &&
      pageCount < SUBTREE_EXPORT_PAGE_LIMIT
    ) {
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

/**
 * Public token の export permission がある Document を認証情報なしで
 * export します。
 */
export async function exportPublicDocument(
  token: string,
  format: 'markdown' | 'json' | 'svg',
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ format })
  const response = await fetch(
    `${documentsApiBaseUrl}/public/documents/${encodeURIComponent(token)}/export?${query.toString()}`,
    {
      referrerPolicy: 'no-referrer',
      signal,
    },
  )
  const value = await readJson(response)
  if (!response.ok) {
    throw createApiErrorFromBody(response.status, value)
  }
  return value as ExportDocumentResponse
}

async function requestJson(
  url: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const value = await readJson(response)

  if (!response.ok) {
    throw createApiErrorFromBody(response.status, value)
  }

  return value
}

async function readJson(response: Response) {
  const text = await response.text()

  if (!text) {
    return undefined
  }

  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    throw new DocumentsApiError(
      response.status,
      'Documents API returned invalid JSON.',
      'InvalidDocumentsResponse',
    )
  }
}

function createApiErrorFromBody(status: number, value: unknown) {
  const record = readRecord(value)

  return new DocumentsApiError(
    status,
    typeof record.message === 'string'
      ? record.message
      : 'Unable to complete the document request.',
    typeof record.code === 'string' ? record.code : undefined,
  )
}

