import { getDocumentTreePage, type DocumentSummary } from '../api'

/** Maximum tree pages read for one page of a Project's Documents. */
const PROJECT_DOCUMENT_TREE_PAGES_PER_REQUEST = 5

/**
 * One page of the active Documents in a Project scope.
 */
export type ProjectDocumentsPage = {
  /** Permission-filtered Documents in the Project scope. */
  documents: DocumentSummary[]
  /** Cursor for the next page when more tree rows remain. */
  nextCursor?: string
}

/**
 * Reads one page of the active Documents in a Project scope that the viewer can read.
 *
 * The tree API filters by scope after reading each workspace-wide page, so a
 * tree page can be empty while later pages still match. This reads a bounded
 * number of tree pages and returns the continuation cursor instead of
 * dropping it.
 *
 * @param accessToken - Workspace API token.
 * @param projectId - Project whose Documents are listed.
 * @param cursor - Continuation cursor from the previous page.
 * @param signal - Optional abort signal.
 * @returns Documents found and the cursor to continue from, if any.
 */
export async function getProjectDocumentsPage(
  accessToken: string,
  projectId: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<ProjectDocumentsPage> {
  const documents = new Map<string, DocumentSummary>()
  let nextCursor = cursor
  for (
    let page = 0;
    page < PROJECT_DOCUMENT_TREE_PAGES_PER_REQUEST;
    page += 1
  ) {
    const response = await getDocumentTreePage(accessToken, {
      cursor: nextCursor,
      projectId,
      signal,
    })
    for (const node of response.nodes) documents.set(node.id, node)
    nextCursor = response.nextCursor
    if (!nextCursor) break
  }
  return {
    documents: [...documents.values()],
    ...(nextCursor ? { nextCursor } : {}),
  }
}
