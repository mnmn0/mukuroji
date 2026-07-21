import { Hono, type Context } from 'hono'
import type {
  CreateRequestFormInput,
  PublishRequestFormInput,
  RequestFormDraft,
  RequestSubmissionStatus,
  UpdateRequestFormInput,
} from '@mukuroji/contracts'
import {
  RequestIntakeError,
  type RequestIntakeClient,
} from '../../request-intake'

/** Request Intake admin route に必要な Workspace principal の最小境界です。 */
export type RequestIntakeAdministrator = {
  /** 認証・認可済み Workspace の directory ID です。 */
  directoryId: string
  /** 変更を行う認証済み actor の安定 ID です。 */
  userKey: string
}

/** 管理者向け Request Intake HTTP adapter に注入する境界です。 */
export type AdminRequestIntakeRouterDependencies = {
  /** Request Intake application client です。 */
  requestIntake: RequestIntakeClient
  /** Bearer token を検証し、Workspace administration を確認します。 */
  requireAdministration(context: Context): Promise<RequestIntakeAdministrator>
  /** Request JSON を安全に parse し、失敗時は undefined を返します。 */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
  /** Form publish 前に routing の参照先を検証します。 */
  validateFormRoutingReferences(workspaceId: string, draft: RequestFormDraft): Promise<void>
  /** Queue status query を検証します。 */
  readSubmissionStatus(value: string | undefined): RequestSubmissionStatus | undefined
  /** Queue limit query を検証します。 */
  readQueueLimit(value: string | undefined): number | undefined
  /** Request Intake error を既存 HTTP response へ変換します。 */
  mapError(context: Context, error: unknown): Response
}

/** 管理者向け Request Form、queue、submission access の HTTP routes を作成します。 */
export function createAdminRequestIntakeRouter(
  dependencies: AdminRequestIntakeRouterDependencies,
) {
  const router = new Hono()

  router.get('/api/request-forms', async (context) => {
    try {
      const principal = await dependencies.requireAdministration(context)
      return context.json(await dependencies.requestIntake.listForms(principal.directoryId))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/request-forms', async (context) => {
    try {
      const principal = await dependencies.requireAdministration(context)
      const body = await dependencies.readJson(context.req) as CreateRequestFormInput | undefined
      return context.json(await dependencies.requestIntake.createForm(
        principal.directoryId,
        { id: principal.userKey },
        body ?? {} as CreateRequestFormInput,
      ), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/request-forms/:formId', async (context) => {
    try {
      const principal = await dependencies.requireAdministration(context)
      return context.json(await dependencies.requestIntake.getForm(
        principal.directoryId,
        context.req.param('formId') ?? '',
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.put('/api/request-forms/:formId', async (context) => {
    try {
      const principal = await dependencies.requireAdministration(context)
      const body = await dependencies.readJson(context.req) as UpdateRequestFormInput | undefined
      return context.json(await dependencies.requestIntake.updateForm(
        principal.directoryId,
        context.req.param('formId') ?? '',
        { id: principal.userKey },
        body ?? {} as UpdateRequestFormInput,
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/request-forms/:formId/publish', async (context) => {
    try {
      const principal = await dependencies.requireAdministration(context)
      const formId = context.req.param('formId') ?? ''
      const body = await dependencies.readJson(context.req) as PublishRequestFormInput | undefined
      const publishInput = body ?? {} as PublishRequestFormInput
      const current = await dependencies.requestIntake.getForm(principal.directoryId, formId)
      if (
        !Number.isSafeInteger(publishInput.expectedRevision) ||
        publishInput.expectedRevision !== current.revision
      ) {
        throw new RequestIntakeError(
          409,
          'RequestRevisionConflict',
          'Request resource revision changed.',
        )
      }
      await dependencies.validateFormRoutingReferences(principal.directoryId, current.draft)
      return context.json(await dependencies.requestIntake.publishForm(
        principal.directoryId,
        formId,
        { id: principal.userKey },
        publishInput,
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/request-queue', async (context) => {
    try {
      const principal = await dependencies.requireAdministration(context)
      return context.json(await dependencies.requestIntake.listSubmissions(principal.directoryId, {
        status: dependencies.readSubmissionStatus(context.req.query('status')),
        limit: dependencies.readQueueLimit(context.req.query('limit')),
        cursor: context.req.query('cursor'),
      }))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/request-submissions/:submissionId', async (context) => {
    try {
      const principal = await dependencies.requireAdministration(context)
      return context.json(await dependencies.requestIntake.getSubmission(
        principal.directoryId,
        context.req.param('submissionId') ?? '',
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/request-submissions/:submissionId/attachments/:attachmentId/access', async (context) => {
    try {
      const principal = await dependencies.requireAdministration(context)
      return context.json(await dependencies.requestIntake.createAttachmentAccess(
        principal.directoryId,
        context.req.param('submissionId') ?? '',
        context.req.param('attachmentId') ?? '',
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  return router
}
