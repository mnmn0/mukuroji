import { Hono, type Context } from 'hono'
import type { WorkItemConfiguration } from '@mukuroji/contracts'
import type { WorkItemConfigurationClient } from '../../work-item-configuration'

/** The minimum principal boundary required by the Work Item configuration adapter. */
export type WorkItemConfigurationPrincipal = {
  /** The directory ID of the authenticated and authorized Workspace. */
  directoryId: string
}

/** The scope that a Work Item configuration is expected to serve. */
export type WorkItemConfigurationScope = {
  /** The type of scope where the configuration is applied. */
  scopeType: 'workspace' | 'team'
  /** The Workspace or Team ID where the configuration is applied. */
  scopeId: string
}

/** Dependencies injected into the Work Item configuration HTTP adapter. */
export type WorkItemConfigurationRouterDependencies<
  TPrincipal extends WorkItemConfigurationPrincipal = WorkItemConfigurationPrincipal,
> = {
  /** The application client for Workspace and Team configurations. */
  workItemConfigurations: WorkItemConfigurationClient
  /** Reads the bearer access token from a request context. */
  readBearerAccessToken(context: Context): string | undefined
  /** Verifies an access token and returns the current Workspace principal. */
  authenticate(accessToken: string, context: Context): Promise<TPrincipal>
  /** Requires permission to change the Workspace configuration. */
  requireWorkspaceAdministration(principal: TPrincipal): void
  /** Requires Workspace business-write permission for a Team configuration change. */
  requireWorkspaceBusinessWrite(principal: TPrincipal): void
  /** Requires read or write permission for a Team scope. */
  requireTeamPermission(
    principal: TPrincipal,
    teamId: string,
    minimum: 'viewer' | 'manager',
  ): Promise<void>
  /** Requires administration permission for a Team configuration. */
  requireTeamConfigurationAdministration(principal: TPrincipal, teamId: string): Promise<void>
  /** Safely parses request JSON. */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
  /** Validates a configuration against the expected scope. */
  validateConfiguration(value: unknown, expectedScope: WorkItemConfigurationScope): WorkItemConfiguration
  /** Validates referenced Projects, Teams, and person fields. */
  validateReferences(
    workspaceId: string,
    configuration: WorkItemConfiguration,
    teamId?: string,
  ): Promise<void>
  /** Validates compatibility with existing Work Items. */
  validateUsage(
    workspaceId: string,
    configuration: WorkItemConfiguration,
    teamId?: string,
  ): Promise<void>
  /** Converts a Work Item configuration error into an HTTP response. */
  mapError(context: Context, error: unknown): Response
}

/** Creates Workspace and Team Work Item configuration routes.
 *
 * @param dependencies The application services and authorization functions used by the routes.
 * @returns A Hono router containing the Work Item configuration routes.
 */
export function createWorkItemConfigurationRouter<
  TPrincipal extends WorkItemConfigurationPrincipal,
>(dependencies: WorkItemConfigurationRouterDependencies<TPrincipal>): Hono {
  const router = new Hono()

  router.get('/api/work-item-configuration', async (context) => {
    const accessToken = dependencies.readBearerAccessToken(context)
    if (!accessToken) {
      return context.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await dependencies.authenticate(accessToken, context)
      return context.json(await dependencies.workItemConfigurations.getWorkspaceConfiguration(
        principal.directoryId,
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.put('/api/work-item-configuration', async (context) => {
    const accessToken = dependencies.readBearerAccessToken(context)
    if (!accessToken) {
      return context.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await dependencies.authenticate(accessToken, context)
      dependencies.requireWorkspaceAdministration(principal)
      const body = await dependencies.readJson(context.req)
      const expectedScope: WorkItemConfigurationScope = {
        scopeType: 'workspace',
        scopeId: principal.directoryId,
      }
      const configuration = dependencies.validateConfiguration(
        withConfigurationScope(body, expectedScope),
        expectedScope,
      )
      return context.json(await dependencies.workItemConfigurations.saveWorkspaceConfiguration(
        principal.directoryId,
        configuration,
        async () => {
          await dependencies.validateReferences(principal.directoryId, configuration)
          await dependencies.validateUsage(principal.directoryId, configuration)
        },
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/teams/:teamId/work-item-configuration', async (context) => {
    const accessToken = dependencies.readBearerAccessToken(context)
    const teamId = context.req.param('teamId') ?? ''
    if (!accessToken) {
      return context.json({ message: 'Bearer token is required.' }, 401)
    }
    if (!teamId) {
      return context.json({ message: 'Team ID is required.' }, 400)
    }

    try {
      const principal = await dependencies.authenticate(accessToken, context)
      await dependencies.requireTeamPermission(principal, teamId, 'viewer')
      return context.json(await dependencies.workItemConfigurations.getTeamConfiguration(
        principal.directoryId,
        teamId,
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.put('/api/teams/:teamId/work-item-configuration', async (context) => {
    const accessToken = dependencies.readBearerAccessToken(context)
    const teamId = context.req.param('teamId') ?? ''
    if (!accessToken) {
      return context.json({ message: 'Bearer token is required.' }, 401)
    }
    if (!teamId) {
      return context.json({ message: 'Team ID is required.' }, 400)
    }

    try {
      const principal = await dependencies.authenticate(accessToken, context)
      dependencies.requireWorkspaceBusinessWrite(principal)
      await dependencies.requireTeamConfigurationAdministration(principal, teamId)
      const body = await dependencies.readJson(context.req)
      const expectedScope: WorkItemConfigurationScope = {
        scopeType: 'team',
        scopeId: teamId,
      }
      const configuration = dependencies.validateConfiguration(
        withConfigurationScope(body, expectedScope),
        expectedScope,
      )
      return context.json(await dependencies.workItemConfigurations.saveTeamConfiguration(
        principal.directoryId,
        teamId,
        configuration,
        async () => {
          await dependencies.validateReferences(principal.directoryId, configuration, teamId)
          await dependencies.validateUsage(principal.directoryId, configuration, teamId)
        },
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  return router
}

/** Replaces client-supplied scope fields with the scope selected by the request path.
 *
 * @param value The untrusted request body.
 * @param scope The scope required by the request path.
 * @returns A record normalized to the request path scope.
 */
function withConfigurationScope(
  value: unknown,
  scope: WorkItemConfigurationScope,
): Record<string, unknown> {
  const source = isRecord(value) ? value : {}
  return { ...source, ...scope }
}

/** Determines whether an unknown value is a non-array object record.
 *
 * @param value The value to inspect.
 * @returns Whether the value can be safely treated as a string-keyed record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
