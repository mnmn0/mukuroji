import { Hono, type Context } from 'hono'
import type {
  RequestAttachmentUploadInput,
  RequestAnswerValue,
  RequestRequesterReplyInput,
  RequestLocale,
  SubmitRequestInput,
} from '@mukuroji/contracts'
import {
  RequestIntakeError,
  type RequestExternalContext,
  type RequestIntakeClient,
  type RequestLinkResolution,
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
      const body = parseRequestAttachmentUploadInput(await dependencies.readJson(context.req))
      return context.json(await dependencies.requestIntake.createAttachmentUpload(
        resolution,
        body,
        dependencies.createExternalContext(context),
      ), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/request-intake/:token/submissions', async (context) => {
    try {
      const resolution = await resolveAuthorizedLink(context, dependencies)
      const body = parseSubmitRequestInput(await dependencies.readJson(context.req))
      return context.json(await dependencies.requestIntake.submit(
        resolution,
        body,
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
      const body = parseRequestRequesterReplyInput(await dependencies.readJson(context.req))
      return context.json(await dependencies.requestIntake.replyToThread(
        context.req.param('threadToken'),
        body,
        dependencies.createExternalContext(context),
      ), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  return router
}

function parseRequestAttachmentUploadInput(value: unknown): RequestAttachmentUploadInput {
  const body = requireRequestRecord(value, 'Request attachment upload')
  return {
    sessionToken: requireRequestText(body.sessionToken, 'Submission session token', 256),
    fieldId: requireRequestText(body.fieldId, 'Attachment field ID', 160),
    fileName: requireRequestText(body.fileName, 'Attachment file name', 255),
    contentType: requireRequestText(body.contentType, 'Attachment content type', 200),
    sizeBytes: requireRequestInteger(body.sizeBytes, 'Attachment size'),
  }
}

function parseSubmitRequestInput(value: unknown): SubmitRequestInput {
  const body = requireRequestRecord(value, 'Request submission')
  const attachmentClaims = body.attachmentClaims === undefined
    ? undefined
    : requireRequestStringRecord(body.attachmentClaims, 'Attachment claims')
  const consentAccepted = body.consentAccepted === undefined
    ? undefined
    : requireRequestBoolean(body.consentAccepted, 'Consent state')
  const honeypot = body.honeypot === undefined
    ? undefined
    : requireOptionalRequestText(body.honeypot, 'Honeypot', 20_000)

  return {
    sessionToken: requireRequestText(body.sessionToken, 'Submission session token', 256),
    locale: requireRequestLocale(body.locale),
    answers: parseRequestAnswers(body.answers),
    ...(attachmentClaims === undefined ? {} : { attachmentClaims }),
    ...(consentAccepted === undefined ? {} : { consentAccepted }),
    ...(honeypot === undefined ? {} : { honeypot }),
  }
}

function parseRequestRequesterReplyInput(value: unknown): RequestRequesterReplyInput {
  const body = requireRequestRecord(value, 'Requester reply')
  return {
    body: requireRequestText(body.body, 'Requester reply body', 20_000),
  }
}

function parseRequestAnswers(value: unknown): Record<string, RequestAnswerValue> {
  const answers = requireRequestRecord(value, 'Request answers')
  return Object.fromEntries(Object.entries(answers).map(([fieldId, answer]) => [
    fieldId,
    parseRequestAnswerValue(answer, fieldId),
  ]))
}

function parseRequestAnswerValue(value: unknown, fieldId: string): RequestAnswerValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')) {
    return value
  }
  throw invalidRequestInput(`Request answer "${fieldId}" is invalid.`)
}

function requireRequestRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRequestRecord(value)) {
    throw invalidRequestInput(`${label} must be an object.`)
  }
  return value
}

function isRequestRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRequestStringRecord(value: unknown, label: string): Record<string, string> {
  const record = requireRequestRecord(value, label)
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [
    key,
    requireRequestText(entry, `${label} value`, 256),
  ]))
}

function requireRequestText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw invalidRequestInput(`${label} is invalid.`)
  }
  return value.trim()
}

function requireOptionalRequestText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw invalidRequestInput(`${label} is invalid.`)
  }
  return value.trim()
}

function requireRequestInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidRequestInput(`${label} is invalid.`)
  }
  return value
}

function requireRequestBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidRequestInput(`${label} must be boolean.`)
  return value
}

function requireRequestLocale(value: unknown): RequestLocale {
  if (value === 'ja' || value === 'en') return value
  throw invalidRequestInput('Request locale is invalid.')
}

function invalidRequestInput(message: string): RequestIntakeError {
  return new RequestIntakeError(400, 'InvalidRequestIntakeInput', message)
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
