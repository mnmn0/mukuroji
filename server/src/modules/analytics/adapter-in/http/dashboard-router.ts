import { Hono, type Context } from 'hono'

/** Dashboard route が必要とする認証済み principal です。 */
export type DashboardPrincipal = {
  /** Canonical Workspace ID です。 */
  directoryId: string
  /** Canonical Workspace member key です。 */
  userKey: string
  /** System administrator かどうかです。 */
  isSystemAdmin: boolean
}

/** Dashboard summary の current ACL context です。 */
export type DashboardSummaryAccess<ProjectAccess> = {
  /** Current Workspace member key です。 */
  userKey: string
  /** System administrator かどうかです。 */
  isSystemAdmin: boolean
  /** System administrator 以外に許可された Project access 一覧です。 */
  projectAccesses?: ProjectAccess[]
}

/** Dashboard HTTP adapter に注入する application 境界です。 */
export type DashboardRouterDependencies<
  Principal extends DashboardPrincipal,
  ProjectAccess,
  Summary extends object,
> = {
  /** Bearer token を current Workspace principal へ解決します。 */
  authenticate(accessToken: string, context: Context): Promise<Principal>
  /** Current principal の有効な Project access 一覧を返します。 */
  getProjectAccesses(principal: Principal): Promise<ProjectAccess[]>
  /** Current ACL を反映した dashboard summary を返します。 */
  getSummary(
    workspaceId: string,
    access: DashboardSummaryAccess<ProjectAccess>,
  ): Promise<Summary>
  /** 認証エラーかどうかを判定します。 */
  isAuthenticationError(error: unknown): boolean
  /** 認証エラーを既存 HTTP response へ変換します。 */
  mapAuthenticationError(context: Context, error: unknown): Response
  /** Project data error を既存 HTTP response へ変換します。 */
  mapProjectDataError(context: Context, error: unknown): Response
}

/** Dashboard summary HTTP route を作成します。 */
export function createDashboardRouter<
  Principal extends DashboardPrincipal,
  ProjectAccess,
  Summary extends object,
>(
  dependencies: DashboardRouterDependencies<Principal, ProjectAccess, Summary>,
) {
  const router = new Hono()

  router.get('/api/dashboard/summary', async (context) => {
    const accessToken = readBearerAccessToken(context)
    if (!accessToken) {
      return context.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await dependencies.authenticate(accessToken, context)
      const projectAccesses = principal.isSystemAdmin
        ? undefined
        : await dependencies.getProjectAccesses(principal)
      return context.json(await dependencies.getSummary(principal.directoryId, {
        userKey: principal.userKey,
        isSystemAdmin: principal.isSystemAdmin,
        ...(projectAccesses ? { projectAccesses } : {}),
      }))
    } catch (error) {
      if (dependencies.isAuthenticationError(error)) {
        return dependencies.mapAuthenticationError(context, error)
      }
      return dependencies.mapProjectDataError(context, error)
    }
  })

  return router
}

function readBearerAccessToken(context: Context) {
  const authorization = context.req.header('Authorization') ?? ''
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]
}
