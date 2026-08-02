import type {
  ApplyDocumentOperationsInput,
  ArchiveDocumentInput,
  CreateDocumentCommentInput,
  CreateDocumentInput,
  CreateDocumentShareInput,
  DocumentBlock,
  DocumentDetail,
  DocumentMemberGrant,
  DocumentPermission,
  DocumentRelationTarget,
  DocumentScope,
  ExportDocumentResponse,
  PublicDocument,
  PublicDocumentBlock,
  PublicDocumentResponse,
  PublicWhiteboardContent,
  PublicWhiteboardObject,
  RestoreArchivedDocumentInput,
  RevokeDocumentShareInput,
  SetDocumentFavoriteResponse,
  UpdateDocumentInput,
  UpdateDocumentPresenceInput,
  WhiteboardBounds,
  WhiteboardContent,
  WhiteboardObjectStyle,
} from '@mukuroji/contracts'
import { randomUUID } from 'node:crypto'
import type { Context, Hono } from 'hono'
import {
  createMutationAuditContext,
  type MutationAuditContext,
} from '../../../audit'
import type {
  DocumentHttpApplication,
} from '../../application/ports/document-ports'
import type {
  CreateDocumentCommentRequest,
  DocumentAccessContext,
  DocumentAuthorizationFenceSnapshot,
  DocumentBacklink,
  DocumentProjectRole,
} from '../../document-types'
import {
  DOCUMENT_BACKLINK_MAX_PAGE_LIMIT,
  DOCUMENT_COMMENT_MAX_PAGE_LIMIT,
  DOCUMENT_MAX_BACKLINK_COUNT,
  DOCUMENT_MAX_ITEM_BYTES,
  DOCUMENT_MAX_OPERATION_COUNT,
  DocumentError,
  renderAuthorizedPublicDocumentExport,
  validateCreateDocumentPayload,
  validateDocumentOperationPayload,
} from '../../application/document-use-cases'

/** Document API が一 request で受け付ける JSON body の最大 byte 数です。 */
export const DOCUMENT_API_MAX_BODY_BYTES = DOCUMENT_MAX_ITEM_BYTES

/** 一つの Document permission に指定できる member grant の最大件数です。 */
export const DOCUMENT_API_MAX_MEMBER_GRANT_COUNT = 100

/** Member source-of-truth read の最大同時実行数です。 */
const DOCUMENT_API_VALIDATION_CONCURRENCY = 8

/** 一つの batched backlink request で評価する row の最大件数です。 */
const DOCUMENT_API_BACKLINK_BATCH_READ_LIMIT =
  DOCUMENT_MAX_BACKLINK_COUNT

/**
 * Batched backlink query の検証済み target です。
 */
type ParsedDocumentBacklinkBatchTarget = {
  /** Relation target 種別です。 */
  targetType: 'work-item' | 'project' | 'goal'
  /** Relation target の canonical ID です。 */
  targetId: string
  /** この target の次 page を読む opaque cursor です。 */
  cursor?: string
}

/**
 * Document API が認証層から受け取る active Workspace principal です。
 */
export type DocumentApiPrincipal = {
  /**
   * Canonical Workspace partition ID です。
   */
  workspaceId: string
  /**
   * Active Workspace member の安定した key です。
   */
  memberKey: string
  /**
   * Presence と comment に表示する member label です。
   */
  displayName: string
  /**
   * Workspace 全体で付与された role です。
   */
  workspaceRole: 'owner' | 'admin' | 'member' | 'guest'
  /**
   * System administrator の break-glass access を持つかどうかです。
   */
  isSystemAdmin: boolean
  /**
   * Mutation transaction を認証時の authorization snapshot へ束縛します。
   */
  authorizationSnapshots?: readonly DocumentAuthorizationFenceSnapshot[]
  /**
   * Source of truth から取得した Project role map です。
   */
  projectRoles: Readonly<Record<string, DocumentProjectRole>>
  /**
   * Enterprise RBAC が許可した scope だけへ Document ACL を制限するかどうかです。
   */
  restrictToAuthorizedScopes?: boolean
  /**
   * Enterprise RBAC が Workspace scope で許可した最大 Document role です。
   */
  workspaceScopeRole?: DocumentProjectRole
}

/**
 * Mention、presence、member share の表示と検証に使う active member です。
 */
export type DocumentApiMember = {
  /**
   * Workspace 内の安定した member key です。
   */
  memberKey: string
  /**
   * Member の任意の表示名です。
   */
  name?: string
  /**
   * Member のメールアドレスです。
   */
  email: string
}

/**
 * Document routes を既存 API infrastructure へ接続する依存です。
 */
export type DocumentApiDependencies = {
  /**
   * Test reset 後も現在の Document client を返す getter です。
   */
  getClient: () => DocumentHttpApplication
  /**
   * Bearer token、active membership、current request policy を検証します。
   */
  authenticate: (
    accessToken: string,
    context: Context,
  ) => Promise<DocumentApiPrincipal>
  /**
   * Mention/share 対象の active Workspace member を取得します。
   */
  getActiveMember: (
    workspaceId: string,
    memberKey: string,
  ) => Promise<DocumentApiMember | undefined>
  /**
   * Enforces the Documents entitlement after an opaque public token resolves
   * to its server-owned Workspace.
   */
  assertPublicShareEntitled: (workspaceId: string) => Promise<void>
  /**
   * Relation/Whiteboard card の target が存在し、actor が閲覧できることを
   * source of truth で一括検証します。
   */
  validateRelationTargets: (
    principal: DocumentApiPrincipal,
    targets: readonly DocumentRelationTarget[],
  ) => Promise<
    | readonly DocumentAuthorizationFenceSnapshot[]
    | void
  >
  /**
   * Search index に current Document projection を best-effort 保存します。
   */
  upsertSearchDocument?: (
    workspaceId: string,
    document: DocumentDetail,
  ) => Promise<void>
  /**
   * Archive 済み Document を search index から best-effort 削除します。
   */
  deleteSearchDocument?: (
    workspaceId: string,
    documentId: string,
  ) => Promise<void>
}

/**
 * Document / Wiki / Whiteboard の HTTP API routes を Hono app へ登録します。
 *
 * @param app - 既存認証 API と同じ Hono app です。
 * @param dependencies - Store、認証、member、search projection の依存です。
 */
export function registerDocumentApiRoutes(
  app: Hono,
  dependencies: DocumentApiDependencies,
) {
  app.get('/api/documents/recent', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const limit = readOptionalPositiveInteger(c.req.query('limit'), 'Recent limit')
      const nodes = await dependencies.getClient().listRecent({
        workspaceId: principal.workspaceId,
        access,
        ...(limit ? { limit } : {}),
      })
      return c.json({
        documents: nodes.map((document) => ({
          document,
          openedAt: document.lastOpenedAt ?? document.updatedAt,
        })),
      })
    })
  })

  app.get('/api/documents', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const scope = readDocumentScopeFromQuery(c)
      const parentId = c.req.query('parentId')?.trim() || undefined
      const cursor = c.req.query('cursor')?.trim() || undefined
      const limit = readOptionalPositiveInteger(c.req.query('limit'), 'Document limit')
      const archived = c.req.query('archived') === 'true'
      const result = await dependencies.getClient().list({
        workspaceId: principal.workspaceId,
        access,
        ...(scope ? { scope } : {}),
        ...(parentId ? { parentId } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit ? { limit } : {}),
        archived,
      })
      return c.json(result)
    })
  })

  app.post('/api/documents', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const input = parseCreateDocumentInput(await readJson<unknown>(c))
      requireDocumentCreateCapability(principal, input.scope)
      const relationTargets = readCreateDocumentRelationTargets(input)
      let expectedAuthorizationRevision:
        | number
        | undefined
      if (input.permission) {
        expectedAuthorizationRevision =
          await validatePermissionMembers(
            dependencies,
            principal.workspaceId,
            input.permission.memberGrants.map(({ memberKey }) => memberKey),
          )
      }
      const relationTargetAuthorizationSnapshots =
        await validateDocumentRelationTargets(
          dependencies,
          principal,
          relationTargets,
        )
      const idempotencyKey = c.req.header('Idempotency-Key')?.trim() || undefined
      const document = input.kind === 'page' && input.templateId
        ? await dependencies.getClient().instantiateTemplate({
            workspaceId: principal.workspaceId,
            templateId: input.templateId,
            access,
            scope: input.scope,
            ...(input.parentId ? { parentId: input.parentId } : {}),
            title: input.title,
            ...(input.position ? { position: input.position } : {}),
            ...(input.permission ? { permission: input.permission } : {}),
            ...(expectedAuthorizationRevision === undefined
              ? {}
              : {
                  expectedAuthorizationRevision,
                }),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          })
        : await dependencies.getClient().create({
            workspaceId: principal.workspaceId,
            access,
            kind: input.kind,
            scope: input.scope,
            ...(input.parentId ? { parentId: input.parentId } : {}),
            title: input.title,
            ...(input.position ? { position: input.position } : {}),
            ...(input.permission ? { permission: input.permission } : {}),
            ...(expectedAuthorizationRevision === undefined
              ? {}
              : {
                  expectedAuthorizationRevision,
                }),
            ...((input.kind === 'page' || input.kind === 'template')
              ? { blocks: input.blocks }
              : {}),
            ...(input.kind === 'whiteboard' ? { whiteboard: input.whiteboard } : {}),
            ...(relationTargetAuthorizationSnapshots.length === 0
              ? {}
              : {
                  relationTargetAuthorizationSnapshots,
                }),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          })
      await upsertSearchDocumentBestEffort(dependencies, principal.workspaceId, document)
      return c.json({ document }, 201)
    })
  })

  app.get('/api/documents/:documentId', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const document = await dependencies.getClient().get({
        workspaceId: principal.workspaceId,
        documentId: readRequiredDocumentId(c),
        access,
        includeArchived: true,
      })
      return c.json({ document })
    })
  })

  app.patch('/api/documents/:documentId', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const input = parseUpdateDocumentInput(await readJson<unknown>(c))
      const documentId = readRequiredDocumentId(c)
      let expectedAuthorizationRevision:
        | number
        | undefined
      if (input.permission) {
        const current = await dependencies.getClient().get({
          workspaceId: principal.workspaceId,
          documentId,
          access,
          includeArchived: true,
        })
        requireDocumentCapability(
          current.capabilities.canManagePermissions,
          'DocumentPermissionDenied',
        )
        requireCurrentDocumentRevision(current, input.expectedRevision)
        expectedAuthorizationRevision =
          await validatePermissionMembers(
            dependencies,
            principal.workspaceId,
            input.permission.memberGrants.map(({ memberKey }) => memberKey),
          )
      }
      const document = await dependencies.getClient().update({
        workspaceId: principal.workspaceId,
        documentId,
        access,
        expectedRevision: readExpectedRevision(input?.expectedRevision),
        ...(typeof input?.title === 'string' ? { title: input.title } : {}),
        ...(input?.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(typeof input?.position === 'string' ? { position: input.position } : {}),
        ...(input?.scope ? { scope: input.scope } : {}),
        ...(input?.permission ? { permission: input.permission } : {}),
        ...(expectedAuthorizationRevision === undefined
          ? {}
          : {
              expectedAuthorizationRevision,
            }),
      })
      await upsertSearchDocumentBestEffort(dependencies, principal.workspaceId, document)
      return c.json({ document })
    })
  })

  app.post('/api/documents/:documentId/operations', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const input = parseDocumentOperationsInput(await readJson<unknown>(c))
      const documentId = readRequiredDocumentId(c)
      const request = {
        workspaceId: principal.workspaceId,
        documentId,
        access,
        input,
      }
      const client = dependencies.getClient()
      const preparation =
        await client.prepareOperations?.(
          request,
        )
      if (preparation?.replay !== undefined) {
        return c.json(preparation.replay)
      }
      const pendingInput =
        preparation?.pendingInput ?? input
      const relationTargets =
        readOperationRelationTargets(
          pendingInput,
        )
      const current = await client.get({
        workspaceId: principal.workspaceId,
        documentId,
        access,
        includeArchived: true,
      })
      requireDocumentCapability(
        current.capabilities.canEdit,
        'DocumentEditDenied',
      )
      validateDocumentOperationPayload(
        current,
        pendingInput,
        principal.memberKey,
      )
      const relationTargetAuthorizationSnapshots =
        await validateDocumentRelationTargets(
          dependencies,
          principal,
          relationTargets,
        )
      const result = await client.applyOperations({
        ...request,
        ...(preparation?.pendingInput === undefined
          ? {}
          : {
              validatedPendingOperationIds:
                pendingInput.operations.map(
                  ({ operationId }) =>
                    operationId,
                ),
            }),
        ...(relationTargetAuthorizationSnapshots.length === 0
          ? {}
          : {
              relationTargetAuthorizationSnapshots,
            }),
      })
      const document = await client.get({
        workspaceId: principal.workspaceId,
        documentId,
        access,
        includeArchived: true,
      })
      await upsertSearchDocumentBestEffort(dependencies, principal.workspaceId, document)
      return c.json(result)
    })
  })

  app.post('/api/documents/:documentId/archive', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const input = await readJson<ArchiveDocumentInput>(c)
      const documentId = readRequiredDocumentId(c)
      const document = await dependencies.getClient().archive({
        workspaceId: principal.workspaceId,
        documentId,
        access,
        expectedRevision: readExpectedRevision(input?.expectedRevision),
      })
      await deleteSearchDocumentBestEffort(dependencies, principal.workspaceId, documentId)
      return c.json({ document: toDocumentNode(document) })
    })
  })

  app.post('/api/documents/:documentId/restore', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const input = await readJson<RestoreArchivedDocumentInput>(c)
      const expectedRevision = readExpectedRevision(input?.expectedRevision)
      const documentId = readRequiredDocumentId(c)
      const archived = await dependencies.getClient().get({
        workspaceId: principal.workspaceId,
        documentId,
        access,
        includeArchived: true,
      })
      requireDocumentCapability(
        archived.capabilities.canRestore,
        'DocumentRestoreDenied',
      )
      requireCurrentDocumentRevision(archived, expectedRevision)
      const relationTargetAuthorizationSnapshots =
        await validateDocumentRelationTargets(
          dependencies,
          principal,
          readStoredDocumentRelationTargets(archived),
        )
      const document = await dependencies.getClient().restoreArchived({
        workspaceId: principal.workspaceId,
        documentId,
        access,
        expectedRevision,
        ...(input?.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(relationTargetAuthorizationSnapshots.length === 0
          ? {}
          : {
              relationTargetAuthorizationSnapshots,
            }),
      })
      await upsertSearchDocumentBestEffort(dependencies, principal.workspaceId, document)
      return c.json({ document: toDocumentNode(document) })
    })
  })

  app.post('/api/documents/:documentId/instantiate', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const body = await readJson<{
        /**
         * 作成する page の scope です。
         */
        scope?: DocumentScope
        /**
         * 作成する page の親 folder ID です。
         */
        parentId?: string
        /**
         * 作成する page の title です。
         */
        title?: string
        /**
         * 作成する page の position です。
         */
        position?: string
        /**
         * 作成する page の permission 設定です。
         */
        permission?: DocumentPermission
      }>(c)
      if (!body?.scope) {
        throw new DocumentError(400, 'InvalidDocumentScope', 'Template scope is required.')
      }
      validateDocumentScope(body.scope)
      if (body.permission !== undefined) {
        validateDocumentPermission(body.permission)
      }
      requireDocumentCreateCapability(principal, body.scope)
      let expectedAuthorizationRevision:
        | number
        | undefined
      if (body.permission !== undefined) {
        expectedAuthorizationRevision =
          await validatePermissionMembers(
            dependencies,
            principal.workspaceId,
            body.permission.memberGrants.map(({ memberKey }) => memberKey),
          )
      }
      const document = await dependencies.getClient().instantiateTemplate({
        workspaceId: principal.workspaceId,
        templateId: readRequiredDocumentId(c),
        access,
        scope: body.scope,
        ...(body.parentId ? { parentId: body.parentId } : {}),
        ...(body.title ? { title: body.title } : {}),
        ...(body.position ? { position: body.position } : {}),
        ...(body.permission ? { permission: body.permission } : {}),
        ...(expectedAuthorizationRevision === undefined
          ? {}
          : {
              expectedAuthorizationRevision,
            }),
        ...(c.req.header('Idempotency-Key')
          ? { idempotencyKey: c.req.header('Idempotency-Key') }
          : {}),
      })
      await upsertSearchDocumentBestEffort(dependencies, principal.workspaceId, document)
      return c.json({ document }, 201)
    })
  })

  app.get('/api/documents/:documentId/versions', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const limit = readOptionalPositiveInteger(c.req.query('limit'), 'Version limit')
      const cursor = c.req.query('cursor')?.trim() || undefined
      const result = await dependencies.getClient().listVersions({
        workspaceId: principal.workspaceId,
        documentId: readRequiredDocumentId(c),
        access,
        ...(limit ? { limit } : {}),
        ...(cursor ? { cursor } : {}),
      })
      return c.json(result)
    })
  })

  app.post('/api/documents/:documentId/versions/:versionId/restore', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const body = await readJson<{ expectedRevision?: unknown }>(c)
      const versionId = c.req.param('versionId')?.trim()
      if (!versionId) {
        throw new DocumentError(400, 'InvalidDocumentVersion', 'Version ID is required.')
      }
      const document = await dependencies.getClient().restoreVersion({
        workspaceId: principal.workspaceId,
        documentId: readRequiredDocumentId(c),
        versionId,
        expectedRevision: readExpectedRevision(body?.expectedRevision),
        access,
        validateRelationTargets: (targets) =>
          validateDocumentRelationTargets(
            dependencies,
            principal,
            targets,
          ),
      })
      await upsertSearchDocumentBestEffort(dependencies, principal.workspaceId, document)
      return c.json({ document, restoredFromVersionId: versionId })
    })
  })

  app.get('/api/documents/:documentId/comments', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const limit = readOptionalDocumentCommentLimit(c)
      const cursor = readOptionalDocumentCommentCursor(c)
      const rootCommentId = readOptionalDocumentRootCommentId(c)
      const result = await dependencies.getClient().listComments({
        workspaceId: principal.workspaceId,
        documentId: readRequiredDocumentId(c),
        access,
        ...(rootCommentId === undefined ? {} : { rootCommentId }),
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      })
      return c.json(result)
    })
  })

  app.post('/api/documents/:documentId/comments', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const input = parseCreateDocumentCommentInput(await readJson<unknown>(c))
      const documentId = readRequiredDocumentId(c)
      const commentId =
        c.req.header('Idempotency-Key')?.trim() ||
        undefined
      const request: CreateDocumentCommentRequest = {
        workspaceId: principal.workspaceId,
        documentId,
        access,
        body: input.body,
        ...(input.parentCommentId
          ? { parentCommentId: input.parentCommentId }
          : {}),
        mentions: input.mentions,
        anchor: input.anchor,
        ...(commentId ? { commentId } : {}),
      }
      if (commentId !== undefined) {
        const replay = await dependencies
          .getClient()
          .getCommentCreateReplay(request)
        if (replay !== undefined) {
          return c.json({ comment: replay }, 201)
        }
      }
      await validateMentionMembers(dependencies, principal.workspaceId, input)
      const comment =
        await dependencies.getClient().createComment({
          ...request,
          auditContext: createDocumentCommentAuditContext(
            c,
            principal,
            input,
            commentId,
          ),
        })
      return c.json({ comment }, 201)
    })
  })

  app.post('/api/documents/:documentId/comments/:commentId/resolve', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const body = await readJson<{
        /**
         * false の場合は thread を reopen します。
         */
        resolved?: boolean
      }>(c)
      const commentId = c.req.param('commentId')?.trim()
      if (!commentId) {
        throw new DocumentError(400, 'InvalidDocumentComment', 'Comment ID is required.')
      }
      const comment = await dependencies.getClient().resolveComment({
        workspaceId: principal.workspaceId,
        documentId: readRequiredDocumentId(c),
        commentId,
        access,
        resolved: body?.resolved !== false,
      })
      return c.json({ comment })
    })
  })

  app.get('/api/documents/:documentId/presence', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const documentId = readRequiredDocumentId(c)
      const stored = await dependencies.getClient().listPresence({
        workspaceId: principal.workspaceId,
        documentId,
        access,
      })
      return c.json({ presences: stored })
    })
  })

  app.put('/api/documents/:documentId/presence', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const input = parseDocumentPresenceInput(await readJson<unknown>(c))
      const selection = input.selection
      await dependencies.getClient().heartbeatPresence({
        workspaceId: principal.workspaceId,
        documentId: readRequiredDocumentId(c),
        access,
        clientId: input.clientId,
        displayName: principal.displayName,
        color: createPresenceColor(principal.memberKey),
        ...(selection !== undefined ? { selection } : {}),
      })
      return c.json({})
    })
  })

  app.delete('/api/documents/:documentId/presence/:clientId', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const clientId = c.req.param('clientId')?.trim()
      if (!clientId) {
        throw new DocumentError(400, 'InvalidDocumentPresence', 'Presence client ID is required.')
      }
      await dependencies.getClient().leavePresence({
        workspaceId: principal.workspaceId,
        documentId: readRequiredDocumentId(c),
        access,
        clientId,
      })
      return c.json({})
    })
  })

  for (const favoriteMethod of ['PUT', 'DELETE'] as const) {
    app.on(
      favoriteMethod,
      '/api/documents/:documentId/favorite',
      async (c) => withDocumentPrincipal(c, dependencies, async (principal, access) => {
        const documentId = readRequiredDocumentId(c)
        const preference = await dependencies.getClient().updatePreference({
          workspaceId: principal.workspaceId,
          documentId,
          access,
          favorite: favoriteMethod === 'PUT',
        })
        const response: SetDocumentFavoriteResponse = {
          documentId,
          favorite: preference.favorite,
          updatedAt: preference.updatedAt,
        }
        return c.json(response)
      }),
    )
  }

  app.post('/api/documents/:documentId/recent', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const preference = await dependencies.getClient().updatePreference({
        workspaceId: principal.workspaceId,
        documentId: readRequiredDocumentId(c),
        access,
        openedAt: new Date().toISOString(),
      })
      return c.json({
        document: preference.document,
        openedAt: preference.lastOpenedAt ?? preference.updatedAt,
      })
    })
  })

  app.get('/api/documents/:documentId/shares', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const documentId = readRequiredDocumentId(c)
      const [document, publicShares] = await Promise.all([
        dependencies.getClient().get({
          workspaceId: principal.workspaceId,
          documentId,
          access,
          includeArchived: true,
        }),
        dependencies.getClient().listPublicShares({
          workspaceId: principal.workspaceId,
          documentId,
          access,
        }),
      ])
      return c.json({
        memberShares: document.permission.memberGrants.map((grant) => ({
          type: 'member' as const,
          grant,
        })),
        publicShares,
      })
    })
  })

  app.post('/api/documents/:documentId/shares', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const input = parseCreateDocumentShareInput(await readJson<unknown>(c))
      const documentId = readRequiredDocumentId(c)
      if (input.type === 'member') {
        const expectedAuthorizationRevision =
          await dependencies
            .getClient()
            .getAuthorizationRevision(
              principal.workspaceId,
            )
        const member = await dependencies.getActiveMember(
          principal.workspaceId,
          input.memberKey,
        )
        if (!member) {
          throw new DocumentError(404, 'DocumentShareMemberNotFound', 'Share member was not found.')
        }
        const document = await dependencies.getClient().get({
          workspaceId: principal.workspaceId,
          documentId,
          access,
          includeArchived: true,
        })
        const grant: DocumentMemberGrant = {
          memberKey: member.memberKey,
          role: input.role,
        }
        const memberGrants = [
          ...document.permission.memberGrants.filter(
            (candidate) => candidate.memberKey !== grant.memberKey,
          ),
          grant,
        ]
        const updated = await dependencies.getClient().update({
          workspaceId: principal.workspaceId,
          documentId,
          access,
          expectedRevision: document.revision,
          permission: {
            ...document.permission,
            memberGrants,
          },
          expectedAuthorizationRevision,
        })
        await upsertSearchDocumentBestEffort(dependencies, principal.workspaceId, updated)
        return c.json({
          type: 'member',
          share: {
            type: 'member',
            grant,
          },
        }, 201)
      }

      const created = await dependencies.getClient().createPublicShare({
        workspaceId: principal.workspaceId,
        documentId,
        access,
        expiresAt: input.expiresAt,
        allowExport: input.allowExport ?? false,
        ...(c.req.header('Idempotency-Key')?.trim()
          ? {
              idempotencyKey:
                c.req.header('Idempotency-Key')!.trim(),
            }
          : {}),
      })
      return c.json({
        type: 'public',
        share: created.share,
        url: `/share/documents/${encodeURIComponent(created.token)}`,
      }, 201)
    })
  })

  app.delete('/api/documents/:documentId/shares', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const documentId = readRequiredDocumentId(c)
      const input = parseRevokeDocumentShareInput(await readJson<unknown>(c))
      if (input.type === 'member') {
        const expectedAuthorizationRevision =
          await dependencies
            .getClient()
            .getAuthorizationRevision(
              principal.workspaceId,
            )
        const document = await dependencies.getClient().get({
          workspaceId: principal.workspaceId,
          documentId,
          access,
          includeArchived: true,
        })
        const updated = await dependencies.getClient().update({
          workspaceId: principal.workspaceId,
          documentId,
          access,
          expectedRevision: document.revision,
          permission: {
            ...document.permission,
            memberGrants: document.permission.memberGrants.filter(
              (grant) => grant.memberKey !== input.memberKey,
            ),
          },
          expectedAuthorizationRevision,
        })
        await upsertSearchDocumentBestEffort(dependencies, principal.workspaceId, updated)
      } else {
        await dependencies.getClient().revokePublicShare({
          workspaceId: principal.workspaceId,
          documentId,
          shareId: input.publicShareId,
          access,
        })
      }
      return c.json({
        documentId,
        revokedAt: new Date().toISOString(),
      })
    })
  })

  app.get('/api/documents/:documentId/export', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const rendered = await dependencies.getClient().exportDocument({
        workspaceId: principal.workspaceId,
        documentId: readRequiredDocumentId(c),
        access,
        format: readDocumentExportFormat(c.req.query('format')),
      })
      const response: ExportDocumentResponse = {
        delivery: 'inline',
        format: rendered.format,
        mimeType: rendered.contentType,
        fileName: rendered.fileName,
        content: rendered.content,
      }
      c.header('Cache-Control', 'private, no-store')
      return c.json(response)
    })
  })

  app.get('/api/document-backlinks', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const targetKind = c.req.query('targetType')
      if (targetKind !== 'work-item' && targetKind !== 'project' && targetKind !== 'goal') {
        throw new DocumentError(
          400,
          'InvalidDocumentBacklinkTarget',
          'Backlink target type is invalid.',
        )
      }
      const targetId = c.req.query('targetId')?.trim()
      if (!targetId) {
        throw new DocumentError(400, 'InvalidDocumentBacklinkTarget', 'Target ID is required.')
      }
      const limit =
        readOptionalDocumentBacklinkLimit(c)
      const cursor =
        readOptionalDocumentBacklinkCursor(c)
      const result = await dependencies.getClient().listBacklinks({
        workspaceId: principal.workspaceId,
        targetKind,
        targetId,
        access,
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      })
      return c.json({
        backlinks: result.backlinks.map(
          toDocumentBacklinkResponse,
        ),
        ...(result.nextCursor === undefined
          ? {}
          : { nextCursor: result.nextCursor }),
      })
    })
  })

  app.post('/api/document-backlinks/batch', async (c) => {
    return withDocumentPrincipal(c, dependencies, async (principal, access) => {
      const targets = parseDocumentBacklinkBatchTargets(
        await readJson<unknown>(c),
      )
      const backlinks = new Map<string, DocumentBacklink>()
      const continuations: typeof targets = []
      const untouched: typeof targets = []
      let remainingReadBudget =
        DOCUMENT_API_BACKLINK_BATCH_READ_LIMIT

      for (
        let index = 0;
        index < targets.length;
        index += 1
      ) {
        const target = targets[index]!
        if (remainingReadBudget === 0) {
          untouched.push(...targets.slice(index))
          break
        }
        const remainingTargetCount =
          targets.length - index
        const limit = Math.min(
          20,
          Math.max(
            1,
            Math.floor(
              remainingReadBudget /
                remainingTargetCount,
            ),
          ),
        )
        const page = await dependencies.getClient().listBacklinks({
          workspaceId: principal.workspaceId,
          targetKind: target.targetType,
          targetId: target.targetId,
          access,
          limit,
          ...(target.cursor === undefined
            ? {}
            : { cursor: target.cursor }),
        })
        remainingReadBudget -= limit
        for (const backlink of page.backlinks) {
          backlinks.set(
            `${backlink.documentId}\0${backlink.relation.id}`,
            backlink,
          )
        }
        if (page.nextCursor !== undefined) {
          continuations.push({
            ...target,
            cursor: page.nextCursor,
          })
        }
      }

      return c.json({
        backlinks: [...backlinks.values()].map(
          toDocumentBacklinkResponse,
        ),
        pending: [
          ...untouched,
          ...continuations,
        ],
      })
    })
  })

  app.get('/api/public/documents/:token', async (c) => {
    try {
      const token = c.req.param('token')?.trim()
      if (!token) {
        throw new DocumentError(404, 'DocumentShareNotFound', 'Document share was not found.')
      }
      const resolved = await dependencies.getClient().resolvePublicShare(token)
      await dependencies.assertPublicShareEntitled(resolved.workspaceId)
      const response: PublicDocumentResponse = {
        document: toPublicDocument(resolved.document),
        allowExport: resolved.share.allowExport,
      }
      c.header('Cache-Control', 'private, no-store')
      c.header('Referrer-Policy', 'no-referrer')
      return c.json(response)
    } catch (error) {
      return toDocumentApiErrorResponse(c, error)
    }
  })

  app.get('/api/public/documents/:token/export', async (c) => {
    try {
      const token = c.req.param('token')?.trim()
      if (!token) {
        throw new DocumentError(404, 'DocumentShareNotFound', 'Document share was not found.')
      }
      const resolved = await dependencies.getClient().resolvePublicShare(token)
      await dependencies.assertPublicShareEntitled(resolved.workspaceId)
      const rendered = renderAuthorizedPublicDocumentExport(
        resolved,
        toPublicDocument(resolved.document),
        readDocumentExportFormat(c.req.query('format')),
      )
      const response: ExportDocumentResponse = {
        delivery: 'inline',
        format: rendered.format,
        mimeType: rendered.contentType,
        fileName: rendered.fileName,
        content: rendered.content,
      }
      c.header('Cache-Control', 'private, no-store')
      c.header('Referrer-Policy', 'no-referrer')
      return c.json(response)
    } catch (error) {
      return toDocumentApiErrorResponse(c, error)
    }
  })
}

function createDocumentCommentAuditContext(
  c: Context,
  principal: DocumentApiPrincipal,
  input: CreateDocumentCommentInput,
  idempotencyKey?: string,
): MutationAuditContext {
  const path = new URL(c.req.url).pathname
  try {
    return createMutationAuditContext({
      workspaceId: principal.workspaceId,
      actor: {
        id: principal.memberKey,
        kind: 'user',
        displayName: principal.displayName,
      },
      idempotencyKey: idempotencyKey ?? randomUUID(),
      request: {
        method: c.req.method,
        path,
        body: input,
      },
      source: {
        kind: 'api',
        requestId: c.req.header('X-Request-Id'),
        method: c.req.method,
        route: path,
        ipAddress:
          c.req.header('X-Forwarded-For')?.split(',')[0]?.trim(),
        userAgent: c.req.header('User-Agent'),
      },
      ...(c.req.header('X-Correlation-Id')?.trim()
        ? {
            correlationId:
              c.req.header('X-Correlation-Id')!.trim(),
          }
        : {}),
    })
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new DocumentError(
        400,
        'InvalidDocumentComment',
        error.message,
      )
    }
    throw error
  }
}

async function withDocumentPrincipal(
  c: Context,
  dependencies: DocumentApiDependencies,
  action: (
    principal: DocumentApiPrincipal,
    access: DocumentAccessContext,
  ) => Promise<Response>,
) {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({
      code: 'DocumentAuthenticationRequired',
      message: 'Bearer token is required.',
    }, 401)
  }

  try {
    const principal = await dependencies.authenticate(accessToken, c)
    return await action(principal, toDocumentAccessContext(principal))
  } catch (error) {
    return toDocumentApiErrorResponse(c, error)
  }
}

function toDocumentAccessContext(principal: DocumentApiPrincipal) {
  return {
    memberKey: principal.memberKey,
    workspaceRole: principal.workspaceRole,
    isSystemAdmin: principal.isSystemAdmin,
    projectRoles: principal.projectRoles,
    ...(principal.restrictToAuthorizedScopes === undefined
      ? {}
      : {
          restrictToAuthorizedScopes:
            principal.restrictToAuthorizedScopes,
        }),
    ...(principal.workspaceScopeRole === undefined
      ? {}
      : {
          workspaceScopeRole:
            principal.workspaceScopeRole,
        }),
    ...(principal.authorizationSnapshots === undefined
      ? {}
      : { authorizationSnapshots: principal.authorizationSnapshots }),
  } as DocumentAccessContext
}

function toDocumentApiErrorResponse(c: Context, error: unknown) {
  const status = readErrorStatus(error)
  if (status >= 500) {
    console.error(error)
    return c.json({
      code: 'DocumentServiceUnavailable',
      message: 'Document service is unavailable.',
    }, 502)
  }
  if (error instanceof DocumentError) {
    return c.json({
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    }, status)
  }
  if (isStructuredError(error)) {
    return c.json({
      code: error.code ?? 'DocumentRequestFailed',
      message: error.message,
    }, status)
  }
  return c.json({
    code: 'DocumentRequestFailed',
    message: 'The Document request failed.',
  }, status)
}

function readErrorStatus(error: unknown): 400 | 401 | 403 | 404 | 409 | 410 | 413 | 502 {
  if (!isStructuredError(error)) return 502
  if (
    error.status === 400 ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 410 ||
    error.status === 413
  ) {
    return error.status
  }
  return 502
}

function isStructuredError(
  error: unknown,
): error is Error & { status: number; code: string } {
  if (!(error instanceof Error)) return false
  const candidate = error as Error & { status?: unknown; code?: unknown }
  return typeof candidate.status === 'number' &&
    typeof candidate.code === 'string'
}

function readBearerAccessToken(c: Context) {
  return (c.req.header('Authorization') ?? '').match(/^Bearer\s+(.+)$/iu)?.[1]
}

async function readJson<T>(c: Context): Promise<T | undefined> {
  const contentLength = c.req.header('Content-Length')
  if (
    contentLength !== undefined &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > DOCUMENT_API_MAX_BODY_BYTES
  ) {
    throw documentRequestBodyTooLarge()
  }

  try {
    const stream = c.req.raw.body
    if (stream === null) return undefined
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let byteLength = 0
    let body = ''
    while (true) {
      const result = await reader.read()
      if (result.done) break
      byteLength += result.value.byteLength
      if (byteLength > DOCUMENT_API_MAX_BODY_BYTES) {
        await reader.cancel()
        throw documentRequestBodyTooLarge()
      }
      body += decoder.decode(result.value, { stream: true })
    }
    body += decoder.decode()
    if (body.length === 0) return undefined
    return JSON.parse(body) as T
  } catch (error) {
    if (error instanceof DocumentError) throw error
    throw new DocumentError(400, 'InvalidDocumentJson', 'Request body must be valid JSON.', undefined, {
      cause: error,
    })
  }
}

function documentRequestBodyTooLarge() {
  return new DocumentError(
    413,
    'DocumentRequestBodyTooLarge',
    `Request body must be at most ${DOCUMENT_API_MAX_BODY_BYTES} bytes.`,
  )
}

function parseCreateDocumentInput(value: unknown): CreateDocumentInput {
  const input = requireDocumentRecord(value, 'InvalidDocumentInput', 'Document input is required.')
  if (
    input.kind !== 'folder' &&
    input.kind !== 'page' &&
    input.kind !== 'template' &&
    input.kind !== 'whiteboard'
  ) {
    throw new DocumentError(400, 'InvalidDocumentKind', 'Document kind is invalid.')
  }
  requireNonEmptyString(input.title, 'InvalidDocumentTitle', 'Document title is required.')
  validateDocumentScope(input.scope)
  validateOptionalString(input.parentId, 'InvalidDocumentParent', 'Document parent ID is invalid.')
  validateOptionalString(input.position, 'InvalidDocumentPosition', 'Document position is invalid.')
  if (input.permission !== undefined) validateDocumentPermission(input.permission)
  if (
    input.kind === 'page' &&
    input.templateId !== undefined &&
    typeof input.templateId !== 'string'
  ) {
    throw new DocumentError(400, 'InvalidDocumentTemplate', 'Template ID is invalid.')
  }
  if (
    (input.kind === 'page' || input.kind === 'template') &&
    !Array.isArray(input.blocks)
  ) {
    throw new DocumentError(400, 'InvalidDocumentBlocks', 'Document blocks must be an array.')
  }
  if (
    input.kind === 'whiteboard' &&
    !isRecord(input.whiteboard)
  ) {
    throw new DocumentError(400, 'InvalidDocumentWhiteboard', 'Whiteboard content is invalid.')
  }
  const parsed = input as unknown as CreateDocumentInput
  validateCreateDocumentPayload(parsed)
  return parsed
}

function readCreateDocumentRelationTargets(
  input: CreateDocumentInput,
): DocumentRelationTarget[] {
  const targets = input.kind === 'whiteboard'
    ? input.whiteboard.objects.flatMap((object): DocumentRelationTarget[] =>
        object.type === 'work-item'
          ? [{
              kind: 'work-item',
              workItemId: object.workItemId,
            }]
          : []
      )
    : []
  requireDocumentRelationTargetLimit(targets)
  return targets
}

function readStoredDocumentRelationTargets(
  document: DocumentDetail,
): DocumentRelationTarget[] {
  const targets = [
    ...document.relations.map(({ target }) =>
      readDocumentRelationTarget(target)
    ),
    ...(document.kind === 'whiteboard'
      ? document.whiteboard.objects.flatMap(
          (object): DocumentRelationTarget[] =>
            object.type === 'work-item'
              ? [{
                  kind: 'work-item',
                  workItemId: object.workItemId,
                }]
              : [],
        )
      : []),
  ]
  requireDocumentRelationTargetLimit(targets)
  return targets
}

function parseUpdateDocumentInput(value: unknown): UpdateDocumentInput {
  const input = requireDocumentRecord(value, 'InvalidDocumentInput', 'Document input is required.')
  readExpectedRevision(input.expectedRevision)
  validateOptionalString(input.title, 'InvalidDocumentTitle', 'Document title is invalid.')
  if (
    input.parentId !== undefined &&
    input.parentId !== null &&
    typeof input.parentId !== 'string'
  ) {
    throw new DocumentError(400, 'InvalidDocumentParent', 'Document parent ID is invalid.')
  }
  validateOptionalString(input.position, 'InvalidDocumentPosition', 'Document position is invalid.')
  if (input.scope !== undefined) validateDocumentScope(input.scope)
  if (input.permission !== undefined) validateDocumentPermission(input.permission)
  return input as unknown as UpdateDocumentInput
}

function parseDocumentOperationsInput(value: unknown): ApplyDocumentOperationsInput {
  const input = requireDocumentRecord(
    value,
    'InvalidDocumentOperations',
    'Operation input is required.',
  )
  readExpectedRevision(input.baseRevision)
  requireNonEmptyString(
    input.clientId,
    'InvalidDocumentOperations',
    'Operation client ID is required.',
  )
  if (
    !Array.isArray(input.operations) ||
    input.operations.length === 0 ||
    input.operations.length > DOCUMENT_MAX_OPERATION_COUNT
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentOperations',
      `Operations must contain between 1 and ${DOCUMENT_MAX_OPERATION_COUNT} entries.`,
    )
  }
  const allowedTypes = new Set([
    'insert-block',
    'update-block',
    'move-block',
    'delete-block',
    'insert-object',
    'update-object',
    'delete-object',
    'upsert-connector',
    'delete-connector',
    'upsert-frame',
    'delete-frame',
    'upsert-relation',
    'delete-relation',
  ])
  for (const operation of input.operations) {
    if (
      !isRecord(operation) ||
      typeof operation.type !== 'string' ||
      !allowedTypes.has(operation.type) ||
      typeof operation.operationId !== 'string' ||
      operation.operationId.trim() === ''
    ) {
      throw new DocumentError(400, 'InvalidDocumentOperation', 'A Document operation is invalid.')
    }
    validateDocumentOperationShape(operation)
  }
  return input as unknown as ApplyDocumentOperationsInput
}

function readOperationRelationTargets(
  input: ApplyDocumentOperationsInput,
): DocumentRelationTarget[] {
  const targets = input.operations.flatMap((operation): DocumentRelationTarget[] => {
    if (operation.type === 'upsert-relation') {
      return [readDocumentRelationTarget(operation.relation.target)]
    }
    if (
      (operation.type === 'insert-object' ||
        operation.type === 'update-object') &&
      operation.object.type === 'work-item'
    ) {
      requireNonEmptyString(
        operation.object.workItemId,
        'InvalidDocumentRelationTarget',
        'Work Item target ID is required.',
      )
      return [{
        kind: 'work-item',
        workItemId: operation.object.workItemId,
      }]
    }
    return []
  })
  requireDocumentRelationTargetLimit(targets)
  return targets
}

function readDocumentRelationTarget(value: unknown): DocumentRelationTarget {
  if (!isRecord(value)) {
    throw new DocumentError(
      400,
      'InvalidDocumentRelationTarget',
      'Document relation target is invalid.',
    )
  }
  if (value.kind === 'work-item') {
    requireNonEmptyString(
      value.workItemId,
      'InvalidDocumentRelationTarget',
      'Work Item target ID is required.',
    )
    return {
      kind: 'work-item',
      workItemId: value.workItemId,
    }
  }
  if (value.kind === 'project') {
    requireNonEmptyString(
      value.projectId,
      'InvalidDocumentRelationTarget',
      'Project target ID is required.',
    )
    return {
      kind: 'project',
      projectId: value.projectId,
    }
  }
  if (value.kind === 'goal') {
    requireNonEmptyString(
      value.goalId,
      'InvalidDocumentRelationTarget',
      'Goal target ID is required.',
    )
    return {
      kind: 'goal',
      goalId: value.goalId,
    }
  }
  throw new DocumentError(
    400,
    'InvalidDocumentRelationTarget',
    'Document relation target kind is invalid.',
  )
}

function validateDocumentOperationShape(operation: Record<string, unknown>): void {
  const requireId = (key: string) => {
    requireNonEmptyString(
      operation[key],
      'InvalidDocumentOperation',
      `Operation ${key} is required.`,
    )
  }
  const requireValue = (key: string) => {
    if (!isRecord(operation[key])) {
      throw new DocumentError(
        400,
        'InvalidDocumentOperation',
        `Operation ${key} is invalid.`,
      )
    }
  }
  const requireIndex = () => {
    if (!Number.isSafeInteger(operation.index) || (operation.index as number) < 0) {
      throw new DocumentError(400, 'InvalidDocumentOperation', 'Operation index is invalid.')
    }
  }

  switch (operation.type) {
    case 'insert-block':
      requireValue('block')
      requireIndex()
      return
    case 'update-block':
      requireId('blockId')
      requireValue('block')
      return
    case 'move-block':
      requireId('blockId')
      requireIndex()
      return
    case 'delete-block':
      requireId('blockId')
      return
    case 'insert-object':
      requireValue('object')
      return
    case 'update-object':
      requireId('objectId')
      requireValue('object')
      return
    case 'delete-object':
      requireId('objectId')
      return
    case 'upsert-connector':
      requireValue('connector')
      return
    case 'delete-connector':
      requireId('connectorId')
      return
    case 'upsert-frame':
      requireValue('frame')
      return
    case 'delete-frame':
      requireId('frameId')
      return
    case 'upsert-relation':
      requireValue('relation')
      return
    case 'delete-relation':
      requireId('relationId')
  }
}

function parseCreateDocumentCommentInput(value: unknown): CreateDocumentCommentInput {
  const input = requireDocumentRecord(
    value,
    'InvalidDocumentComment',
    'Comment input is required.',
  )
  requireNonEmptyString(input.body, 'InvalidDocumentComment', 'Comment body is required.')
  validateOptionalString(
    input.parentCommentId,
    'InvalidDocumentComment',
    'Parent comment ID is invalid.',
  )
  if (!Array.isArray(input.mentions) || input.mentions.length > 20) {
    throw new DocumentError(400, 'InvalidDocumentMention', 'Comment mentions are invalid.')
  }
  for (const mention of input.mentions) {
    if (
      !isRecord(mention) ||
      typeof mention.userId !== 'string' ||
      !Number.isSafeInteger(mention.offset) ||
      !Number.isSafeInteger(mention.length) ||
      (mention.offset as number) < 0 ||
      (mention.length as number) < 1
    ) {
      throw new DocumentError(400, 'InvalidDocumentMention', 'A comment mention is invalid.')
    }
  }
  validateDocumentCommentAnchor(input.anchor)
  return input as unknown as CreateDocumentCommentInput
}

function parseDocumentPresenceInput(value: unknown): UpdateDocumentPresenceInput {
  const input = requireDocumentRecord(
    value,
    'InvalidDocumentPresence',
    'Presence input is required.',
  )
  requireNonEmptyString(
    input.clientId,
    'InvalidDocumentPresence',
    'Presence client ID is required.',
  )
  if (input.selection !== undefined && input.selection !== null) {
    if (!isRecord(input.selection)) {
      throw new DocumentError(400, 'InvalidDocumentPresence', 'Presence selection is invalid.')
    }
    if (
      input.selection.type !== 'text' &&
      input.selection.type !== 'whiteboard'
    ) {
      throw new DocumentError(400, 'InvalidDocumentPresence', 'Presence selection type is invalid.')
    }
    if (
      input.selection.type === 'text' &&
      (
        typeof input.selection.blockId !== 'string' ||
        !Number.isSafeInteger(input.selection.anchorOffset) ||
        !Number.isSafeInteger(input.selection.focusOffset) ||
        (input.selection.anchorOffset as number) < 0 ||
        (input.selection.focusOffset as number) < 0
      )
    ) {
      throw new DocumentError(400, 'InvalidDocumentPresence', 'Text selection is invalid.')
    }
    if (input.selection.type === 'whiteboard') {
      if (
        !Array.isArray(input.selection.objectIds) ||
        input.selection.objectIds.some((objectId) => typeof objectId !== 'string')
      ) {
        throw new DocumentError(400, 'InvalidDocumentPresence', 'Whiteboard selection is invalid.')
      }
      const pointer = input.selection.pointer
      if (
        pointer !== undefined &&
        (
          !isRecord(pointer) ||
          typeof pointer.x !== 'number' ||
          !Number.isFinite(pointer.x) ||
          typeof pointer.y !== 'number' ||
          !Number.isFinite(pointer.y)
        )
      ) {
        throw new DocumentError(400, 'InvalidDocumentPresence', 'Whiteboard pointer is invalid.')
      }
    }
  }
  return input as unknown as UpdateDocumentPresenceInput
}

function parseCreateDocumentShareInput(value: unknown): CreateDocumentShareInput {
  const input = requireDocumentRecord(value, 'InvalidDocumentShare', 'Share input is required.')
  if (input.type === 'member') {
    requireNonEmptyString(
      input.memberKey,
      'InvalidDocumentShare',
      'Share member key is required.',
    )
    if (
      input.role !== 'viewer' &&
      input.role !== 'editor' &&
      input.role !== 'manager'
    ) {
      throw new DocumentError(400, 'InvalidDocumentShare', 'Member share role is invalid.')
    }
    return input as unknown as CreateDocumentShareInput
  }
  if (input.type === 'public') {
    requireNonEmptyString(
      input.expiresAt,
      'InvalidDocumentShare',
      'Public share expiry is required.',
    )
    if (input.allowExport !== undefined && typeof input.allowExport !== 'boolean') {
      throw new DocumentError(400, 'InvalidDocumentShare', 'allowExport must be a boolean.')
    }
    return input as unknown as CreateDocumentShareInput
  }
  throw new DocumentError(400, 'InvalidDocumentShare', 'Share type is invalid.')
}

function parseRevokeDocumentShareInput(value: unknown): RevokeDocumentShareInput {
  const input = requireDocumentRecord(value, 'InvalidDocumentShare', 'Share input is required.')
  if (input.type === 'member') {
    requireNonEmptyString(
      input.memberKey,
      'InvalidDocumentShare',
      'Share member key is required.',
    )
    return input as unknown as RevokeDocumentShareInput
  }
  if (input.type === 'public') {
    requireNonEmptyString(
      input.publicShareId,
      'InvalidDocumentShare',
      'Public share ID is required.',
    )
    return input as unknown as RevokeDocumentShareInput
  }
  throw new DocumentError(400, 'InvalidDocumentShare', 'Share type is invalid.')
}

function validateDocumentScope(value: unknown): asserts value is DocumentScope {
  if (!isRecord(value)) {
    throw new DocumentError(400, 'InvalidDocumentScope', 'Document scope is invalid.')
  }
  if (value.type === 'workspace') return
  if (
    value.type === 'project' &&
    typeof value.projectId === 'string' &&
    value.projectId.trim() !== ''
  ) {
    return
  }
  throw new DocumentError(400, 'InvalidDocumentScope', 'Document scope is invalid.')
}

function requireDocumentCreateCapability(
  principal: DocumentApiPrincipal,
  scope: DocumentScope,
): void {
  if (principal.isSystemAdmin) {
    return
  }
  if (principal.restrictToAuthorizedScopes) {
    const role = scope.type === 'workspace'
      ? principal.workspaceScopeRole
      : principal.projectRoles[scope.projectId]
    if (
      principal.workspaceRole !== 'guest' &&
      (role === 'manager' || role === 'member')
    ) {
      return
    }
    throw new DocumentError(
      403,
      'DocumentCreateDenied',
      'You do not have permission to create a Document in this scope.',
    )
  }
  if (
    principal.workspaceRole === 'owner' ||
    principal.workspaceRole === 'admin'
  ) return
  if (
    principal.workspaceRole !== 'guest' &&
    (
      scope.type === 'workspace' ||
      principal.projectRoles[scope.projectId] === 'manager' ||
      principal.projectRoles[scope.projectId] === 'member'
    )
  ) {
    return
  }
  throw new DocumentError(
    403,
    'DocumentCreateDenied',
    'You do not have permission to create a Document in this scope.',
  )
}

function requireDocumentCapability(allowed: boolean, code: string): void {
  if (allowed) return
  throw new DocumentError(
    403,
    code,
    'You do not have permission to perform this action.',
  )
}

function requireCurrentDocumentRevision(
  document: DocumentDetail,
  expectedRevision: number,
): void {
  if (document.revision === expectedRevision) return
  throw new DocumentError(
    409,
    'DocumentRevisionConflict',
    'The document changed after it was read.',
    {
      expectedRevision,
      actualRevision: document.revision,
    },
  )
}

function validateDocumentPermission(value: unknown): void {
  if (
    !isRecord(value) ||
    (value.mode !== 'inherit' && value.mode !== 'private') ||
    !Array.isArray(value.memberGrants)
  ) {
    throw new DocumentError(400, 'InvalidDocumentPermission', 'Document permission is invalid.')
  }
  if (value.memberGrants.length > DOCUMENT_API_MAX_MEMBER_GRANT_COUNT) {
    throw new DocumentError(
      413,
      'DocumentPermissionGrantLimitExceeded',
      `A Document permission can contain at most ${DOCUMENT_API_MAX_MEMBER_GRANT_COUNT} member grants.`,
    )
  }
  const memberKeys = new Set<string>()
  for (const grant of value.memberGrants) {
    if (
      !isRecord(grant) ||
      typeof grant.memberKey !== 'string' ||
      grant.memberKey.trim() === '' ||
      (
        grant.role !== 'viewer' &&
        grant.role !== 'editor' &&
        grant.role !== 'manager'
      ) ||
      memberKeys.has(grant.memberKey)
    ) {
      throw new DocumentError(400, 'InvalidDocumentPermission', 'A member grant is invalid.')
    }
    memberKeys.add(grant.memberKey)
  }
}

function validateDocumentCommentAnchor(value: unknown): void {
  if (!isRecord(value)) {
    throw new DocumentError(400, 'InvalidDocumentComment', 'Comment anchor is invalid.')
  }
  if (value.type === 'document') return
  if (
    (value.type === 'block' || value.type === 'text') &&
    typeof value.blockId === 'string' &&
    value.blockId.trim() !== ''
  ) {
    if (
      value.type === 'text' &&
      (
        !Number.isSafeInteger(value.start) ||
        !Number.isSafeInteger(value.end) ||
        (value.start as number) < 0 ||
        (value.end as number) <= (value.start as number)
      )
    ) {
      throw new DocumentError(400, 'InvalidDocumentComment', 'Comment text range is invalid.')
    }
    return
  }
  if (
    value.type === 'whiteboard-object' &&
    typeof value.objectId === 'string' &&
    value.objectId.trim() !== ''
  ) {
    return
  }
  throw new DocumentError(400, 'InvalidDocumentComment', 'Comment anchor is invalid.')
}

function requireDocumentRecord(
  value: unknown,
  code: string,
  message: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new DocumentError(400, code, message)
  return value
}

function requireNonEmptyString(
  value: unknown,
  code: string,
  message: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DocumentError(400, code, message)
  }
}

function validateOptionalString(
  value: unknown,
  code: string,
  message: string,
): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new DocumentError(400, code, message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRequiredDocumentId(c: Context) {
  const documentId = c.req.param('documentId')?.trim()
  if (!documentId) {
    throw new DocumentError(400, 'InvalidDocumentId', 'Document ID is required.')
  }
  return documentId
}

function readExpectedRevision(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new DocumentError(
      400,
      'InvalidDocumentRevision',
      'Expected Document revision must be a positive integer.',
    )
  }
  return value
}

function readOptionalPositiveInteger(value: string | undefined, label: string) {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new DocumentError(400, 'InvalidDocumentPagination', `${label} must be positive.`)
  }
  return parsed
}

function readOptionalDocumentCommentLimit(c: Context): number | undefined {
  const values = c.req.queries('limit')
  if (values === undefined) return undefined
  const value = values.length === 1 ? values[0] : undefined
  const parsed = value === undefined ? Number.NaN : Number(value)
  if (
    value === undefined ||
    !/^[1-9]\d*$/u.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed > DOCUMENT_COMMENT_MAX_PAGE_LIMIT
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentPagination',
      `Comment limit must be a decimal integer between 1 and ${DOCUMENT_COMMENT_MAX_PAGE_LIMIT}.`,
    )
  }
  return parsed
}

function readOptionalDocumentCommentCursor(c: Context): string | undefined {
  const values = c.req.queries('cursor')
  if (values === undefined) return undefined
  const value = values.length === 1 ? values[0] : undefined
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 4_096 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentCursor',
      'Comment cursor must be a non-empty opaque base64url value.',
    )
  }
  return value
}

function readOptionalDocumentBacklinkLimit(
  c: Context,
): number | undefined {
  const values = c.req.queries('limit')
  if (values === undefined) return undefined
  const value =
    values.length === 1 ? values[0] : undefined
  const parsed =
    value === undefined ? Number.NaN : Number(value)
  if (
    value === undefined ||
    !/^[1-9]\d*$/u.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed > DOCUMENT_BACKLINK_MAX_PAGE_LIMIT
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentPagination',
      `Backlink limit must be a decimal integer between 1 and ${DOCUMENT_BACKLINK_MAX_PAGE_LIMIT}.`,
    )
  }
  return parsed
}

function readOptionalDocumentBacklinkCursor(
  c: Context,
): string | undefined {
  const values = c.req.queries('cursor')
  if (values === undefined) return undefined
  const value =
    values.length === 1 ? values[0] : undefined
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 4_096 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentCursor',
      'Backlink cursor must be a non-empty opaque base64url value.',
    )
  }
  return value
}

function parseDocumentBacklinkBatchTargets(
  value: unknown,
): ParsedDocumentBacklinkBatchTarget[] {
  if (
    !isRecord(value) ||
    !Array.isArray(value.targets) ||
    value.targets.length === 0
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentBacklinkBatch',
      'At least one backlink target is required.',
    )
  }
  if (
    value.targets.length >
      DOCUMENT_MAX_BACKLINK_COUNT
  ) {
    throw new DocumentError(
      413,
      'DocumentBacklinkTargetLimitExceeded',
      `A backlink batch can contain at most ${DOCUMENT_MAX_BACKLINK_COUNT} targets.`,
    )
  }

  const unique = new Map<
    string,
    ParsedDocumentBacklinkBatchTarget
  >()
  for (const candidate of value.targets) {
    if (
      !isRecord(candidate) ||
      (
        candidate.targetType !== 'work-item' &&
        candidate.targetType !== 'project' &&
        candidate.targetType !== 'goal'
      ) ||
      typeof candidate.targetId !== 'string' ||
      candidate.targetId.length === 0 ||
      candidate.targetId.length > 500 ||
      candidate.targetId !== candidate.targetId.trim() ||
      /\p{Cc}/u.test(candidate.targetId) ||
      (
        candidate.cursor !== undefined &&
        (
          typeof candidate.cursor !== 'string' ||
          candidate.cursor.length === 0 ||
          candidate.cursor.length > 4_096 ||
          !/^[A-Za-z0-9_-]+$/u.test(candidate.cursor)
        )
      )
    ) {
      throw new DocumentError(
        400,
        'InvalidDocumentBacklinkBatch',
        'A backlink batch target is invalid.',
      )
    }
    const target: ParsedDocumentBacklinkBatchTarget = {
      targetType: candidate.targetType,
      targetId: candidate.targetId,
      ...(candidate.cursor === undefined
        ? {}
        : { cursor: candidate.cursor }),
    }
    unique.set(
      `${target.targetType}\0${target.targetId}\0${target.cursor ?? ''}`,
      target,
    )
  }
  return [...unique.values()]
}

function readOptionalDocumentRootCommentId(c: Context): string | undefined {
  const values = c.req.queries('rootCommentId')
  if (values === undefined) return undefined
  const value = values.length === 1 ? values[0] : undefined
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 500 ||
    value !== value.trim() ||
    /\p{Cc}/u.test(value)
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentComment',
      'Root comment ID is invalid.',
    )
  }
  return value
}

function readDocumentScopeFromQuery(c: Context): DocumentScope | undefined {
  const scope = c.req.query('scope')
  if (!scope) return undefined
  if (scope === 'workspace') return { type: 'workspace' }
  if (scope === 'project') {
    const projectId = c.req.query('projectId')?.trim()
    if (!projectId) {
      throw new DocumentError(400, 'InvalidDocumentScope', 'Project ID is required.')
    }
    return { type: 'project', projectId }
  }
  throw new DocumentError(400, 'InvalidDocumentScope', 'Document scope is invalid.')
}

function readDocumentExportFormat(
  value: string | undefined,
): 'markdown' | 'json' | 'svg' {
  if (!value || value === 'markdown') return 'markdown'
  if (value === 'json' || value === 'svg') return value
  throw new DocumentError(400, 'InvalidDocumentExport', 'Export format is invalid.')
}

/**
 * Authenticated Document detail を public-safe projection へ変換します。
 */
function toPublicDocument(document: DocumentDetail): PublicDocument {
  const metadata = {
    title: document.title,
    updatedAt: document.updatedAt,
  }

  switch (document.kind) {
    case 'folder':
      return {
        ...metadata,
        kind: 'folder',
      }
    case 'page':
    case 'template':
      return {
        ...metadata,
        kind: document.kind,
        blocks: toPublicDocumentBlocks(document.blocks),
      }
    case 'whiteboard':
      return {
        ...metadata,
        kind: 'whiteboard',
        whiteboard: toPublicWhiteboardContent(document.whiteboard),
      }
  }
}

/**
 * Rich text blocks から Workspace member metadata を除外します。
 */
function toPublicDocumentBlocks(blocks: DocumentBlock[]): PublicDocumentBlock[] {
  return blocks.map((block) => {
    switch (block.type) {
      case 'paragraph':
        return { id: block.id, type: 'paragraph', text: block.text }
      case 'heading':
        return {
          id: block.id,
          type: 'heading',
          level: block.level,
          text: block.text,
        }
      case 'table':
        return {
          id: block.id,
          type: 'table',
          columns: [...block.columns],
          rows: block.rows.map((row) => ({
            id: row.id,
            cells: row.cells.map((cell) => ({ id: cell.id, text: cell.text })),
          })),
        }
      case 'code':
        return {
          id: block.id,
          type: 'code',
          code: block.code,
          ...(block.language !== undefined ? { language: block.language } : {}),
        }
      case 'checklist':
        return {
          id: block.id,
          type: 'checklist',
          items: block.items.map((item) => ({
            id: item.id,
            text: item.text,
            checked: item.checked,
          })),
        }
      case 'embed':
        return {
          id: block.id,
          type: 'embed',
          url: block.url,
          ...(block.title !== undefined ? { title: block.title } : {}),
          ...(block.provider !== undefined ? { provider: block.provider } : {}),
        }
      case 'diagram':
        return {
          id: block.id,
          type: 'diagram',
          format: block.format,
          source: block.source,
        }
    }
  })
}

/**
 * Whiteboard content を public-safe field の runtime allowlist へ投影します。
 */
function toPublicWhiteboardContent(
  whiteboard: WhiteboardContent,
): PublicWhiteboardContent {
  return {
    objects: whiteboard.objects.map((object): PublicWhiteboardObject => {
      const style = toPublicWhiteboardStyle(object.style)
      const base = {
        id: object.id,
        bounds: toPublicWhiteboardBounds(object.bounds),
        zIndex: object.zIndex,
        ...(style !== undefined ? { style } : {}),
      }
      switch (object.type) {
        case 'note':
          return { ...base, type: 'note', text: object.text }
        case 'shape':
          return {
            ...base,
            type: 'shape',
            shape: object.shape,
            ...(object.text !== undefined ? { text: object.text } : {}),
          }
        case 'text':
          return { ...base, type: 'text', text: object.text }
        case 'work-item':
          return { ...base, type: 'work-item' }
      }
    }),
    connectors: whiteboard.connectors.map((connector) => ({
      id: connector.id,
      from: {
        objectId: connector.from.objectId,
        ...(connector.from.anchor !== undefined
          ? { anchor: connector.from.anchor }
          : {}),
      },
      to: {
        objectId: connector.to.objectId,
        ...(connector.to.anchor !== undefined
          ? { anchor: connector.to.anchor }
          : {}),
      },
      ...(connector.lineStyle !== undefined
        ? { lineStyle: connector.lineStyle }
        : {}),
      ...(connector.label !== undefined ? { label: connector.label } : {}),
    })),
    frames: whiteboard.frames.map((frame) => ({
      id: frame.id,
      title: frame.title,
      bounds: toPublicWhiteboardBounds(frame.bounds),
      objectIds: [...frame.objectIds],
    })),
  }
}

/**
 * Bounds の描画 field だけを public projection へ複製します。
 */
function toPublicWhiteboardBounds(bounds: WhiteboardBounds): WhiteboardBounds {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    ...(bounds.rotation !== undefined ? { rotation: bounds.rotation } : {}),
  }
}

/**
 * Whiteboard style の安全な color field だけを public projection へ複製します。
 */
function toPublicWhiteboardStyle(
  style: WhiteboardObjectStyle | undefined,
): WhiteboardObjectStyle | undefined {
  if (style === undefined) return undefined
  return {
    ...(style.fill !== undefined ? { fill: style.fill } : {}),
    ...(style.stroke !== undefined ? { stroke: style.stroke } : {}),
    ...(style.textColor !== undefined ? { textColor: style.textColor } : {}),
  }
}

async function validateMentionMembers(
  dependencies: DocumentApiDependencies,
  workspaceId: string,
  input: CreateDocumentCommentInput,
) {
  const memberKeys = [...new Set(input.mentions.map((mention) => mention.userId))]
  if (!await everyActiveDocumentMember(dependencies, workspaceId, memberKeys)) {
    throw new DocumentError(
      400,
      'InvalidDocumentMention',
      'Every mentioned user must be an active Workspace member.',
    )
  }
}

async function validatePermissionMembers(
  dependencies: DocumentApiDependencies,
  workspaceId: string,
  memberKeys: readonly string[],
) {
  const expectedAuthorizationRevision =
    await dependencies
      .getClient()
      .getAuthorizationRevision(workspaceId)
  const uniqueMemberKeys = [...new Set(memberKeys)]
  if (
    !await everyActiveDocumentMember(
      dependencies,
      workspaceId,
      uniqueMemberKeys,
    )
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentPermissionMember',
      'Every Document grant must reference an active Workspace member.',
    )
  }
  return expectedAuthorizationRevision
}

async function everyActiveDocumentMember(
  dependencies: DocumentApiDependencies,
  workspaceId: string,
  memberKeys: readonly string[],
): Promise<boolean> {
  for (
    let offset = 0;
    offset < memberKeys.length;
    offset += DOCUMENT_API_VALIDATION_CONCURRENCY
  ) {
    const members = await Promise.all(
      memberKeys
        .slice(offset, offset + DOCUMENT_API_VALIDATION_CONCURRENCY)
        .map((memberKey) =>
          dependencies.getActiveMember(workspaceId, memberKey)
        ),
    )
    if (members.some((member) => member === undefined)) return false
  }
  return true
}

async function validateDocumentRelationTargets(
  dependencies: DocumentApiDependencies,
  principal: DocumentApiPrincipal,
  targets: readonly DocumentRelationTarget[],
): Promise<
  readonly DocumentAuthorizationFenceSnapshot[]
> {
  if (targets.length === 0) {
    return []
  }
  const uniqueTargets = [
    ...new Map(
      targets.map((target) => [
        target.kind === 'work-item'
          ? `work-item:${target.workItemId}`
          : target.kind === 'project'
            ? `project:${target.projectId}`
            : `goal:${target.goalId}`,
        target,
      ]),
    ).values(),
  ]
  requireDocumentRelationTargetLimit(uniqueTargets)
  return (
    await dependencies.validateRelationTargets(
    principal,
    uniqueTargets,
    )
  ) ?? []
}

function requireDocumentRelationTargetLimit(
  targets: readonly DocumentRelationTarget[],
): void {
  const uniqueTargetKeys = new Set(
    targets.map((target) =>
      target.kind === 'work-item'
        ? `work-item:${target.workItemId}`
        : target.kind === 'project'
          ? `project:${target.projectId}`
          : `goal:${target.goalId}`
    ),
  )
  if (uniqueTargetKeys.size <= DOCUMENT_MAX_BACKLINK_COUNT) return
  throw new DocumentError(
    413,
    'DocumentRelationTargetLimitExceeded',
    `A Document request can validate at most ${DOCUMENT_MAX_BACKLINK_COUNT} relation targets.`,
  )
}

function createPresenceColor(memberKey: string) {
  let hash = 0
  for (const character of memberKey) {
    hash = ((hash << 5) - hash + character.codePointAt(0)!) | 0
  }
  return presenceColors[Math.abs(hash) % presenceColors.length] ?? '#0f766e'
}

function toDocumentNode(document: DocumentDetail) {
  return {
    ...document,
    childCount: document.kind === 'folder' ? document.childCount : 0,
  }
}

function toDocumentBacklinkResponse(backlink: DocumentBacklink) {
  return {
    documentId: backlink.documentId,
    documentTitle: backlink.documentTitle,
    relation: backlink.relation,
  }
}

async function upsertSearchDocumentBestEffort(
  dependencies: DocumentApiDependencies,
  workspaceId: string,
  document: DocumentDetail,
) {
  if (!dependencies.upsertSearchDocument) return
  try {
    await dependencies.upsertSearchDocument(workspaceId, document)
  } catch (error) {
    console.error('Document search projection failed:', error)
  }
}

async function deleteSearchDocumentBestEffort(
  dependencies: DocumentApiDependencies,
  workspaceId: string,
  documentId: string,
) {
  if (!dependencies.deleteSearchDocument) return
  try {
    await dependencies.deleteSearchDocument(workspaceId, documentId)
  } catch (error) {
    console.error('Document search deletion failed:', error)
  }
}

const presenceColors = [
  '#0f766e',
  '#2563eb',
  '#7c3aed',
  '#c2410c',
  '#be123c',
  '#4d7c0f',
] as const
