import { useRef, useState } from 'react'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
} from '../../shared/api/mutationHeaders'
import { createDocument, type CreateDocumentInput } from '../api'
import { createDocumentClientId } from '../model/document'
import {
  convertMarkdownToDocument,
  type MarkdownDocumentImportRequest,
  type MarkdownImportErrorCode,
} from '../model/markdownImport'

/**
 * Options for creating pages from Markdown.
 */
export type UseMarkdownDocumentImportOptions = {
  /** Workspace API token; omission makes every import a no-op. */
  accessToken?: string
  /**
   * Refreshes the Document caches and opens the created page. The import
   * stays pending until it settles, so a second click cannot create a duplicate.
   */
  onCreated: (documentId: string) => Promise<unknown> | void
}

/**
 * Page input kept until its create request succeeds.
 */
type RetainedImport = {
  /** Request the input was converted from. */
  fingerprint: string
  /** Create body sent with the request. */
  input: CreateDocumentInput
}

/**
 * Creates a page from pasted or uploaded Markdown.
 *
 * A retry of the same Markdown after a lost response resends the same block
 * IDs, because the server fingerprints the create body and IDs are random.
 *
 * @param options - API token and the cache refresh.
 * @returns The import action and whether an import is pending.
 */
export function useMarkdownDocumentImport({
  accessToken,
  onCreated,
}: UseMarkdownDocumentImportOptions) {
  const [mutationRunner] = useState(createMutationRequestRunner)
  const retainedRef = useRef<RetainedImport | undefined>(undefined)
  const pendingRef = useRef(false)
  const [isImporting, setIsImporting] = useState(false)

  /**
   * Converts the Markdown and creates a page from it.
   *
   * @param request - Markdown, fallback title, and destination.
   * @returns Why the Markdown cannot become a page, or undefined once the
   *   page is created or when the import is skipped.
   */
  const importMarkdown = async (
    request: MarkdownDocumentImportRequest,
  ): Promise<MarkdownImportErrorCode | undefined> => {
    if (!accessToken || pendingRef.current) return undefined
    pendingRef.current = true
    setIsImporting(true)
    try {
      return await convertAndCreate(accessToken, request)
    } finally {
      pendingRef.current = false
      setIsImporting(false)
    }
  }

  /**
   * Converts the Markdown, or reuses the content of a failed attempt with the
   * same input, and sends the create request.
   *
   * @param token - Workspace API token.
   * @param request - Markdown, fallback title, and destination.
   * @returns Why the Markdown cannot become a page, or undefined once created.
   */
  const convertAndCreate = async (
    token: string,
    request: MarkdownDocumentImportRequest,
  ): Promise<MarkdownImportErrorCode | undefined> => {
    const fingerprint = await createMutationFingerprint(
      request.source,
      request.fallbackTitle,
      request.projectId ?? '',
    )
    let input = retainedRef.current?.fingerprint === fingerprint
      ? retainedRef.current.input
      : undefined
    if (!input) {
      const converted = convertMarkdownToDocument(request.source, {
        createId: createDocumentClientId,
        fallbackTitle: request.fallbackTitle,
      })
      if (!converted.ok) return converted.code
      input = {
        blocks: converted.blocks,
        kind: 'page',
        scope: request.projectId
          ? { projectId: request.projectId, type: 'project' }
          : { type: 'workspace' },
        title: converted.title,
      }
      retainedRef.current = { fingerprint, input }
    }

    const body = input
    const created = await mutationRunner.run(
      'document:create:markdown-import',
      fingerprint,
      (context) => createDocument(token, body, context),
    )
    retainedRef.current = undefined
    await onCreated(created.id)
    return undefined
  }

  return { importMarkdown, isImporting }
}
