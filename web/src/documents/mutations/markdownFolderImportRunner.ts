import {
  DOCUMENT_OPERATION_BATCH_LIMIT,
  type ApplyDocumentOperationsInput,
  type CreateDocumentInput,
  type DocumentBlock,
  type DocumentOperation,
  type DocumentScope,
} from '@mukuroji/contracts'
import {
  hasImportPlaceholder,
  resolveImportedPageLinks,
  type MarkdownFolderImportPlan,
} from '../model/markdownFolderImport'

/**
 * Progress of a folder import, kept until every page and link is saved so a
 * retry after a failure continues where it stopped instead of creating
 * duplicates.
 */
export type MarkdownFolderImportProgress = {
  /** Request the plan was made from. */
  fingerprint: string
  /** Folders and pages to create. */
  plan: MarkdownFolderImportPlan
  /** Scope of every created node. */
  scope: DocumentScope
  /** Prefix of the sibling positions, fixed when the plan is made. */
  positionBase: string
  /** Editor client ID sent with the link updates. */
  clientId: string
  /** IDs of the created folders and pages, by plan key. */
  documentIds: Map<string, string>
  /** Latest known revision of each created page, by plan key. */
  revisions: Map<string, number>
  /** Blocks each created page holds, by plan key. */
  savedBlocks: Map<string, DocumentBlock[]>
}

/**
 * Requests a folder import sends. Each is keyed so that a retry with the same
 * operation key and fingerprint reuses the idempotency key of the first try.
 */
export type MarkdownFolderImportRequests = {
  /** Creates one folder or page and returns its ID and revision. */
  create: (
    operationKey: string,
    fingerprint: string,
    input: CreateDocumentInput,
  ) => Promise<{ id: string; revision: number }>
  /** Applies block operations to a page and returns the new revision. */
  applyOperations: (
    operationKey: string,
    fingerprint: string,
    documentId: string,
    input: ApplyDocumentOperationsInput,
  ) => Promise<{ committedRevision: number }>
}

/**
 * Starts the progress of a folder import with nothing created.
 *
 * @param start - Plan, request fingerprint, scope, position prefix, and
 *   client ID.
 * @returns Empty progress.
 */
export function createMarkdownFolderImportProgress(
  start: Pick<
    MarkdownFolderImportProgress,
    'clientId' | 'fingerprint' | 'plan' | 'positionBase' | 'scope'
  >,
): MarkdownFolderImportProgress {
  return {
    ...start,
    documentIds: new Map(),
    revisions: new Map(),
    savedBlocks: new Map(),
  }
}

/**
 * Creates what a folder import has not created yet, then rewrites the links
 * that pointed at pages created later. Progress is recorded as each request
 * succeeds, so calling this again after a failure resumes the import.
 *
 * @param progress - Plan and progress of the import; updated in place.
 * @param requests - Senders of the create and operation requests.
 */
export async function runMarkdownFolderImport(
  progress: MarkdownFolderImportProgress,
  requests: MarkdownFolderImportRequests,
): Promise<void> {
  await createNodes(progress, requests)
  await resolveRemainingLinks(progress, requests)
}

/**
 * Creates the planned folders and pages that do not exist yet, parents
 * first, resolving links to pages that already exist.
 *
 * @param progress - Plan and progress of the import.
 * @param requests - Senders of the requests.
 */
async function createNodes(
  progress: MarkdownFolderImportProgress,
  requests: MarkdownFolderImportRequests,
): Promise<void> {
  const { documentIds, plan } = progress
  /**
   * Builds where a node goes and how its create request is keyed.
   *
   * @param key - Plan key.
   * @param order - Order among all planned nodes.
   * @param parentKey - Plan key of the parent folder.
   * @returns Scope, parent, position, operation key, and fingerprint.
   */
  const placement = (key: string, order: number, parentKey?: string) => {
    const parentId = parentKey ? documentIds.get(parentKey) : undefined
    return {
      fingerprint: `${progress.fingerprint}:${key}`,
      location: {
        position: `${progress.positionBase}#${String(order).padStart(4, '0')}`,
        scope: progress.scope,
        ...(parentId ? { parentId } : {}),
      },
      operationKey: `document:create:markdown-folder:${key}`,
    }
  }
  for (const folder of plan.folders) {
    if (documentIds.has(folder.key)) continue
    const { fingerprint, location, operationKey } = placement(
      folder.key,
      folder.order,
      folder.parentKey,
    )
    const created = await requests.create(operationKey, fingerprint, {
      ...location,
      kind: 'folder',
      title: folder.title,
    })
    documentIds.set(folder.key, created.id)
  }
  for (const page of plan.pages) {
    if (documentIds.has(page.key)) continue
    const { fingerprint, location, operationKey } = placement(
      page.key,
      page.order,
      page.parentKey,
    )
    const blocks =
      progress.savedBlocks.get(page.key) ??
      resolveImportedPageLinks(page.blocks, plan.placeholders, documentIds)
    progress.savedBlocks.set(page.key, blocks)
    const created = await requests.create(operationKey, fingerprint, {
      ...location,
      blocks,
      kind: 'page',
      title: page.title,
    })
    documentIds.set(page.key, created.id)
    progress.revisions.set(page.key, created.revision)
  }
}

/**
 * Updates the blocks whose links pointed at pages created after them, a few
 * blocks per request as the operations API allows.
 *
 * @param progress - Plan and progress of the import.
 * @param requests - Senders of the requests.
 */
async function resolveRemainingLinks(
  progress: MarkdownFolderImportProgress,
  requests: MarkdownFolderImportRequests,
): Promise<void> {
  const { documentIds, plan, revisions, savedBlocks } = progress
  for (const page of plan.pages) {
    const documentId = documentIds.get(page.key)
    const saved = savedBlocks.get(page.key)
    if (!documentId || !saved) continue
    const pending = saved.filter((block) => hasImportPlaceholder(block, plan.placeholders))
    for (let start = 0; start < pending.length; start += DOCUMENT_OPERATION_BATCH_LIMIT) {
      const batch = pending.slice(start, start + DOCUMENT_OPERATION_BATCH_LIMIT)
      const resolved = resolveImportedPageLinks(batch, plan.placeholders, documentIds)
      const operations = resolved.map((block): DocumentOperation => ({
        block,
        blockId: block.id,
        operationId: `markdown-import-link-${block.id}`,
        type: 'update-block',
      }))
      const result = await requests.applyOperations(
        `document:update:markdown-folder-links:${page.key}`,
        `${progress.fingerprint}:${page.key}:${batch.map((block) => block.id).join(',')}`,
        documentId,
        {
          baseRevision: revisions.get(page.key) ?? 0,
          clientId: progress.clientId,
          operations,
        },
      )
      revisions.set(page.key, result.committedRevision)
      const updated = new Map(resolved.map((block) => [block.id, block]))
      savedBlocks.set(
        page.key,
        (savedBlocks.get(page.key) ?? saved).map((block) => updated.get(block.id) ?? block),
      )
    }
  }
}
