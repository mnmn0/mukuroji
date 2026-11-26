import { createHash, randomUUID } from 'node:crypto'
import type {
  CreatePublicDocumentRequest,
  DocumentBlock,
  DocumentDetail,
  DocumentScope,
  PublicDocumentContent,
  PublicDocumentSummary,
  PublicWorkItemDocument,
} from '@mukuroji/contracts'
import { PUBLIC_DOCUMENT_TITLE_MAX_LENGTH } from '@mukuroji/contracts'
import { createMutationAuditContext, type MutationAuditContext } from '../../modules/audit/audit'
import {
  convertMarkdownToPageBlocks,
  DocumentError,
  markdownInspector,
  renderDocumentProjectionExport,
  type DocumentAccessContext,
} from '../../modules/documents'
import {
  requireDocumentCreateCapability,
  toDocumentAccessContext,
  type DocumentApiPrincipal,
} from '../../modules/documents/adapter-in/http/document-api'
import type { AuthenticatedDeveloperCredential } from '../../modules/developer-platform/application/ports'
import { readCredentialPrincipalKey } from '../../modules/developer-platform/credential-principal'
import { WorkspaceAccessError } from '../../modules/workspace-access'
import {
  PublicApiServiceError,
  type PublicDocumentService,
  type PublicMutationContext,
} from '../../modules/developer-platform/public-api'
import { workItemDependencies } from './app-dependencies'
import { resolveDeveloperCredentialPrincipal } from './developer-platform-access'
import { readDocumentAuthorizationSnapshot } from './document-access'
import {
  publishDocumentChange,
  toDocumentApiPrincipal,
  upsertDocumentSearchProjection,
  validateDocumentRelationTargets,
} from './document-principal'
import { createDocumentEnterpriseScopeBoundary } from './project-access'
import { loadAuthorizedTeamIssue } from './work-item-access'

/**
 * Resolves the Document viewer access of a credential owner from current Workspace, Project, and
 * Enterprise permissions, exactly as the Documents routes do for a signed-in member.
 *
 * @param credential - Authenticated developer credential.
 * @returns The owner's Workspace ID and Document access context.
 */
async function resolveCredentialDocumentAccess(
  credential: AuthenticatedDeveloperCredential,
): Promise<{
  /** Workspace that owns the Documents. */
  workspaceId: string
  /** Current Document access of the credential owner. */
  access: DocumentAccessContext
}> {
  const principal = await resolveDeveloperCredentialPrincipal(credential, {
    permission: 'documents.manage',
    alternativePermissions: ['documents.write', 'documents.read'],
    evaluateProjectScopes: true,
  })
  const { projectRoles } = await readDocumentAuthorizationSnapshot(principal)
  return {
    workspaceId: principal.directoryId,
    access: {
      memberKey: principal.userKey,
      workspaceRole: principal.workspaceRole,
      isSystemAdmin: principal.isSystemAdmin,
      projectRoles,
      ...createDocumentEnterpriseScopeBoundary(principal),
    },
  }
}

/**
 * Resolves the credential owner's Document access, or nothing when Enterprise RBAC grants no
 * Document permission. Such an owner can view no Document, which the read paths report the same
 * way as a hidden Document; other failures still propagate.
 *
 * @param credential - Authenticated developer credential.
 * @returns The owner's Document access, or undefined when every Document is hidden from them.
 */
async function resolveCredentialDocumentAccessIfPermitted(
  credential: AuthenticatedDeveloperCredential,
): Promise<Awaited<ReturnType<typeof resolveCredentialDocumentAccess>> | undefined> {
  try {
    return await resolveCredentialDocumentAccess(credential)
  } catch (error) {
    if (error instanceof WorkspaceAccessError && error.code === 'WorkspacePermissionDenied') return undefined
    throw error
  }
}

/**
 * Reads a Document the credential owner can view, reporting a hidden Document as missing so the
 * response does not reveal that it exists.
 *
 * @param workspaceId - Workspace that owns the Document.
 * @param documentId - Document ID.
 * @param access - Credential owner's Document access.
 * @returns The permission-filtered Document.
 */
async function readVisibleDocument(
  workspaceId: string,
  documentId: string,
  access: DocumentAccessContext,
): Promise<DocumentDetail> {
  try {
    return await workItemDependencies.documents.get({ workspaceId, documentId, access })
  } catch (error) {
    if (error instanceof DocumentError && (error.status === 403 || error.status === 404)) {
      throw new PublicApiServiceError(404, 'not_found', 'Document was not found.')
    }
    throw error
  }
}

/**
 * Tells whether a Document links a Work Item the same way the Documents backlink index does:
 * through an explicit relation, or through a Work Item card on a whiteboard.
 *
 * @param document - Document the credential owner can view.
 * @param targetId - Work Item relation target ID.
 * @returns Whether the Document links the Work Item.
 */
function linksWorkItem(document: DocumentDetail, targetId: string): boolean {
  if (document.relations.some((relation) =>
    relation.target.kind === 'work-item' && relation.target.workItemId === targetId
  )) {
    return true
  }
  return document.kind === 'whiteboard' && document.whiteboard.objects.some((object) =>
    object.type === 'work-item' && object.workItemId === targetId
  )
}

/**
 * Returns the relation target ID the Documents store uses for a Work Item.
 *
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns Canonical Work Item relation target ID.
 */
function toWorkItemRelationTargetId(teamId: string, workItemId: string): string {
  return `team/${teamId}/issue/${workItemId}`
}

/**
 * Checks that the credential owner can currently view the Work Item.
 *
 * @param credential - Authenticated developer credential.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns A promise that resolves when the Work Item is visible.
 */
async function requireVisibleWorkItem(
  credential: AuthenticatedDeveloperCredential,
  teamId: string,
  workItemId: string,
): Promise<void> {
  const principal = await resolveDeveloperCredentialPrincipal(credential, {
    permission: 'work-items.read', teamId, evaluateProjectScopes: true,
  })
  await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
}

/**
 * Checks that the credential owner can view the Work Item a new page links to. A Work Item the owner
 * cannot view is reported like a missing one, so a write cannot tell hidden Work Items apart.
 *
 * @param credential - Authenticated developer credential.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns A promise that resolves when the Work Item is visible.
 * @throws PublicApiServiceError 422 when the Work Item is missing or hidden from the owner.
 */
async function requireLinkableWorkItem(
  credential: AuthenticatedDeveloperCredential,
  teamId: string,
  workItemId: string,
): Promise<void> {
  try {
    await requireVisibleWorkItem(credential, teamId, workItemId)
  } catch (error) {
    if (error instanceof Error && 'status' in error && (error.status === 403 || error.status === 404)) {
      throw new PublicApiServiceError(422, 'validation_failed', 'Work Item was not found.')
    }
    throw error
  }
}

/**
 * Resolves the credential owner as a Documents writer, with the same Project roles, Enterprise
 * scope boundary, and authorization fences as a signed-in member's Documents write.
 *
 * @param credential - Authenticated developer credential.
 * @returns The owner's Documents principal and store access context.
 * @throws PublicApiServiceError or WorkspaceAccessError 403 when Enterprise RBAC grants no
 *   Document write permission.
 */
async function resolveCredentialDocumentWriter(
  credential: AuthenticatedDeveloperCredential,
): Promise<{
  /** Documents principal of the credential owner. */
  principal: DocumentApiPrincipal
  /** Store access context of the credential owner. */
  access: DocumentAccessContext
}> {
  const workspacePrincipal = await resolveDeveloperCredentialPrincipal(credential, {
    permission: 'documents.write',
    alternativePermissions: ['documents.manage'],
    evaluateProjectScopes: true,
  })
  const principal = await toDocumentApiPrincipal(workspacePrincipal)
  return { principal, access: toDocumentAccessContext(principal) }
}

/**
 * Builds the audit context of a Public API Document write. The idempotency key is a digest of the
 * credential, route, and client key, which keeps any client key within the audit key limit and
 * apart from other credentials' keys.
 *
 * @param credential - Authenticated developer credential.
 * @param principal - Documents principal of the credential owner.
 * @param context - Request, correlation, and idempotency identifiers.
 * @param method - HTTP method.
 * @param path - Request path.
 * @param bodyDigest - Digest of the request body, so different writes get different request
 *   fingerprints while the body itself stays out of the audit event.
 * @returns The audit context recorded with the write.
 */
function createDocumentWriteAudit(
  credential: AuthenticatedDeveloperCredential,
  principal: DocumentApiPrincipal,
  context: PublicMutationContext,
  method: string,
  path: string,
  bodyDigest: string,
): MutationAuditContext {
  return createMutationAuditContext({
    workspaceId: principal.workspaceId,
    actor: { id: principal.memberKey, kind: 'user', displayName: principal.displayName },
    idempotencyKey: `document-public-api:${hashPublicWrite(credential, method, path, context.idempotencyKey)}`,
    ...(context.correlationId ? { correlationId: context.correlationId } : {}),
    request: { method, path, body: { path, bodyDigest } },
    source: { kind: 'api', requestId: context.requestId, method, route: path },
  })
}

/**
 * Digests one Public API write of one caller, so a retry of it maps to the same value. The caller
 * is the stable principal, so a retry after an OAuth token refresh maps to the same value too.
 *
 * @param credential - Authenticated developer credential.
 * @param method - HTTP method.
 * @param path - Request path.
 * @param idempotencyKey - Client idempotency key.
 * @returns Hex SHA-256 digest.
 */
function hashPublicWrite(
  credential: AuthenticatedDeveloperCredential,
  method: string,
  path: string,
  idempotencyKey: string,
): string {
  return createHash('sha256')
    .update(`${credential.workspaceId}\0${readCredentialPrincipalKey(credential)}\0${method}\0${path}\0${idempotencyKey}`)
    .digest('hex')
}

/**
 * Converts a Documents store failure of a Public API Document request into a Public API error.
 * A Document the owner cannot view is reported as missing, so the response does not reveal it.
 *
 * @param error - Failure thrown by the Documents store or its validation.
 * @returns Never; always throws.
 * @throws PublicApiServiceError for Documents failures; other errors are rethrown unchanged.
 */
function rethrowDocumentFailure(error: unknown): never {
  if (!(error instanceof DocumentError)) throw error
  if (error.status === 404 || error.code === 'DocumentViewDenied') {
    throw new PublicApiServiceError(404, 'not_found', 'Document was not found.')
  }
  if (error.status === 403) {
    throw new PublicApiServiceError(403, 'forbidden', error.message)
  }
  if (error.status === 409) {
    throw new PublicApiServiceError(409, 'conflict', error.message)
  }
  if (error.status === 400 || error.status === 413 || error.status === 422) {
    throw new PublicApiServiceError(422, 'validation_failed', error.message)
  }
  throw error
}

/**
 * Converts Markdown into page blocks with fresh IDs, or reports why it cannot become a page.
 *
 * @param content - Markdown body.
 * @returns Page body blocks, and the text of the leading `#` heading an export writes as the title.
 * @throws PublicApiServiceError 422 when the Markdown does not fit in one page.
 */
function readMarkdownPageBlocks(content: string): { blocks: DocumentBlock[], leadingTitle?: string } {
  const converted = convertMarkdownToPageBlocks(content, (prefix) => `${prefix}-${randomUUID()}`)
  if (converted.ok) {
    return {
      blocks: converted.blocks,
      ...(converted.leadingTitle === undefined ? {} : { leadingTitle: converted.leadingTitle }),
    }
  }
  const reason = converted.code === 'too-many-blocks'
    ? 'The Markdown makes more blocks than one page can hold.'
    : converted.code === 'block-too-long'
      ? 'A code block or a paragraph without blank lines is longer than one block can hold.'
      : 'The Markdown is too large for one page.'
  throw new PublicApiServiceError(422, 'validation_failed', reason)
}

/**
 * Reads the leading `#` heading of PATCH content as the new title.
 *
 * @param text - Unescaped heading text, when the content has one.
 * @returns The trimmed title, or undefined when there is no heading.
 * @throws PublicApiServiceError 422 when the heading cannot be a title.
 */
function readLeadingTitle(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const title = text.trim()
  // eslint-disable-next-line no-control-regex -- control characters are what this rejects.
  if (title === '' || title.length > PUBLIC_DOCUMENT_TITLE_MAX_LENGTH || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(title)) {
    throw new PublicApiServiceError(
      422,
      'validation_failed',
      `The leading # heading is used as the title and must be at most ${PUBLIC_DOCUMENT_TITLE_MAX_LENGTH} characters on one line.`,
    )
  }
  return title
}

/**
 * Renders a page or template as the Public API returns it.
 *
 * @param document - Document the credential owner can view.
 * @returns Its Markdown content.
 * @throws PublicApiServiceError 422 when the Document has no Markdown rendering.
 */
function toPublicDocumentContent(document: DocumentDetail): PublicDocumentContent {
  if (document.kind !== 'page' && document.kind !== 'template') {
    throw new PublicApiServiceError(
      422,
      'validation_failed',
      'Only page and template Documents can be read as Markdown.',
    )
  }
  const rendered = renderDocumentProjectionExport(document, 'markdown', markdownInspector)
  return {
    schemaVersion: 1,
    id: document.id,
    kind: document.kind,
    title: document.title,
    revision: document.revision,
    updatedAt: document.updatedAt,
    format: 'markdown',
    content: rendered.content,
  }
}

/** Revision every newly created Document starts at. */
const CREATED_DOCUMENT_REVISION = 1

/**
 * Summarizes a Document as the Public API lists it and answers its writes. A write answers with
 * the summary rather than the body, so a saved write always fits in its idempotency receipt.
 *
 * @param document - Document the credential owner can view.
 * @returns Its summary.
 */
function toPublicDocumentSummary(document: DocumentDetail): PublicDocumentSummary {
  return {
    id: document.id,
    kind: document.kind,
    title: document.title,
    scope: document.scope.type === 'workspace'
      ? { type: 'workspace' }
      : { type: 'project', projectId: document.scope.projectId },
    ...(document.parentId === undefined ? {} : { parentId: document.parentId }),
    revision: document.revision,
  }
}

/**
 * Updates the search projection and open editors after a Public API Document write. Both are
 * best effort: the write is already saved, so a failure here must not fail the response.
 *
 * @param workspaceId - Workspace that owns the Document.
 * @param document - Saved Document.
 * @param correlationId - Correlation ID of the write, logged with a failure.
 * @returns A promise that resolves when both side effects finished or failed.
 */
async function reflectDocumentWrite(
  workspaceId: string,
  document: DocumentDetail,
  correlationId: string | undefined,
): Promise<void> {
  try {
    await upsertDocumentSearchProjection(workspaceId, document)
  } catch (error) {
    console.error('Document search projection failed:', describeReflectionFailure(document, correlationId, error))
  }
  try {
    await publishDocumentChange(workspaceId, { documentId: document.id, part: 'document' })
  } catch (error) {
    console.error('Document change notification failed:', describeReflectionFailure(document, correlationId, error))
  }
}

/**
 * Describes a failed side effect of a Document write for the log, with the write's correlation ID
 * and only the error's class, so no body, secret, or personal data reaches the log.
 *
 * @param document - Saved Document.
 * @param correlationId - Correlation ID of the write, when the request had one.
 * @param error - Thrown value.
 * @returns Log fields.
 */
function describeReflectionFailure(
  document: DocumentDetail,
  correlationId: string | undefined,
  error: unknown,
): { documentId: string, correlationId?: string, errorName: string } {
  return {
    documentId: document.id,
    ...(correlationId === undefined ? {} : { correlationId }),
    errorName: error instanceof Error ? error.name : typeof error,
  }
}

/**
 * Creates the Public API service for Documents. Every call evaluates the credential owner's current
 * permissions, exactly as the Documents routes do for a signed-in member; nothing is cached between
 * calls.
 *
 * @returns Document service backed by the canonical Documents store.
 */
export function createCanonicalPublicDocumentService(): PublicDocumentService {
  return {
    /** Lists visible Documents linked to a Work Item the credential owner can view. */
    async listWorkItemDocuments(credential, teamId, workItemId, continuation, limit) {
      await requireVisibleWorkItem(credential, teamId, workItemId)
      const documentAccess = await resolveCredentialDocumentAccessIfPermitted(credential)
      if (documentAccess === undefined) return { items: [], hasMore: false }
      const { workspaceId, access } = documentAccess
      const page = await workItemDependencies.documents.listBacklinks({
        workspaceId,
        targetKind: 'work-item',
        targetId: toWorkItemRelationTargetId(teamId, workItemId),
        access,
        limit,
        ...(continuation === undefined ? {} : { cursor: continuation }),
      })
      const items = new Map<string, PublicWorkItemDocument>()
      for (const backlink of page.backlinks) {
        if (!items.has(backlink.documentId)) {
          items.set(backlink.documentId, { id: backlink.documentId, title: backlink.documentTitle })
        }
      }
      return {
        items: [...items.values()],
        hasMore: page.nextCursor !== undefined,
        ...(page.nextCursor === undefined ? {} : { nextContinuation: page.nextCursor }),
      }
    },

    /** Renders a linked page or template the credential owner can view as Markdown. */
    async getWorkItemDocument(credential, teamId, workItemId, documentId) {
      await requireVisibleWorkItem(credential, teamId, workItemId)
      const documentAccess = await resolveCredentialDocumentAccessIfPermitted(credential)
      if (documentAccess === undefined) {
        throw new PublicApiServiceError(404, 'not_found', 'Document was not found.')
      }
      const { workspaceId, access } = documentAccess
      const document = await readVisibleDocument(workspaceId, documentId, access)
      const targetId = toWorkItemRelationTargetId(teamId, workItemId)
      if (!linksWorkItem(document, targetId)) {
        throw new PublicApiServiceError(404, 'not_found', 'Document was not found.')
      }
      return toPublicDocumentContent(document)
    },

    /** Lists the Workspace's Documents the credential owner can view, outside archived trees. */
    async listDocuments(credential, filters, continuation, limit) {
      const documentAccess = await resolveCredentialDocumentAccessIfPermitted(credential)
      if (documentAccess === undefined) return { items: [], hasMore: false }
      const { workspaceId, access } = documentAccess
      let page
      try {
        page = await workItemDependencies.documents.list({
          workspaceId,
          access,
          limit,
          archived: false,
          ...(filters.projectId === undefined ? {} : { scope: { type: 'project', projectId: filters.projectId } }),
          ...(filters.parentId === undefined ? {} : { parentId: filters.parentId }),
          ...(continuation === undefined ? {} : { cursor: continuation }),
        })
      } catch (error) {
        rethrowDocumentFailure(error)
      }
      return {
        items: page.nodes.map((node): PublicDocumentSummary => ({
          id: node.id,
          kind: node.kind,
          title: node.title,
          scope: node.scope.type === 'workspace' ? { type: 'workspace' } : { type: 'project', projectId: node.scope.projectId },
          ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
          revision: node.revision,
        })),
        hasMore: page.nextCursor !== undefined,
        ...(page.nextCursor === undefined ? {} : { nextContinuation: page.nextCursor }),
      }
    },

    /** Renders a page or template the credential owner can view as Markdown. */
    async getDocument(credential, documentId) {
      const documentAccess = await resolveCredentialDocumentAccessIfPermitted(credential)
      if (documentAccess === undefined) {
        throw new PublicApiServiceError(404, 'not_found', 'Document was not found.')
      }
      return toPublicDocumentContent(
        await readVisibleDocument(documentAccess.workspaceId, documentId, documentAccess.access),
      )
    },

    /** Checks that the credential owner may still write Documents, before a replay is returned. */
    async authorizeDocumentWrite(credential) {
      await resolveCredentialDocumentWriter(credential)
    },

    /** Creates a page from Markdown, linked to a Work Item the owner can view when one is named. */
    async createDocument(credential, input: CreatePublicDocumentRequest, context) {
      const { principal, access } = await resolveCredentialDocumentWriter(credential)
      const scope: DocumentScope = input.projectId === undefined
        ? { type: 'workspace' }
        : { type: 'project', projectId: input.projectId }
      const { blocks } = readMarkdownPageBlocks(input.content)
      try {
        requireDocumentCreateCapability(principal, scope)
        const target = input.workItem === undefined
          ? undefined
          : { kind: 'work-item' as const, workItemId: toWorkItemRelationTargetId(input.workItem.teamId, input.workItem.workItemId) }
        // The owner must be able to view the Work Item itself, as the linked-Document reads require,
        // so a write cannot probe or link a Work Item that Enterprise RBAC hides.
        if (input.workItem !== undefined) {
          await requireLinkableWorkItem(credential, input.workItem.teamId, input.workItem.workItemId)
        }
        const relationTargetAuthorizationSnapshots = target === undefined
          ? undefined
          : await validateDocumentRelationTargets(principal, [target])
        const now = new Date().toISOString()
        const keyHash = hashPublicWrite(credential, 'POST', '/api/v1/documents', context.idempotencyKey)
        const inputDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex')
        const document = await workItemDependencies.documents.create({
          workspaceId: principal.workspaceId,
          access,
          kind: 'page',
          scope,
          title: input.title,
          blocks,
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
          ...(target === undefined
            ? {}
            : {
                relations: [{
                  id: `relation-${keyHash.slice(0, 32)}`,
                  source: { kind: 'document' },
                  target,
                  createdByUserId: principal.memberKey,
                  createdAt: now,
                }],
              }),
          ...(relationTargetAuthorizationSnapshots === undefined || relationTargetAuthorizationSnapshots.length === 0
            ? {}
            : { relationTargetAuthorizationSnapshots }),
          // A retry after an uncertain response creates no second page, even when the Public API
          // receipt was not written; the blocks get new IDs, so the request itself is the fingerprint.
          idempotencyKey: `public-api:${keyHash}`,
          idempotencyFingerprint: inputDigest,
          auditContext: createDocumentWriteAudit(credential, principal, context, 'POST', '/api/v1/documents', inputDigest),
        })
        if (document.revision !== CREATED_DOCUMENT_REVISION) {
          // A retry of a creation that someone has edited since answers with the page as this
          // request created it, so the caller never receives a revision it has not read.
          return {
            id: document.id,
            kind: 'page',
            title: input.title.trim(),
            scope: scope.type === 'workspace' ? { type: 'workspace' } : { type: 'project', projectId: scope.projectId },
            ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
            revision: CREATED_DOCUMENT_REVISION,
          }
        }
        await reflectDocumentWrite(principal.workspaceId, document, context.correlationId)
        return toPublicDocumentSummary(document)
      } catch (error) {
        rethrowDocumentFailure(error)
      }
    },

    /** Changes a page's or template's title, or replaces its body with Markdown. */
    async updateDocument(credential, documentId, input, context) {
      const { principal, access } = await resolveCredentialDocumentWriter(credential)
      const converted = input.content === undefined ? undefined : readMarkdownPageBlocks(input.content)
      const blocks = converted?.blocks
      // The leading `#` heading is where an export writes the title, so without a title it names
      // the Document instead of being dropped.
      const title = input.title ?? readLeadingTitle(converted?.leadingTitle)
      const path = `/api/v1/documents/${encodeURIComponent(documentId)}`
      // A Document the owner cannot view is reported as missing, not as an edit denial.
      await readVisibleDocument(principal.workspaceId, documentId, access)
      const inputDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      try {
        const document = await workItemDependencies.documents.replaceContent({
          workspaceId: principal.workspaceId,
          documentId,
          access,
          expectedRevision: input.expectedRevision,
          ...(title === undefined ? {} : { title }),
          ...(blocks === undefined ? {} : { blocks }),
          // A retry after a lost response finds its own write instead of a revision conflict.
          idempotencyKey: `public-api:${hashPublicWrite(credential, 'PATCH', path, context.idempotencyKey)}`,
          idempotencyFingerprint: inputDigest,
          auditContext: createDocumentWriteAudit(credential, principal, context, 'PATCH', path, inputDigest),
        })
        await reflectDocumentWrite(principal.workspaceId, document, context.correlationId)
        return toPublicDocumentSummary(document)
      } catch (error) {
        rethrowDocumentFailure(error)
      }
    },
  }
}
