import { Hono, type Context } from 'hono'
import type {
  RequestAttachmentUploadInput,
  RequestRequesterReplyInput,
  SubmitRequestInput,
} from '@mukuroji/contracts'
import type {
  RequestExternalContext,
  RequestIntakeClient,
  RequestLinkResolution,
} from '../../request-intake'

/** Public Request Intake HTTP adapter に注入する境界です。 */
export type PublicRequestIntakeRouterDependencies = {
  /** Request Intake application client です。 */
  requestIntake: RequestIntakeClient
  /** Link の access mode と current Workspace を検証します。 */
  authorizeRequestLink(context: Context, resolution: RequestLinkResolution): Promise<void>
  /** Rate limit と idempotency に使う trusted request context を作成します。 */
  createExternalContext(context: Context): RequestExternalContext
  /** Public boundary の error を既存 HTTP response へ変換します。 */
  mapError(context: Context, error: unknown): Response
  /** Request JSON を安全に parse し、失敗時は undefined を返します。 */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
}

/** Public Request Form と requester thread の HTTP routes を作成します。 */
export function createPublicRequestIntakeRouter(
  dependencies: PublicRequestIntakeRouterDependencies,
) {
  const router = new Hono()

  router.get('/api/request-intake/:token', async (context) => {
    try {
      const resolution = await resolveAuthorizedLink(context, dependencies)
      return context.json(await dependencies.requestIntake.getPublicForm(
        resolution,
        dependencies.createExternalContext(context),
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/request-intake/:token/uploads', async (context) => {
    try {
      const resolution = await resolveAuthorizedLink(context, dependencies)
      const body = await dependencies.readJson(context.req) as
        | RequestAttachmentUploadInput
        | undefined
      return context.json(await dependencies.requestIntake.createAttachmentUpload(
        resolution,
        body ?? {} as RequestAttachmentUploadInput,
        dependencies.createExternalContext(context),
      ), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/request-intake/:token/submissions', async (context) => {
    try {
      const resolution = await resolveAuthorizedLink(context, dependencies)
      const body = await dependencies.readJson(context.req) as SubmitRequestInput | undefined
      return context.json(await dependencies.requestIntake.submit(
        resolution,
        body ?? {} as SubmitRequestInput,
        dependencies.createExternalContext(context),
      ), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/request-threads/:threadToken', async (context) => {
    try {
      return context.json(await dependencies.requestIntake.getRequesterThread(
        context.req.param('threadToken'),
        dependencies.createExternalContext(context),
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/request-threads/:threadToken/replies', async (context) => {
    try {
      const body = await dependencies.readJson(context.req) as
        | RequestRequesterReplyInput
        | undefined
      return context.json(await dependencies.requestIntake.replyToThread(
        context.req.param('threadToken'),
        body ?? {} as RequestRequesterReplyInput,
        dependencies.createExternalContext(context),
      ), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  return router
}

async function resolveAuthorizedLink(
  context: Context,
  dependencies: PublicRequestIntakeRouterDependencies,
) {
  const resolution = await dependencies.requestIntake.resolveLink(
    context.req.param('token') ?? '',
  )
  await dependencies.authorizeRequestLink(context, resolution)
  return resolution
}
