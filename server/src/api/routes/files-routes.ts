import type { Context, Hono } from 'hono'
import {
  FileProofingError,
  type CancelFileApprovalInput,
  type CreateFileAnnotationInput,
  type CreateFileApprovalDecisionInput,
  type CreateFileApprovalInput,
  type CreateFileUploadInput,
} from '../../modules/files/file-proofing'
import { workItemDependencies } from '../shared/app-dependencies'
import { loadFileProofingRequestContext } from '../shared/collaboration-access'
import {
  normalizeApprovalReviewerMemberKeys,
  readFileProofingJson,
  requireApprovalReviewers,
  toFileProofingErrorResponse,
} from '../shared/file-approval-access'
import { readBearerAccessToken } from '../shared/http'
import { readRequiredRouteId } from '../shared/input-parsing'
import { createApiMutationContext } from '../shared/project-access'
import {
  listProjectDeliverables,
  readProjectDeliverableQuery,
} from '../shared/project-deliverables'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'

const fileCollectionRoutes = [
  {
    basePath: '/api/teams/:teamId/issues/:issueId/files',
    kind: 'work-item',
  },
  {
    basePath: '/api/teams/:teamId/projects/:projectId/files',
    kind: 'project',
  },
] as const

/**
 * Registers the files HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerFilesRoutes(routeApp: Hono): void {
  for (const fileRoute of fileCollectionRoutes) {
    /** Work Item または Team scoped Project の file/approval 一覧 endpoint です。 */
    routeApp.get(fileRoute.basePath, async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
        return c.json(await workItemDependencies.fileProofing.list(scope, actor))
      } catch (error) {
        return toFileProofingErrorResponse(c, error)
      }
    })

    /** Work Item または Project へ新規 file upload session を作成する endpoint です。 */
    routeApp.post(`${fileRoute.basePath}/uploads`, async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
        const body = await readFileProofingJson<CreateFileUploadInput>(c.req)
        return c.json(
          await workItemDependencies.fileProofing.createUpload(
            scope,
            actor,
            body,
            createApiMutationContext(c, principal, body),
          ),
          201,
        )
      } catch (error) {
        return toFileProofingErrorResponse(c, error)
      }
    })

    /** 既存 file の新 version upload session を作成する endpoint です。 */
    routeApp.post(`${fileRoute.basePath}/:fileId/versions`, async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
        const body = await readFileProofingJson<CreateFileUploadInput>(c.req)
        return c.json(
          await workItemDependencies.fileProofing.createVersionUpload(
            scope,
            actor,
            readRequiredRouteId(c.req.param('fileId'), 'File ID'),
            body,
            createApiMutationContext(c, principal, body),
          ),
          201,
        )
      } catch (error) {
        return toFileProofingErrorResponse(c, error)
      }
    })

    /** Direct upload 完了後に object metadata と scan state を検証する endpoint です。 */
    routeApp.post(`${fileRoute.basePath}/:fileId/versions/:versionId/complete`, async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
        const input = {
          fileId: readRequiredRouteId(c.req.param('fileId'), 'File ID'),
          versionId: readRequiredRouteId(c.req.param('versionId'), 'Version ID'),
        }
        return c.json(await workItemDependencies.fileProofing.completeUpload(
          scope,
          actor,
          input.fileId,
          input.versionId,
          createApiMutationContext(c, principal, input),
        ))
      } catch (error) {
        return toFileProofingErrorResponse(c, error)
      }
    })

    /** Clean version の短命 preview/download URL を発行する endpoint です。 */
    routeApp.get(`${fileRoute.basePath}/:fileId/versions/:versionId/access`, async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
        const disposition = c.req.query('disposition') === 'attachment' ? 'attachment' : 'inline'
        const input = {
          fileId: readRequiredRouteId(c.req.param('fileId'), 'File ID'),
          versionId: readRequiredRouteId(c.req.param('versionId'), 'Version ID'),
          disposition,
        } as const
        return c.json(await workItemDependencies.fileProofing.createAccess(
          scope,
          actor,
          input.fileId,
          input.versionId,
          disposition,
          createApiMutationContext(c, principal, input),
        ))
      } catch (error) {
        return toFileProofingErrorResponse(c, error)
      }
    })

    /** Version の位置 annotation 一覧 endpoint です。 */
    routeApp.get(`${fileRoute.basePath}/:fileId/versions/:versionId/annotations`, async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
        return c.json({
          annotations: await workItemDependencies.fileProofing.listAnnotations(
            scope,
            actor,
            readRequiredRouteId(c.req.param('fileId'), 'File ID'),
            readRequiredRouteId(c.req.param('versionId'), 'Version ID'),
          ),
        })
      } catch (error) {
        return toFileProofingErrorResponse(c, error)
      }
    })

    /** Version preview 上へ位置 annotation を作成する endpoint です。 */
    routeApp.post(`${fileRoute.basePath}/:fileId/versions/:versionId/annotations`, async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
        const body = await readFileProofingJson<CreateFileAnnotationInput>(c.req)
        return c.json({
          annotation: await workItemDependencies.fileProofing.createAnnotation(
            scope,
            actor,
            readRequiredRouteId(c.req.param('fileId'), 'File ID'),
            readRequiredRouteId(c.req.param('versionId'), 'Version ID'),
            body,
            createApiMutationContext(c, principal, body),
          ),
        }, 201)
      } catch (error) {
        return toFileProofingErrorResponse(c, error)
      }
    })

    /** Annotation を解決済みにする endpoint です。 */
    routeApp.post(
      `${fileRoute.basePath}/:fileId/versions/:versionId/annotations/:annotationId/resolve`,
      (c) => handleAnnotationResolution(c, fileRoute.kind, true),
    )

    /** 解決済みの annotation を未解決へ戻す endpoint です。 */
    routeApp.post(
      `${fileRoute.basePath}/:fileId/versions/:versionId/annotations/:annotationId/reopen`,
      (c) => handleAnnotationResolution(c, fileRoute.kind, false),
    )

    /** 作成者が annotation を削除する endpoint です。 */
    routeApp.delete(
      `${fileRoute.basePath}/:fileId/versions/:versionId/annotations/:annotationId`,
      async (c) => {
        const accessToken = readBearerAccessToken(c)
        if (!accessToken) {
          return c.json({ message: 'Bearer token is required.' }, 401)
        }

        try {
          const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
          const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
          const input = readAnnotationRouteInput(c)
          await workItemDependencies.fileProofing.deleteAnnotation(
            scope,
            actor,
            input.fileId,
            input.versionId,
            input.annotationId,
            createApiMutationContext(c, principal, input),
          )
          return c.body(null, 204)
        } catch (error) {
          return toFileProofingErrorResponse(c, error)
        }
      },
    )

    /** File を retention 付きで soft delete する endpoint です。 */
    routeApp.delete(`${fileRoute.basePath}/:fileId`, async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
        const fileId = readRequiredRouteId(c.req.param('fileId'), 'File ID')
        await workItemDependencies.fileProofing.deleteFile(
          scope,
          actor,
          fileId,
          createApiMutationContext(c, principal, { fileId }),
        )
        return c.body(null, 204)
      } catch (error) {
        return toFileProofingErrorResponse(c, error)
      }
    })
  }

  /** Project の添付と、閲覧できる Work Item の添付をまとめた成果物一覧 endpoint です。 */
  routeApp.get('/api/teams/:teamId/projects/:projectId/deliverables', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      return c.json(await listProjectDeliverables(
        principal,
        readRequiredRouteId(c.req.param('teamId'), 'Team ID'),
        readRequiredRouteId(c.req.param('projectId'), 'Project ID'),
        readProjectDeliverableQuery((name) => c.req.query(name)),
      ))
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })

  /** Project file の現在 version に approval request を作成する endpoint です。 */
  routeApp.post('/api/teams/:teamId/projects/:projectId/approvals', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, 'project')
      if (!actor.canWrite || actor.guest) {
        throw new FileProofingError(403, 'FileWriteDenied', 'File write access is required.')
      }
      const body = await readFileProofingJson<CreateFileApprovalInput>(c.req)
      const reviewerMemberKeys = normalizeApprovalReviewerMemberKeys(body.reviewerMemberKeys)
      if (body.completionTransition !== undefined) {
        throw new FileProofingError(
          400,
          'ApprovalCompletionTransitionUnsupported',
          'A Project file approval cannot move a Work Item when it completes.',
        )
      }
      const collection = await workItemDependencies.fileProofing.list(scope, actor)
      const targetFile = collection.files.find((file) => file.id === body.fileId)
      if (!targetFile || targetFile.currentVersion.id !== body.versionId) {
        throw new FileProofingError(
          409,
          'ApprovalVersionStale',
          'Approval must target the current file version.',
        )
      }
      const reviewerMembers = await requireApprovalReviewers(
        principal.directoryId,
        scope.teamId,
        scope.projectId,
        reviewerMemberKeys,
      )
      if (reviewerMembers.some((member) => member.role === 'guest') && !targetFile.guestAccess) {
        throw new FileProofingError(
          409,
          'ApprovalGuestFileAccessDenied',
          'Guest reviewers require an explicitly guest-shared file.',
        )
      }
      const input = {
        fileId: targetFile.id,
        versionId: targetFile.currentVersion.id,
        reviewerMemberKeys,
        dueAt: body.dueAt,
      } satisfies CreateFileApprovalInput
      return c.json({
        approval: await workItemDependencies.fileProofing.createApproval(
          scope,
          actor,
          input,
          createApiMutationContext(c, principal, input),
        ),
      }, 201)
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })

  /** Project file approval の reviewer decision を保存する endpoint です。 */
  routeApp.post('/api/teams/:teamId/projects/:projectId/approvals/:approvalId/decisions', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, 'project')
      const body = await readFileProofingJson<CreateFileApprovalDecisionInput>(c.req)
      const input = {
        decision: body.decision,
        expectedRevision: body.expectedRevision,
        ...(body.comment === undefined ? {} : { comment: body.comment }),
      } satisfies CreateFileApprovalDecisionInput
      return c.json({
        approval: await workItemDependencies.fileProofing.decideApproval(
          scope,
          actor,
          readRequiredRouteId(c.req.param('approvalId'), 'Approval ID'),
          input,
          createApiMutationContext(c, principal, input),
        ),
      })
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })

  /** Requester または manager が Project file の pending approval を取り消す endpoint です。 */
  routeApp.post('/api/teams/:teamId/projects/:projectId/approvals/:approvalId/cancel', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, 'project')
      const body = await readFileProofingJson<CancelFileApprovalInput>(c.req)
      const input = {
        expectedRevision: body.expectedRevision,
      } satisfies CancelFileApprovalInput
      return c.json({
        approval: await workItemDependencies.fileProofing.cancelApproval(
          scope,
          actor,
          readRequiredRouteId(c.req.param('approvalId'), 'Approval ID'),
          input,
          createApiMutationContext(c, principal, input),
        ),
      })
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })
}

/**
 * Reads the file, version, and annotation route IDs of an annotation mutation.
 *
 * @param c - Hono request context.
 * @returns The validated route IDs.
 */
function readAnnotationRouteInput(c: Context) {
  return {
    fileId: readRequiredRouteId(c.req.param('fileId'), 'File ID'),
    versionId: readRequiredRouteId(c.req.param('versionId'), 'Version ID'),
    annotationId: readRequiredRouteId(c.req.param('annotationId'), 'Annotation ID'),
  }
}

/**
 * Resolves or reopens one annotation for a Work Item or Project file route.
 *
 * @param c - Hono request context.
 * @param kind - Scope kind of the route.
 * @param resolved - `true` to resolve, `false` to reopen.
 * @returns The changed annotation or an error response.
 */
async function handleAnnotationResolution(
  c: Context,
  kind: (typeof fileCollectionRoutes)[number]['kind'],
  resolved: boolean,
) {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    const { scope, actor } = await loadFileProofingRequestContext(c, principal, kind)
    const input = { ...readAnnotationRouteInput(c), resolved }
    return c.json({
      annotation: await workItemDependencies.fileProofing.setAnnotationResolution(
        scope,
        actor,
        input.fileId,
        input.versionId,
        input.annotationId,
        resolved,
        createApiMutationContext(c, principal, input),
      ),
    })
  } catch (error) {
    return toFileProofingErrorResponse(c, error)
  }
}
