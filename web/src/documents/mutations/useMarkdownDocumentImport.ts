import { useRef, useState } from 'react'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
} from '../../shared/api/mutationHeaders'
import {
  applyDocumentOperations,
  createDocument,
  type CreateDocumentInput,
} from '../api'
import { createDocumentClientId } from '../model/document'
import {
  planMarkdownFolderImport,
  type MarkdownFolderImportFailure,
  type MarkdownFolderImportRequest,
} from '../model/markdownFolderImport'
import {
  createMarkdownFolderImportProgress,
  runMarkdownFolderImport,
  type MarkdownFolderImportProgress,
} from './markdownFolderImportRunner'
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
  const retainedFolderRef = useRef<MarkdownFolderImportProgress | undefined>(undefined)
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

  /**
   * Creates a folder for each directory and a page for each Markdown file of
   * a chosen folder, then points relative links between the files at the
   * created pages.
   *
   * @param request - Markdown files and destination.
   * @returns Why the folder cannot be imported, or undefined once every page
   *   is created or when the import is skipped.
   */
  const importMarkdownFolder = async (
    request: MarkdownFolderImportRequest,
  ): Promise<MarkdownFolderImportFailure | undefined> => {
    if (!accessToken || pendingRef.current) return undefined
    pendingRef.current = true
    setIsImporting(true)
    try {
      return await planAndCreateFolder(accessToken, request)
    } finally {
      pendingRef.current = false
      setIsImporting(false)
    }
  }

  /**
   * Plans the folder import, or resumes the plan of a failed attempt with the
   * same files, and creates what is not created yet.
   *
   * @param token - Workspace API token.
   * @param request - Markdown files and destination.
   * @returns Why the folder cannot be imported, or undefined once done.
   */
  const planAndCreateFolder = async (
    token: string,
    request: MarkdownFolderImportRequest,
  ): Promise<MarkdownFolderImportFailure | undefined> => {
    const fingerprint = await createMutationFingerprint(
      request.projectId ?? '',
      ...request.files.flatMap((file) => [file.path, file.source]),
    )
    let state = retainedFolderRef.current?.fingerprint === fingerprint
      ? retainedFolderRef.current
      : undefined
    if (!state) {
      const planned = planMarkdownFolderImport(request.files, {
        createId: createDocumentClientId,
      })
      if (!planned.ok) {
        return { code: planned.code, ...(planned.path ? { path: planned.path } : {}) }
      }
      state = createMarkdownFolderImportProgress({
        clientId: createDocumentClientId('markdown-import'),
        fingerprint,
        plan: planned.plan,
        positionBase: new Date().toISOString(),
        scope: request.projectId
          ? { projectId: request.projectId, type: 'project' }
          : { type: 'workspace' },
      })
      retainedFolderRef.current = state
    }
    await runMarkdownFolderImport(state, {
      applyOperations: (operationKey, fingerprint, documentId, input) =>
        mutationRunner.run(operationKey, fingerprint, (context) =>
          applyDocumentOperations(token, documentId, input, context),
        ),
      create: (operationKey, fingerprint, input) =>
        mutationRunner.run(operationKey, fingerprint, (context) =>
          createDocument(token, input, context),
        ),
    })
    retainedFolderRef.current = undefined
    const { plan, documentIds } = state
    const openedKey = plan.rootKey ?? plan.pages[0]?.key
    const openedId = openedKey ? documentIds.get(openedKey) : undefined
    if (openedId) await onCreated(openedId)
    return undefined
  }

  return { importMarkdown, importMarkdownFolder, isImporting }
}
