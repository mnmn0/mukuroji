import {
  GITHUB_PULL_REQUEST_INBOX_VIEWS,
  GITHUB_REPOSITORY_ID_PATTERN,
  isGitHubLogin,
  parseSaveGitHubLoginRequest,
  parseSaveGitHubRepositoryLinkRequest,
  type GitHubPullRequestInboxView,
} from '@mukuroji/contracts'
import type { Context, Hono } from 'hono'
import {
  deleteGitHubLogin,
  deleteGitHubLoginHolder,
  deleteGitHubRepositoryLink,
  GitHubIntegrationError,
  listGitHubRepositoryLinks,
  readGitHubLogin,
  readGitHubPullRequestInbox,
  readGitHubWebhookBody,
  receiveGitHubWebhook,
  saveGitHubLogin,
  saveGitHubRepositoryLink,
  type GitHubIntegrationErrorCategory,
} from '../../modules/github-integration'
import { workItemDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { readBearerAccessToken, readJson } from '../shared/http'
import {
  createApiMutationContext,
  listPermittedTeams,
  requireWorkspaceAdministration,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { enforceActiveTenantForWorkspace } from '../shared/workspace-access'

/** HTTP status of each GitHub integration error category. */
const CATEGORY_STATUS = {
  'invalid-input': 400,
  'not-found': 404,
  conflict: 409,
  'not-configured': 409,
  unavailable: 503,
} as const satisfies Record<GitHubIntegrationErrorCategory, number>

/**
 * Registers the GitHub App routes (#775, ADR 0079).
 *
 * `POST /api/integrations/github/webhook` is public: GitHub signs each delivery with the App's
 * webhook secret, and a delivery without a valid `X-Hub-Signature-256` is refused before its body
 * is parsed. The other routes need the usual sign-in: members read their review inbox and register
 * their own GitHub login, and Workspace administrators link repositories to Teams.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerGitHubIntegrationRoutes(routeApp: Hono): void {
  /** Receives one GitHub App webhook delivery and queues its sync job. */
  routeApp.post('/api/integrations/github/webhook', async (c) => {
    c.header('Cache-Control', 'no-store')
    const integration = workItemDependencies.githubIntegration
    try {
      if (!integration.workspaceId) return c.json({ code: 'GitHubAppNotConfigured' }, 404)
      const body = await readGitHubWebhookBody(c.req.raw)
      if (body.kind === 'too-large') return c.json({ code: 'GitHubWebhookTooLarge' }, 413)
      await enforceActiveTenantForWorkspace(integration.workspaceId)
      const receipt = await receiveGitHubWebhook(integration, {
        eventName: c.req.header('X-GitHub-Event'),
        signature: c.req.header('X-Hub-Signature-256'),
        rawBody: body.bytes,
      })
      switch (receipt.kind) {
        case 'not-configured':
          return c.json({ code: 'GitHubAppNotConfigured' }, 404)
        case 'unauthorized':
          return c.json({ code: 'GitHubWebhookSignatureInvalid' }, 401)
        case 'invalid':
          return c.json({ code: 'GitHubWebhookInvalid' }, 400)
        case 'pong':
          return c.json({ status: 'ok' }, 200)
        case 'ignored':
          return c.json({ status: 'ignored' }, 202)
        case 'accepted':
          return c.json({ status: 'accepted' }, 202)
      }
    } catch (error) {
      if (error instanceof GitHubIntegrationError) {
        console.error('GitHub webhook failed.', {
          requestId: c.req.header('X-Request-Id'),
          deliveryId: readDeliveryId(c),
          code: error.code,
        })
        return c.json({ code: error.code }, 503)
      }
      return toProjectDataErrorResponse(c, error)
    }
  })

  /** Lists one tab of the caller's pull request review inbox. */
  routeApp.get('/api/me/pull-requests', async (c) => {
    return withPrincipal(c, async (principal) => {
      const view = readView(c.req.query('view'))
      const response = await readGitHubPullRequestInbox(
        workItemDependencies.githubIntegration,
        toMember(principal),
        view,
        async () => new Set((await listPermittedTeams(principal, 'viewer')).map((context) => context.team.id)),
        new Date(),
      )
      c.header('Cache-Control', 'no-store')
      return c.json(response)
    })
  })

  /** Reads the caller's GitHub login. */
  routeApp.get('/api/me/github-login', async (c) => {
    return withPrincipal(c, async (principal) =>
      c.json(await readGitHubLogin(workItemDependencies.githubIntegration.store, toMember(principal))))
  })

  /** Registers or replaces the caller's GitHub login. */
  routeApp.put('/api/me/github-login', async (c) => {
    return withPrincipal(c, async (principal) => {
      const body = await readJson<unknown>(c.req)
      const request = parseInput(() => parseSaveGitHubLoginRequest(body))
      return c.json(await saveGitHubLogin(workItemDependencies.githubIntegration.store, toMember(principal), request.githubLogin, {
        auditContext: createApiMutationContext(c, principal, request),
        now: new Date().toISOString(),
      }))
    })
  })

  /** Removes the caller's GitHub login. */
  routeApp.delete('/api/me/github-login', async (c) => {
    return withPrincipal(c, async (principal) => {
      await deleteGitHubLogin(workItemDependencies.githubIntegration.store, toMember(principal), {
        auditContext: createApiMutationContext(c, principal, {}),
        now: new Date().toISOString(),
      })
      return c.body(null, 204)
    })
  })

  /** Lists the repositories the App can read with their Team links. */
  routeApp.get('/api/workspace/github/repositories', async (c) => {
    return withPrincipal(c, async (principal) => {
      requireWorkspaceAdministration(principal)
      c.header('Cache-Control', 'no-store')
      return c.json(await listGitHubRepositoryLinks(workItemDependencies.githubIntegration, principal.directoryId))
    })
  })

  /** Links a repository to a Team, or moves it to another Team. */
  routeApp.put('/api/workspace/github/repositories/:repositoryId', async (c) => {
    return withPrincipal(c, async (principal) => {
      requireWorkspaceAdministration(principal)
      const repositoryId = readRepositoryId(c.req.param('repositoryId'))
      const body = await readJson<unknown>(c.req)
      const request = parseInput(() => parseSaveGitHubRepositoryLinkRequest(body))
      const link = await saveGitHubRepositoryLink(workItemDependencies.githubIntegration, principal.directoryId, repositoryId, request, {
        teamExists: async (teamId) => (await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja'))
          .teams.some((team) => team.id === teamId),
        auditContext: createApiMutationContext(c, principal, { repositoryId, ...request }),
        now: new Date().toISOString(),
      })
      return c.json(link)
    })
  })

  /** Removes a repository's Team link. */
  routeApp.delete('/api/workspace/github/repositories/:repositoryId', async (c) => {
    return withPrincipal(c, async (principal) => {
      requireWorkspaceAdministration(principal)
      const repositoryId = readRepositoryId(c.req.param('repositoryId'))
      const expectedRevision = Number(c.req.query('expectedRevision'))
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new GitHubIntegrationError('invalid-input', 'GitHubRepositoryLinkRevisionRequired', 'expectedRevision must be a positive integer.')
      }
      await deleteGitHubRepositoryLink(workItemDependencies.githubIntegration.store, principal.directoryId, repositoryId, expectedRevision, {
        auditContext: createApiMutationContext(c, principal, { repositoryId, expectedRevision }),
        now: new Date().toISOString(),
      })
      return c.body(null, 204)
    })
  })

  /** Removes another member's GitHub login, for an administrator resolving a wrong registration. */
  routeApp.delete('/api/workspace/github/logins/:login', async (c) => {
    return withPrincipal(c, async (principal) => {
      requireWorkspaceAdministration(principal)
      const login = c.req.param('login')
      if (!isGitHubLogin(login)) throw new GitHubIntegrationError('invalid-input', 'GitHubLoginInvalid', 'The GitHub login is invalid.')
      await deleteGitHubLoginHolder(workItemDependencies.githubIntegration.store, principal.directoryId, login, {
        auditContext: createApiMutationContext(c, principal, { login }),
        now: new Date().toISOString(),
      })
      return c.body(null, 204)
    })
  })
}

/**
 * Authenticates the caller and runs a handler, mapping its errors to responses.
 *
 * @param c - Request context.
 * @param handler - Route body.
 * @returns The response.
 */
async function withPrincipal(c: Context, handler: (principal: WorkspacePrincipal) => Promise<Response>): Promise<Response> {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    return await handler(principal)
  } catch (error) {
    if (error instanceof GitHubIntegrationError) {
      const status = CATEGORY_STATUS[error.category]
      if (status >= 500) {
        console.error('GitHub integration request failed.', { requestId: c.req.header('X-Request-Id'), code: error.code })
      }
      return c.json({ code: error.code, message: error.message }, status)
    }
    return toProjectDataErrorResponse(c, error)
  }
}

/**
 * Builds the member a use case acts for.
 *
 * @param principal - Authenticated principal.
 * @returns Workspace and member key.
 */
function toMember(principal: WorkspacePrincipal) {
  return { workspaceId: principal.directoryId, memberKey: principal.userKey }
}

/**
 * Reads the inbox tab; the default is `to-review`.
 *
 * @param value - `view` query parameter.
 * @returns The tab.
 */
function readView(value: string | undefined): GitHubPullRequestInboxView {
  if (value === undefined || value === '') return 'to-review'
  const view = GITHUB_PULL_REQUEST_INBOX_VIEWS.find((candidate) => candidate === value)
  if (!view) throw new GitHubIntegrationError('invalid-input', 'GitHubInboxViewInvalid', 'view must be created or to-review.')
  return view
}

/**
 * Validates a repository ID path parameter.
 *
 * @param value - Path parameter.
 * @returns The ID.
 */
function readRepositoryId(value: string | undefined): string {
  if (!value || !GITHUB_REPOSITORY_ID_PATTERN.test(value)) {
    throw new GitHubIntegrationError('invalid-input', 'GitHubRepositoryIdInvalid', 'The repository ID is invalid.')
  }
  return value
}

/**
 * Runs a contract parser, classifying its error as invalid input.
 *
 * @param parse - Parser call.
 * @returns The parsed request.
 */
function parseInput<T>(parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    if (error instanceof TypeError) throw new GitHubIntegrationError('invalid-input', 'GitHubIntegrationInvalidInput', error.message)
    throw error
  }
}

/**
 * Reads GitHub's delivery ID for logs, when it is a UUID.
 *
 * @param c - Request context.
 * @returns The delivery ID, or `undefined`.
 */
function readDeliveryId(c: Context): string | undefined {
  const value = c.req.header('X-GitHub-Delivery')
  return value && /^[0-9a-f-]{36}$/u.test(value) ? value : undefined
}
