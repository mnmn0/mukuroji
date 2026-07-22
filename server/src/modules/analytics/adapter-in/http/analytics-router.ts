import { Hono, type Context } from 'hono'

/** The authenticated Workspace identity required by Analytics application operations. */
export type AnalyticsPrincipal = {
  /** The canonical Workspace identifier. */
  directoryId: string
  /** The canonical Workspace member key. */
  userKey: string
}

/** The generated file returned by an Analytics export operation. */
export type AnalyticsExportFile = {
  /** The response body containing CSV text or PDF bytes. */
  body: BodyInit
  /** The file extension advertised in the download name. */
  extension: 'csv' | 'pdf'
  /** The media type advertised for the generated file. */
  contentType: 'text/csv; charset=utf-8' | 'application/pdf'
}

/** Application operations exposed to the Analytics HTTP adapter. */
export type AnalyticsRouterDependencies<
  Principal extends AnalyticsPrincipal,
> = {
  /** Reads the bearer access token from the request context. */
  readBearerAccessToken(context: Context): string | undefined
  /** Resolves an access token to the current Workspace principal. */
  authenticate(accessToken: string, context: Context): Promise<Principal>
  /** Parses and validates an Analytics JSON object request body. */
  readJson(context: Context): Promise<Record<string, unknown>>
  /** Executes an ad-hoc or saved Analytics query under the current ACL. */
  executeQuery(principal: Principal, input: Record<string, unknown>): Promise<object>
  /** Executes an Analytics evidence query under the current ACL. */
  executeEvidence(principal: Principal, input: Record<string, unknown>): Promise<object>
  /** Generates a downloadable Analytics export under the current ACL. */
  createExport(principal: Principal, input: Record<string, unknown>): Promise<AnalyticsExportFile>
  /** Lists the Analytics reports visible to the current principal. */
  listReports(
    principal: Principal,
    limit: string | undefined,
    cursor: string | undefined,
  ): Promise<object>
  /** Creates an Analytics report visible under the requested policy. */
  createReport(principal: Principal, input: Record<string, unknown>): Promise<object>
  /** Updates an Analytics report after authorization and revision checks. */
  updateReport(
    principal: Principal,
    reportId: string,
    input: Record<string, unknown>,
  ): Promise<object>
  /** Deletes an Analytics report after authorization and revision checks. */
  deleteReport(
    principal: Principal,
    reportId: string,
    input: Record<string, unknown>,
  ): Promise<void>
  /** Lists immutable report snapshots that remain visible under the current ACL. */
  listSnapshots(
    principal: Principal,
    reportId: string,
    cursor: string | undefined,
  ): Promise<object>
  /** Creates an immutable report snapshot under the current ACL. */
  createSnapshot(
    principal: Principal,
    reportId: string,
    input: Record<string, unknown>,
    idempotencyKey: string | undefined,
  ): Promise<object>
  /** Maps authentication, validation, authorization, and application failures to HTTP. */
  mapError(context: Context, error: unknown): Response
}

/**
 * Creates the Analytics query, report, snapshot, evidence, and export HTTP routes.
 *
 * @param dependencies Authenticated Analytics application operations.
 * @returns A Hono router containing the Analytics HTTP transport.
 */
export function createAnalyticsRouter<Principal extends AnalyticsPrincipal>(
  dependencies: AnalyticsRouterDependencies<Principal>,
): Hono {
  const router = new Hono()

  /** Executes an authenticated ad-hoc or saved Analytics query. */
  async function handleQuery(context: Context) {
    const access = await authenticateRequest(context, dependencies)
    if (access instanceof Response) return access

    try {
      const input = await dependencies.readJson(context)
      return context.json({
        snapshot: await dependencies.executeQuery(access, input),
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  }

  router.post('/api/analytics/query', handleQuery)

  /** Returns an authenticated evidence page for an Analytics metric. */
  async function handleEvidence(context: Context) {
    const access = await authenticateRequest(context, dependencies)
    if (access instanceof Response) return access

    try {
      const input = await dependencies.readJson(context)
      return context.json(await dependencies.executeEvidence(access, input))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  }

  router.post('/api/analytics/evidence', handleEvidence)

  /** Generates an authenticated CSV or PDF Analytics download. */
  async function handleExport(context: Context) {
    const access = await authenticateRequest(context, dependencies)
    if (access instanceof Response) return access

    try {
      const input = await dependencies.readJson(context)
      const file = await dependencies.createExport(access, input)
      return new Response(file.body, {
        status: 200,
        headers: {
          'Cache-Control': 'private, no-store',
          'Content-Disposition':
            `attachment; filename="mukuroji-analytics.${file.extension}"`,
          'Content-Type': file.contentType,
        },
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  }

  router.post('/api/analytics/export', handleExport)

  /** Lists Analytics reports visible to the authenticated principal. */
  async function handleListReports(context: Context) {
    const access = await authenticateRequest(context, dependencies)
    if (access instanceof Response) return access

    try {
      return context.json(await dependencies.listReports(
        access,
        context.req.query('limit'),
        context.req.query('cursor'),
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  }

  router.get('/api/analytics/reports', handleListReports)

  /** Creates an Analytics report for the authenticated principal. */
  async function handleCreateReport(context: Context) {
    const access = await authenticateRequest(context, dependencies)
    if (access instanceof Response) return access

    try {
      const input = await dependencies.readJson(context)
      return context.json({
        report: await dependencies.createReport(access, input),
      }, 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  }

  router.post('/api/analytics/reports', handleCreateReport)

  /** Updates an authorized Analytics report at its current revision. */
  async function handleUpdateReport(context: Context) {
    const access = await authenticateRequest(context, dependencies)
    if (access instanceof Response) return access

    try {
      const input = await dependencies.readJson(context)
      return context.json({
        report: await dependencies.updateReport(
          access,
          context.req.param('reportId') ?? '',
          input,
        ),
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  }

  router.patch('/api/analytics/reports/:reportId', handleUpdateReport)

  /** Deletes an authorized Analytics report at its expected revision. */
  async function handleDeleteReport(context: Context) {
    const access = await authenticateRequest(context, dependencies)
    if (access instanceof Response) return access

    try {
      const input = await dependencies.readJson(context)
      await dependencies.deleteReport(
        access,
        context.req.param('reportId') ?? '',
        input,
      )
      return context.json({ deleted: true })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  }

  router.delete('/api/analytics/reports/:reportId', handleDeleteReport)

  /** Lists report snapshots that remain visible under the current ACL. */
  async function handleListSnapshots(context: Context) {
    const access = await authenticateRequest(context, dependencies)
    if (access instanceof Response) return access

    try {
      return context.json(await dependencies.listSnapshots(
        access,
        context.req.param('reportId') ?? '',
        context.req.query('cursor'),
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  }

  router.get('/api/analytics/reports/:reportId/snapshots', handleListSnapshots)

  /** Creates an idempotent immutable snapshot for an authorized report. */
  async function handleCreateSnapshot(context: Context) {
    const access = await authenticateRequest(context, dependencies)
    if (access instanceof Response) return access

    try {
      const input = await dependencies.readJson(context)
      return context.json({
        snapshotRecord: await dependencies.createSnapshot(
          access,
          context.req.param('reportId') ?? '',
          input,
          context.req.header('Idempotency-Key'),
        ),
      }, 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  }

  router.post('/api/analytics/reports/:reportId/snapshots', handleCreateSnapshot)

  return router
}

/**
 * Authenticates a protected Analytics request while preserving the stable missing-token response.
 *
 * @param context The current Hono request context.
 * @param dependencies The injected Analytics router dependencies.
 * @returns The authenticated principal or an HTTP error response.
 */
async function authenticateRequest<Principal extends AnalyticsPrincipal>(
  context: Context,
  dependencies: AnalyticsRouterDependencies<Principal>,
): Promise<Principal | Response> {
  const accessToken = dependencies.readBearerAccessToken(context)
  if (!accessToken) {
    return context.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    return await dependencies.authenticate(accessToken, context)
  } catch (error) {
    return dependencies.mapError(context, error)
  }
}
