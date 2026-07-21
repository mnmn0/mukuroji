import { Hono, type Context } from 'hono'
import type { WorkItemConfiguration } from '@mukuroji/contracts'
import type { WorkItemConfigurationClient } from '../../work-item-configuration'

/** Work Item configuration adapter が必要とする principal の最小境界です。 */
export type WorkItemConfigurationPrincipal = {
  /** 認証・認可済み Workspace の directory ID です。 */
  directoryId: string
}

/** Work Item configuration の scope を検証する入力です。 */
export type WorkItemConfigurationScope = {
  /** configuration が適用される scope 種別です。 */
  scopeType: 'workspace' | 'team'
  /** configuration が適用される Workspace または Team ID です。 */
  scopeId: string
}

/** Work Item configuration HTTP adapter に注入する境界です。 */
export type WorkItemConfigurationRouterDependencies<
  TPrincipal extends WorkItemConfigurationPrincipal = WorkItemConfigurationPrincipal,
> = {
  /** Workspace または Team configuration の application client です。 */
  workItemConfigurations: WorkItemConfigurationClient
  /** Bearer access token を request から取得します。 */
  readBearerAccessToken(context: Context): string | undefined
  /** access token を検証し current Workspace principal を返します。 */
  authenticate(accessToken: string, context: Context): Promise<TPrincipal>
  /** Workspace configuration を変更できる権限を要求します。 */
  requireWorkspaceAdministration(principal: TPrincipal): void
  /** Team configuration を変更できる Workspace write 権限を要求します。 */
  requireWorkspaceBusinessWrite(principal: TPrincipal): void
  /** Team scope の read/write 権限を要求します。 */
  requireTeamPermission(
    principal: TPrincipal,
    teamId: string,
    minimum: 'viewer' | 'manager',
  ): Promise<void>
  /** Team configuration の管理権限を要求します。 */
  requireTeamConfigurationAdministration(principal: TPrincipal, teamId: string): Promise<void>
  /** Request JSON を安全に parse します。 */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
  /** Scope を上書きし、configuration を厳格に検証します。 */
  validateConfiguration(value: unknown, expectedScope: WorkItemConfigurationScope): WorkItemConfiguration
  /** 参照される Project、Team、person field を検証します。 */
  validateReferences(
    workspaceId: string,
    configuration: WorkItemConfiguration,
    teamId?: string,
  ): Promise<void>
  /** 既存 Work Item に対する configuration の互換性を検証します。 */
  validateUsage(
    workspaceId: string,
    configuration: WorkItemConfiguration,
    teamId?: string,
  ): Promise<void>
  /** Work Item configuration error を HTTP response に変換します。 */
  mapError(context: Context, error: unknown): Response
}

/** Workspace と Team の Work Item configuration routes を作成します。 */
export function createWorkItemConfigurationRouter<
  TPrincipal extends WorkItemConfigurationPrincipal,
>(dependencies: WorkItemConfigurationRouterDependencies<TPrincipal>) {
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
      const expectedScope = { scopeType: 'workspace' as const, scopeId: principal.directoryId }
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
      const expectedScope = { scopeType: 'team' as const, scopeId: teamId }
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

function withConfigurationScope(
  value: unknown,
  scope: WorkItemConfigurationScope,
) {
  const source = isRecord(value) ? value : {}
  return { ...source, ...scope }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
