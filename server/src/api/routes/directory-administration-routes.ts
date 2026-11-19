import type { Context, Hono } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import { createTeamWorkspaceSearchDocument } from '../../modules/workspace-search/workspace-search'
import { workspaceDependencies } from '../shared/app-dependencies'
import { readBearerAccessToken, readJson, toAuthErrorResponse } from '../shared/http'
import {
  createApiMutationContext,
  requireWorkspaceAdministration,
  toProjectDataErrorResponse,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { projectWorkspaceSearchDocumentBestEffort } from '../shared/search-access'
import { projectCharterSearchDocumentBestEffort } from './project-charter-routes'

/**
 * Registers the endpoints that rename, restore, and reorder Teams and Projects.
 *
 * Every endpoint requires Workspace administration, the same as creating or archiving a Team or
 * Project. IDs never change, so URLs and links keep working after a rename.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerDirectoryAdministrationRoutes(routeApp: Hono): void {
  /** Lists every Team and Project, archived ones included, with both localized names. */
  routeApp.get('/api/teams/directory', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) =>
      await workspaceDependencies.projectDirectory.getDirectoryAdministration(
        principal.directoryId,
      ))
  })

  /** Sets the display order of every active Team. */
  routeApp.put('/api/teams/order', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) => {
      const body = await readJson<unknown>(c.req)
      return await workspaceDependencies.projectDirectory.reorderTeams(
        principal.directoryId,
        body,
        createApiMutationContext(c, principal, body ?? {}),
      )
    })
  })

  /** Renames an active Team. */
  routeApp.patch('/api/teams/:teamId', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) => {
      const teamId = readRouteIdentifier(c, 'teamId')
      const body = await readJson<unknown>(c.req)
      const response = await workspaceDependencies.projectDirectory.renameTeam(
        principal.directoryId,
        teamId,
        body,
        createApiMutationContext(c, principal, { teamId, body }),
      )
      await projectTeamSearchDocument(
        principal.directoryId,
        teamId,
        response.nameJa,
        response.nameEn,
        'team rename',
      )
      return response
    })
  })

  /** Restores an archived Team. */
  routeApp.patch('/api/teams/:teamId/restore', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) => {
      const teamId = readRouteIdentifier(c, 'teamId')
      const response = await workspaceDependencies.projectDirectory.restoreTeam(
        principal.directoryId,
        teamId,
        createApiMutationContext(c, principal, { teamId }),
      )
      await projectRestoredTeamSearchDocument(principal.directoryId, teamId)
      return response
    })
  })

  /** Sets the display order of every active Project of one Team. */
  routeApp.put('/api/teams/:teamId/project-order', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) => {
      const teamId = readRouteIdentifier(c, 'teamId')
      const body = await readJson<unknown>(c.req)
      return await workspaceDependencies.projectDirectory.reorderProjects(
        principal.directoryId,
        teamId,
        body,
        createApiMutationContext(c, principal, { teamId, body }),
      )
    })
  })

  /** Renames an active Project or changes its color. */
  routeApp.patch('/api/teams/:teamId/projects/:projectId', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) => {
      const teamId = readRouteIdentifier(c, 'teamId')
      const projectId = readRouteIdentifier(c, 'projectId')
      const body = await readJson<unknown>(c.req)
      const response = await workspaceDependencies.projectDirectory.renameProject(
        principal.directoryId,
        teamId,
        projectId,
        body,
        createApiMutationContext(c, principal, { teamId, projectId, body }),
      )
      await projectProjectSearchDocument(principal.directoryId, teamId, projectId)
      return response
    })
  })

  /** Restores an archived Project of an active Team. */
  routeApp.patch('/api/teams/:teamId/projects/:projectId/restore', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) => {
      const teamId = readRouteIdentifier(c, 'teamId')
      const projectId = readRouteIdentifier(c, 'projectId')
      const response = await workspaceDependencies.projectDirectory.restoreProject(
        principal.directoryId,
        teamId,
        projectId,
        createApiMutationContext(c, principal, { teamId, projectId }),
      )
      await projectProjectSearchDocument(principal.directoryId, teamId, projectId)
      return response
    })
  })
}

/** Authenticated principal passed to a directory administration handler. */
type DirectoryAdministrationPrincipal = Awaited<ReturnType<typeof authenticateWorkspacePrincipal>>

/**
 * Authenticates a Workspace administrator, runs the handler, and maps failures to responses.
 *
 * @param c - Hono request context.
 * @param handler - Work to run for the authenticated administrator.
 * @returns The JSON response.
 */
async function handleDirectoryAdministration(
  c: Context,
  handler: (principal: DirectoryAdministrationPrincipal) => Promise<object>,
) {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceAdministration(principal)
    return c.json(await handler(principal))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
}

/**
 * Reads a required, trimmed route parameter.
 *
 * @param c - Hono request context.
 * @param name - Route parameter name.
 * @returns The parameter value.
 */
function readRouteIdentifier(c: Context, name: 'teamId' | 'projectId') {
  const value = c.req.param(name)?.trim()

  if (!value) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', `${name} is required.`)
  }

  return value
}

/**
 * Re-projects a Team search document after its names became visible or changed.
 *
 * @param workspaceId - Workspace that owns the Team.
 * @param teamId - Team identifier.
 * @param nameJa - Japanese display name.
 * @param nameEn - English display name.
 * @param operation - Operation label used when logging a projection failure.
 */
async function projectTeamSearchDocument(
  workspaceId: string,
  teamId: string,
  nameJa: string,
  nameEn: string,
  operation: string,
) {
  await projectWorkspaceSearchDocumentBestEffort(
    () => createTeamWorkspaceSearchDocument({
      workspaceId,
      teamId,
      title: nameJa,
      ...(nameEn === nameJa ? {} : { subtitle: nameEn }),
    }),
    operation,
    // The Team row does not record its creator, so the creator projected at creation is kept.
    { preserveCreator: true },
  )
}

/**
 * Re-projects a restored Team's search document. The restore is already committed, so a failed
 * read of the Team's names is logged instead of failing the request.
 *
 * @param workspaceId - Workspace that owns the Team.
 * @param teamId - Restored Team identifier.
 */
async function projectRestoredTeamSearchDocument(workspaceId: string, teamId: string) {
  try {
    const team = (await workspaceDependencies.projectDirectory.getDirectoryAdministration(
      workspaceId,
    )).teams.find((candidate) => candidate.id === teamId)
    if (team) {
      await projectTeamSearchDocument(workspaceId, teamId, team.nameJa, team.nameEn, 'team restore')
    }
  } catch (error) {
    console.error('Workspace search projection failed after team restore.', error)
  }
}

/**
 * Re-projects a Project search document with its current names and charter.
 *
 * @param workspaceId - Workspace that owns the Project.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 */
async function projectProjectSearchDocument(
  workspaceId: string,
  teamId: string,
  projectId: string,
) {
  try {
    const state = await workspaceDependencies.projectDirectory.getProjectCharter(
      workspaceId,
      teamId,
      projectId,
    )
    // The rename or restore was just committed, so eventually consistent reads could miss it.
    await projectCharterSearchDocumentBestEffort(workspaceId, state, true)
  } catch (error) {
    console.error('Workspace search projection failed after project rename or restore.', error)
  }
}
