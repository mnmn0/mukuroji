import { type SetAcceptedResolutionRequest } from '@mukuroji/contracts'
import type { Hono } from 'hono'
import { ProjectDataError } from '../../modules/directory'
import {
  createTeamIssueAuditEntityId,
  createTeamIssueDeepLink,
  readRequiredCommentBody,
  type CreateTeamIssueCommentRequestBody,
} from '../../modules/work-items'
import {
  COLLABORATION_CONTEXT_BODY_MAX_LENGTH,
  createProjectCollaborationEntityKey,
  createWorkItemCollaborationEntityKey,
} from '../../modules/collaboration/collaboration'
import { FileProofingError, type CreateFileUploadInput } from '../../modules/files/file-proofing'
import { workItemDependencies } from '../shared/app-dependencies'
import {
  canManageTeamIssueCollaboration,
  createCollaborationCommentAuthorizationConditionChecks,
  createTeamIssueAutomaticWatcherCandidates,
  loadFileProofingRequestContext,
  readCommentMentionMemberKeys,
  readOptionalCommentId,
  requireValidCommentMentions,
  toCollaborationCommentResponse,
  toCollaborationErrorResponse,
} from '../shared/collaboration-access'
import { createCommentSearchDocument } from '../shared/document-access'
import { readFileProofingJson, toFileProofingErrorResponse } from '../shared/file-approval-access'
import {
  invalidCuratedContextInput,
  readBearerAccessToken,
  readCuratedContextIdentifier,
  readCuratedContextRevision,
  readCuratedContextText,
  readJson,
} from '../shared/http'
import { readRequiredRouteId } from '../shared/input-parsing'
import {
  createApiMutationContext,
  createCuratedContextActorSnapshot,
  requireProjectPermission,
  requireWorkspaceBusinessWrite,
} from '../shared/project-access'
import {
  assertCuratedContextScopeUnchanged,
  authenticateWorkspacePrincipal,
} from '../shared/request-authorization'
import {
  deleteWorkspaceSearchDocumentBestEffort,
  projectWorkspaceSearchDocumentBestEffort,
} from '../shared/search-access'
import { isRecord } from '../shared/value-guards'
import { loadAuthorizedTeamIssue } from '../shared/work-item-access'

/**
 * チーム Issue コメント更新 API が受け取る request body です。
 */
type UpdateTeamIssueCommentRequestBody = {
  /**
   * 更新後の Markdown source です。
   */
  bodyMarkdown?: unknown
  /**
   * Composer が解決した安定した Workspace member key です。
   */
  mentionMemberKeys?: unknown
  /**
   * 読み込み時点の comment version です。
   */
  expectedVersion?: unknown
}

/**
 * Comment resolve/reopen/delete API が受け取る request body です。
 */
type VersionedTeamIssueCommentRequestBody = {
  /**
   * 読み込み時点の comment version です。
   */
  expectedVersion?: unknown
}

/**
 * Reads and validates a thread accepted-resolution payload.
 *
 * @param value - Untrusted JSON request body.
 * @returns Validated shared accepted-resolution request.
 */
function readSetAcceptedResolutionRequest(
  value: unknown,
): SetAcceptedResolutionRequest {
  if (!isRecord(value)) {
    throw invalidCuratedContextInput('Accepted resolution request body must be an object.')
  }
  return {
    expectedThreadVersion: readCuratedContextRevision(
      value.expectedThreadVersion,
      'Expected thread version',
    ),
    commentId: readCuratedContextIdentifier(value.commentId, 'Accepted comment ID'),
    summary: readCuratedContextText(
      value.summary,
      'Accepted resolution summary',
      COLLABORATION_CONTEXT_BODY_MAX_LENGTH,
    ),
  }
}

function readCommentExpectedVersion(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'A positive expectedVersion is required.',
    )
  }

  return value as number
}

/**
 * Registers the collaboration HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerCollaborationRoutes(routeApp: Hono): void {
  /** 現在 user の project watcher state を返します。 */
  routeApp.get('/api/projects/:projectId/watch', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const projectId = c.req.param('projectId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }
    if (!projectId) {
      return c.json({ message: 'Project ID is required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      await requireProjectPermission(principal, projectId, 'viewer')
      const watch = await workItemDependencies.collaboration.getWatcherState({
        entityKey: createProjectCollaborationEntityKey(principal.directoryId, projectId),
        memberKey: principal.userKey,
      })
      return c.json({ watch })
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })

  for (const projectWatchMethod of ['PUT', 'DELETE'] as const) {
    /** Project watcher の subscribe/unsubscribe endpoint です。 */
    routeApp.on(projectWatchMethod, '/api/projects/:projectId/watch', async (c) => {
      const accessToken = readBearerAccessToken(c)
      const projectId = c.req.param('projectId')

      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }
      if (!projectId) {
        return c.json({ message: 'Project ID is required.' }, 400)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        requireWorkspaceBusinessWrite(principal)
        await requireProjectPermission(principal, projectId, 'viewer')
        const mutationInput = {
          workspaceId: principal.directoryId,
          entityKey: createProjectCollaborationEntityKey(principal.directoryId, projectId),
          projectId,
          memberKey: principal.userKey,
          auditContext: createApiMutationContext(c, principal, { projectId, method: projectWatchMethod }),
        }
        const watch = projectWatchMethod === 'PUT'
          ? await workItemDependencies.collaboration.subscribe(mutationInput)
          : await workItemDependencies.collaboration.unsubscribe(mutationInput)
        return c.json({ watch })
      } catch (error) {
        return toCollaborationErrorResponse(c, error)
      }
    })
  }

  /** Root thread の accepted resolution history を cursor page で返します。 */
  routeApp.get(
    '/api/teams/:teamId/issues/:issueId/comments/:rootCommentId/accepted-resolutions',
    async (c) => {
      const accessToken = readBearerAccessToken(c)
      const teamId = c.req.param('teamId')
      const issueId = c.req.param('issueId')
      const rootCommentId = c.req.param('rootCommentId')

      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
        const limitValue = c.req.query('limit')
        const page = await workItemDependencies.collaboration.getAcceptedResolutionHistory({
          entityKey: createWorkItemCollaborationEntityKey(
            principal.directoryId,
            teamId,
            issueId,
          ),
          rootCommentId,
          limit: limitValue === undefined ? undefined : Number(limitValue),
          cursor: c.req.query('cursor'),
        })
        await assertCuratedContextScopeUnchanged(
          principal,
          teamId,
          issueId,
          'viewer',
          detail.issue.assignedProjectId,
          accessToken,
          c,
        )
        return c.json(page)
      } catch (error) {
        return toCollaborationErrorResponse(c, error)
      }
    },
  )

  /** Root thread の accepted resolution を選択・差し替え・再要約します。 */
  routeApp.put('/api/teams/:teamId/issues/:issueId/comments/:rootCommentId/accepted-resolution', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')
    const rootCommentId = c.req.param('rootCommentId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const request = readSetAcceptedResolutionRequest(await readJson<unknown>(c.req))
      const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
      const comment = await workItemDependencies.collaboration.setAcceptedResolution({
        workspaceId: principal.directoryId,
        teamId,
        issueId,
        workItemTitle: detail.issue.title,
        entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId),
        projectId: detail.issue.assignedProjectId,
        projectEntityKey: detail.issue.assignedProjectId
          ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
          : undefined,
        assigneeMemberKey: detail.issue.assigneeUserId,
        rootCommentId,
        actor: createCuratedContextActorSnapshot(principal),
        authorizationSnapshot: {
          memberKey: principal.userKey,
          workspaceMemberVersion: principal.workspaceMember.version,
          ...(principal.enterpriseIdentityControlRevision === undefined
            ? {}
            : { enterpriseControlRevision: principal.enterpriseIdentityControlRevision }),
        },
        expectedThreadVersion: request.expectedThreadVersion,
        commentId: request.commentId,
        summary: request.summary,
        canModerate: canManageTeamIssueCollaboration(
          principal,
          context,
          detail.issue.assignedProjectId,
        ) || detail.issue.assigneeUserId === principal.userKey,
        deepLink: createTeamIssueDeepLink(teamId, issueId),
        auditContext: createApiMutationContext(c, principal, {
          teamId,
          issueId,
          rootCommentId,
          ...request,
        }),
      })
      const currentPrincipal = await assertCuratedContextScopeUnchanged(
        principal,
        teamId,
        issueId,
        'viewer',
        detail.issue.assignedProjectId,
        accessToken,
        c,
      )
      const current = await loadAuthorizedTeamIssue(currentPrincipal, teamId, issueId, 'viewer')
      return c.json({
        comment: toCollaborationCommentResponse(
          comment,
          currentPrincipal,
          current.context,
          current.detail.issue,
        ),
      })
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })

  /**
   * DynamoDB にチーム所有 Issue のコメントを作成する endpoint です。
   */
  routeApp.post('/api/teams/:teamId/issues/:issueId/comments', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!teamId || !issueId) {
      return c.json({ message: 'Team ID and issue ID are required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const body = await readJson<CreateTeamIssueCommentRequestBody>(c.req) ?? {}
      const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'member')
      const mentionMemberKeys = readCommentMentionMemberKeys(body.mentionMemberKeys)
      await requireValidCommentMentions(
        principal.directoryId,
        mentionMemberKeys,
        context,
        detail.issue.assignedProjectId,
      )
      const entityKey = createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId)
      const projectEntityKey = detail.issue.assignedProjectId
        ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
        : undefined
      const automaticWatcherCandidates = createTeamIssueAutomaticWatcherCandidates(detail.issue)
      const authorizationConditionChecks =
        await createCollaborationCommentAuthorizationConditionChecks(
          principal,
          context,
          teamId,
          detail.issue.assignedProjectId,
        )
      const comment = await workItemDependencies.collaboration.createComment({
        workspaceId: principal.directoryId,
        teamId,
        issueId,
        workItemTitle: detail.issue.title,
        entityKey,
        projectId: detail.issue.assignedProjectId,
        projectEntityKey,
        assigneeMemberKey: detail.issue.assigneeUserId,
        actorMemberKey: principal.userKey,
        bodyMarkdown: readRequiredCommentBody(body.bodyMarkdown),
        parentCommentId: readOptionalCommentId(body.parentCommentId, 'Parent comment ID'),
        mentionMemberKeys,
        automaticWatcherCandidates,
        deepLink: createTeamIssueDeepLink(teamId, issueId),
        authorizationConditionChecks,
        auditContext: createApiMutationContext(c, principal, { teamId, issueId, ...body }),
      })
      const activity = {
        id: comment.id,
        type: 'commented' as const,
        actorUserId: principal.userKey,
        summary: body.parentCommentId ? 'Reply was added.' : 'Comment was added.',
        createdAt: comment.createdAt,
      }
      await projectWorkspaceSearchDocumentBestEffort(
        () => createCommentSearchDocument(
          principal.directoryId,
          teamId,
          detail.issue,
          comment,
        ),
        'comment creation',
      )

      return c.json({
        comment: toCollaborationCommentResponse(comment, principal, context, detail.issue),
        activity,
      }, 201)
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })

  /** 保存済み comment の Markdown 本文と mention を更新します。 */
  routeApp.patch('/api/teams/:teamId/issues/:issueId/comments/:commentId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')
    const commentId = c.req.param('commentId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const body = await readJson<UpdateTeamIssueCommentRequestBody>(c.req) ?? {}
      const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
      const mentionMemberKeys = readCommentMentionMemberKeys(body.mentionMemberKeys)
      await requireValidCommentMentions(
        principal.directoryId,
        mentionMemberKeys,
        context,
        detail.issue.assignedProjectId,
      )
      const entityKey = createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId)
      const projectEntityKey = detail.issue.assignedProjectId
        ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
        : undefined
      const automaticWatcherCandidates = createTeamIssueAutomaticWatcherCandidates(detail.issue)
      const comment = await workItemDependencies.collaboration.updateComment({
        workspaceId: principal.directoryId,
        teamId,
        issueId,
        workItemTitle: detail.issue.title,
        entityKey,
        projectId: detail.issue.assignedProjectId,
        projectEntityKey,
        actorMemberKey: principal.userKey,
        commentId,
        bodyMarkdown: readRequiredCommentBody(body.bodyMarkdown),
        mentionMemberKeys,
        automaticWatcherCandidates,
        expectedVersion: readCommentExpectedVersion(body.expectedVersion),
        deepLink: createTeamIssueDeepLink(teamId, issueId),
        auditContext: createApiMutationContext(c, principal, { teamId, issueId, commentId, ...body }),
      })
      await projectWorkspaceSearchDocumentBestEffort(
        () => createCommentSearchDocument(
          principal.directoryId,
          teamId,
          detail.issue,
          comment,
        ),
        'comment update',
      )

      return c.json({
        comment: toCollaborationCommentResponse(comment, principal, context, detail.issue),
      })
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })

  /** 保存済み comment を soft delete します。 */
  routeApp.delete('/api/teams/:teamId/issues/:issueId/comments/:commentId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')
    const commentId = c.req.param('commentId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
      const body = await readJson<VersionedTeamIssueCommentRequestBody>(c.req) ?? {}
      const canModerate = canManageTeamIssueCollaboration(
        principal,
        context,
        detail.issue.assignedProjectId,
      )
      const comment = await workItemDependencies.collaboration.deleteComment({
        workspaceId: principal.directoryId,
        teamId,
        issueId,
        entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId),
        projectId: detail.issue.assignedProjectId,
        projectEntityKey: detail.issue.assignedProjectId
          ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
          : undefined,
        actorMemberKey: principal.userKey,
        commentId,
        expectedVersion: readCommentExpectedVersion(body.expectedVersion),
        canModerate,
        auditContext: createApiMutationContext(c, principal, { teamId, issueId, commentId, ...body }),
      })
      await deleteWorkspaceSearchDocumentBestEffort(
        principal.directoryId,
        'comment',
        `${createTeamIssueAuditEntityId(teamId, issueId)}/comment/${commentId}`,
        'comment deletion',
      )

      return c.json({
        comment: toCollaborationCommentResponse(comment, principal, context, detail.issue),
      })
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })

  for (const resolutionAction of ['resolve', 'reopen'] as const) {
    /** Root comment thread の resolve/reopen endpoint です。 */
    routeApp.post(`/api/teams/:teamId/issues/:issueId/comments/:commentId/${resolutionAction}`, async (c) => {
      const accessToken = readBearerAccessToken(c)
      const teamId = c.req.param('teamId')
      const issueId = c.req.param('issueId')
      const commentId = c.req.param('commentId')

      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        requireWorkspaceBusinessWrite(principal)
        const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
        const body = await readJson<VersionedTeamIssueCommentRequestBody>(c.req) ?? {}
        const isAssignee = detail.issue.assigneeUserId === principal.userKey
        const canModerate = canManageTeamIssueCollaboration(
          principal,
          context,
          detail.issue.assignedProjectId,
        ) || isAssignee
        const mutationInput = {
          workspaceId: principal.directoryId,
          teamId,
          issueId,
          entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId),
          projectId: detail.issue.assignedProjectId,
          projectEntityKey: detail.issue.assignedProjectId
            ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
            : undefined,
          assigneeMemberKey: detail.issue.assigneeUserId,
          actorMemberKey: principal.userKey,
          commentId,
          expectedVersion: readCommentExpectedVersion(body.expectedVersion),
          canModerate,
          auditContext: createApiMutationContext(c, principal, {
            teamId,
            issueId,
            commentId,
            action: resolutionAction,
            ...body,
          }),
        }
        const comment = resolutionAction === 'resolve'
          ? await workItemDependencies.collaboration.resolveComment(mutationInput)
          : await workItemDependencies.collaboration.reopenComment(mutationInput)

        return c.json({
          comment: toCollaborationCommentResponse(comment, principal, context, detail.issue),
        })
      } catch (error) {
        return toCollaborationErrorResponse(c, error)
      }
    })
  }

  for (const reactionMethod of ['PUT', 'DELETE'] as const) {
    /** Emoji reaction の idempotent add/remove endpoint です。 */
    routeApp.on(reactionMethod, '/api/teams/:teamId/issues/:issueId/comments/:commentId/reactions/:emoji', async (c) => {
      const accessToken = readBearerAccessToken(c)
      const teamId = c.req.param('teamId')
      const issueId = c.req.param('issueId')
      const commentId = c.req.param('commentId')
      const emoji = c.req.param('emoji')

      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        requireWorkspaceBusinessWrite(principal)
        const { detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'member')
        const mutationInput = {
          workspaceId: principal.directoryId,
          teamId,
          issueId,
          entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId),
          projectId: detail.issue.assignedProjectId,
          projectEntityKey: detail.issue.assignedProjectId
            ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
            : undefined,
          actorMemberKey: principal.userKey,
          commentId,
          emoji,
          auditContext: createApiMutationContext(c, principal, {
            teamId,
            issueId,
            commentId,
            emoji,
            method: reactionMethod,
          }),
        }

        if (reactionMethod === 'PUT') {
          await workItemDependencies.collaboration.addReaction(mutationInput)
        } else {
          await workItemDependencies.collaboration.removeReaction(mutationInput)
        }

        return c.json({})
      } catch (error) {
        return toCollaborationErrorResponse(c, error)
      }
    })
  }

  /** 現在 user の Work Item watcher state を返します。 */
  routeApp.get('/api/teams/:teamId/issues/:issueId/watch', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
      const watch = await workItemDependencies.collaboration.getWatcherState({
        entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId),
        memberKey: principal.userKey,
        projectEntityKey: detail.issue.assignedProjectId
          ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
          : undefined,
      })
      return c.json({ watch })
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })

  for (const watchMethod of ['PUT', 'DELETE'] as const) {
    /** Work Item watcher の subscribe/unsubscribe endpoint です。 */
    routeApp.on(watchMethod, '/api/teams/:teamId/issues/:issueId/watch', async (c) => {
      const accessToken = readBearerAccessToken(c)
      const teamId = c.req.param('teamId')
      const issueId = c.req.param('issueId')

      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        requireWorkspaceBusinessWrite(principal)
        const { detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
        const mutationInput = {
          workspaceId: principal.directoryId,
          teamId,
          issueId,
          entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId),
          projectId: detail.issue.assignedProjectId,
          projectEntityKey: detail.issue.assignedProjectId
            ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
            : undefined,
          memberKey: principal.userKey,
          auditContext: createApiMutationContext(c, principal, {
            teamId,
            issueId,
            method: watchMethod,
          }),
        }
        const watch = watchMethod === 'PUT'
          ? await workItemDependencies.collaboration.subscribe(mutationInput)
          : await workItemDependencies.collaboration.unsubscribe(mutationInput)
        return c.json({ watch })
      } catch (error) {
        return toCollaborationErrorResponse(c, error)
      }
    })
  }

  /** 保存済み comment へ file を添付する direct upload session endpoint です。 */
  routeApp.post('/api/teams/:teamId/issues/:issueId/comments/:commentId/files/uploads', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const context = await loadFileProofingRequestContext(c, principal, 'work-item')
      const commentId = readRequiredRouteId(c.req.param('commentId'), 'Comment ID')
      const commentExists = await workItemDependencies.collaboration.hasAttachableComment(
        createWorkItemCollaborationEntityKey(
          principal.directoryId,
          context.scope.teamId,
          context.scope.issueId!,
        ),
        commentId,
      )
      if (!commentExists) {
        throw new FileProofingError(
          404,
          'CommentNotFound',
          'The attachment target comment was not found.',
        )
      }
      const scope = {
        ...context.scope,
        commentId,
      }
      const body = await readFileProofingJson<CreateFileUploadInput>(c.req)
      return c.json(
        await workItemDependencies.fileProofing.createUpload(
          scope,
          context.actor,
          body,
          createApiMutationContext(c, principal, { ...body, commentId: scope.commentId }),
        ),
        201,
      )
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })
}
