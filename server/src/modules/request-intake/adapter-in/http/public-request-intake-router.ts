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

/** Dependencies required by the public Request Intake HTTP adapter. */
export type PublicRequestIntakeRouterDependencies = {
  /** Request Intake application client. */
  requestIntake: RequestIntakeClient
  /** Validates the link access mode and current Workspace. */
  authorizeRequestLink(context: Context, resolution: RequestLinkResolution): Promise<void>
  /** Creates trusted request context for rate limiting and idempotency. */
  createExternalContext(context: Context): RequestExternalContext
  /** Maps public-boundary errors to the existing HTTP response contract. */
  mapError(context: Context, error: unknown): Response
  /** Safely parses request JSON and returns undefined when parsing fails. */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
}

/**
 * Creates Hono routes for public Request Forms and requester threads.
 *
 * @param dependencies Application and transport callbacks required by the routes.
 * @returns A Hono router containing the public Request Intake endpoints.
 */
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

/** Validates and normalizes a direct attachment upload request body. */
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

/** Validates and normalizes a public Request Form submission body. */
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

/** Validates and normalizes a requester thread reply body. */
function parseRequestRequesterReplyInput(value: unknown): RequestRequesterReplyInput {
  const body = requireRequestRecord(value, 'Requester reply')
  return {
    body: requireRequestText(body.body, 'Requester reply body', 20_000),
  }
}

/** Validates the typed answer map submitted for a Request Form. */
function parseRequestAnswers(value: unknown): Record<string, RequestAnswerValue> {
  const answers = requireRequestRecord(value, 'Request answers')
  return Object.fromEntries(Object.entries(answers).map(([fieldId, answer]) => [
    fieldId,
    parseRequestAnswerValue(answer, fieldId),
  ]))
}

/** Validates one Request Form answer value. */
function parseRequestAnswerValue(value: unknown, fieldId: string): RequestAnswerValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')) {
    return value
  }
  throw invalidRequestInput(`Request answer "${fieldId}" is invalid.`)
}

/** Requires a JSON object and reports a stable Request Intake input error otherwise. */
function requireRequestRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRequestRecord(value)) {
    throw invalidRequestInput(`${label} must be an object.`)
  }
  return value
}

/** Returns whether a value is a non-array JSON object. */
function isRequestRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validates a string-valued JSON object such as attachment claims. */
function requireRequestStringRecord(value: unknown, label: string): Record<string, string> {
  const record = requireRequestRecord(value, label)
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [
    key,
    requireRequestText(entry, `${label} value`, 256),
  ]))
}

/** Requires a non-empty bounded string and trims surrounding whitespace. */
function requireRequestText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw invalidRequestInput(`${label} is invalid.`)
  }
  return value.trim()
}

/** Requires a bounded string while allowing an empty value. */
function requireOptionalRequestText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw invalidRequestInput(`${label} is invalid.`)
  }
  return value.trim()
}

/** Requires a non-negative safe integer. */
function requireRequestInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidRequestInput(`${label} is invalid.`)
  }
  return value
}

/** Requires a boolean value. */
function requireRequestBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidRequestInput(`${label} must be boolean.`)
  return value
}

/** Requires a supported Request Form locale. */
function requireRequestLocale(value: unknown): RequestLocale {
  if (value === 'ja' || value === 'en') return value
  throw invalidRequestInput('Request locale is invalid.')
}

/** Creates the stable error used for malformed public Request Intake input. */
function invalidRequestInput(message: string): RequestIntakeError {
  return new RequestIntakeError(400, 'InvalidRequestIntakeInput', message)
}

/** Resolves and authorizes the capability link used by public form routes. */
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
