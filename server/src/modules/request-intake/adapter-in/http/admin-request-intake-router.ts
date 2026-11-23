import { Hono, type Context } from 'hono'
import type { RequestIntakeTransactionItems } from '../../request-intake'
import type {
  CreateRequestFormInput,
  PublishRequestFormInput,
  RequestForm,
  RequestFormAccessMode,
  RequestFormDraft,
  RequestFormScope,
  RequestSubmissionStatus,
  UpdateRequestFormInput,
} from '@mukuroji/contracts'
import {
  RequestIntakeError,
  validateRequestFormDraft,
  type RequestSubmissionListOptions,
} from '../../request-intake'

/** The authenticated Workspace principal required by the admin Request Intake routes. */
export type RequestIntakeAdministrator = {
  /** The directory ID of the authenticated and authorized Workspace. */
  directoryId: string
  /** The stable ID of the authenticated actor performing a mutation. */
  userKey: string
}

/** A principal who manages Request forms of the whole Workspace or of some Teams. */
export type RequestFormManager = RequestIntakeAdministrator & {
  /** Whether the principal manages Workspace forms and every Team's forms. */
  workspace: boolean
  /** Teams whose Team-scoped forms the principal manages. */
  teamIds: readonly string[]
}

/** The subset of the Request Intake client used by the admin HTTP adapter. */
export type AdminRequestIntakeClient = {
  /** Lists forms in a Workspace.
   *
   * @param workspaceId The Workspace directory ID.
   * @returns The form list response.
   */
  listForms(workspaceId: string): Promise<{ forms: RequestForm[] }>
  /** Reads a form in a Workspace.
   *
   * @param workspaceId The Workspace directory ID.
   * @param formId The form ID.
   * @returns The form view.
   */
  getForm(workspaceId: string, formId: string): Promise<RequestForm>
  /** Creates a form in a Workspace.
   *
   * @param workspaceId The Workspace directory ID.
   * @param actor The authenticated mutation actor.
   * @param input The validated create-form input.
   * @returns The created form response.
   */
  createForm(
    workspaceId: string,
    actor: { id: string },
    input: CreateRequestFormInput,
  ): Promise<unknown>
  /** Updates a form in a Workspace.
   *
   * @param workspaceId The Workspace directory ID.
   * @param formId The form ID.
   * @param actor The authenticated mutation actor.
   * @param input The validated update-form input.
   * @returns The updated form response.
   */
  updateForm(
    workspaceId: string,
    formId: string,
    actor: { id: string },
    input: UpdateRequestFormInput,
  ): Promise<unknown>
  /** Publishes the current draft of a form.
   *
   * @param workspaceId The Workspace directory ID.
   * @param formId The form ID.
   * @param actor The authenticated mutation actor.
   * @param input The validated publish-form input.
   * @returns The published form response.
   */
  publishForm(
    workspaceId: string,
    formId: string,
    actor: { id: string },
    input: PublishRequestFormInput,
    additionalTransactionItems?: RequestIntakeTransactionItems,
  ): Promise<unknown>
  /** Lists submissions in a Workspace.
   *
   * @param workspaceId The Workspace directory ID.
   * @param options The validated queue filters.
   * @returns The submission page response.
   */
  listSubmissions(workspaceId: string, options?: RequestSubmissionListOptions): Promise<unknown>
  /** Reads a submission in a Workspace.
   *
   * @param workspaceId The Workspace directory ID.
   * @param submissionId The submission ID.
   * @returns The submission response.
   */
  getSubmission(workspaceId: string, submissionId: string): Promise<unknown>
  /** Creates a short-lived attachment access URL.
   *
   * @param workspaceId The Workspace directory ID.
   * @param submissionId The submission ID.
   * @param attachmentId The attachment ID.
   * @returns The short-lived access response.
   */
  createAttachmentAccess(
    workspaceId: string,
    submissionId: string,
    attachmentId: string,
  ): Promise<unknown>
}

/** Dependencies injected into the admin Request Intake HTTP adapter. */
export type AdminRequestIntakeRouterDependencies = {
  /** Returns the Request Intake application client bound to the current request. */
  getRequestIntake(): AdminRequestIntakeClient
  /** Verifies the bearer token and confirms Workspace administration access.
   *
   * @param context The Hono request context.
   * @returns The authenticated administrator principal.
   */
  requireAdministration(context: Context): Promise<RequestIntakeAdministrator>
  /** Verifies the bearer token and resolves which form scopes the caller manages.
   *
   * @param context The Hono request context.
   * @returns The form manager, who manages the Workspace or at least one Team.
   */
  requireFormManagement(context: Context): Promise<RequestFormManager>
  /** Safely parses request JSON, returning undefined when parsing fails.
   *
   * @param request The request object to parse.
   * @returns The untrusted parsed JSON value, or undefined on parse failure.
   */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
  /** Validates routing references before publishing a form.
   *
   * @param workspaceId The Workspace directory ID.
   * @param draft The current form draft.
   * @returns Atomic configuration guards, or undefined when the caller does not provide them.
   */
  validateFormRoutingReferences(
    workspaceId: string,
    draft: RequestFormDraft,
  ): Promise<RequestIntakeTransactionItems | void>
  /** Validates the queue status query parameter.
   *
   * @param value The raw query parameter.
   * @returns The normalized status, or undefined when absent.
   */
  readSubmissionStatus(value: string | undefined): RequestSubmissionStatus | undefined
  /** Validates the queue limit query parameter.
   *
   * @param value The raw query parameter.
   * @returns The normalized limit, or undefined when absent.
   */
  readQueueLimit(value: string | undefined): number | undefined
  /** Converts a Request Intake error into the existing HTTP response shape.
   *
   * @param context The Hono request context.
   * @param error The caught error value.
   * @returns The mapped HTTP response.
   */
  mapError(context: Context, error: unknown): Response
}

/** Tests whether a form manager manages a form scope.
 *
 * @param manager The resolved form manager.
 * @param scope The form's scope.
 * @returns Whether the manager may read and change forms of the scope.
 */
export function canManageRequestFormScope(manager: RequestFormManager, scope: RequestFormScope) {
  if (manager.workspace) return true
  return scope.type === 'team' && scope.teamId !== undefined && manager.teamIds.includes(scope.teamId)
}

/** Requires a form manager to manage a form scope.
 *
 * @param manager The resolved form manager.
 * @param scope The form's current or requested scope.
 * @throws RequestIntakeError when the scope is the Workspace or another Team.
 */
function requireRequestFormScopeManagement(manager: RequestFormManager, scope: RequestFormScope) {
  if (canManageRequestFormScope(manager, scope)) return
  throw new RequestIntakeError(
    403,
    'RequestFormScopeDenied',
    'Only Workspace administrators manage this form scope; a Team manager manages forms of their own Team.',
  )
}

/** Creates admin Request Form, queue, and submission-access HTTP routes.
 *
 * @param dependencies The application and transport boundaries used by the routes.
 * @returns A Hono router containing the admin Request Intake routes.
 */
export function createAdminRequestIntakeRouter(
  dependencies: AdminRequestIntakeRouterDependencies,
) {
  const router = new Hono()

  router.get('/api/request-forms', async (context) => {
    try {
      const manager = await dependencies.requireFormManagement(context)
      const { forms } = await dependencies.getRequestIntake().listForms(manager.directoryId)
      return context.json({
        forms: forms.filter((form) => canManageRequestFormScope(manager, form.scope)),
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/request-forms', async (context) => {
    try {
      const manager = await dependencies.requireFormManagement(context)
      const input = readCreateRequestFormInput(await dependencies.readJson(context.req))
      requireRequestFormScopeManagement(manager, input.scope)
      return context.json(await dependencies.getRequestIntake().createForm(
        manager.directoryId,
        { id: manager.userKey },
        input,
      ), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/request-forms/:formId', async (context) => {
    try {
      const manager = await dependencies.requireFormManagement(context)
      const form = await dependencies.getRequestIntake().getForm(
        manager.directoryId,
        context.req.param('formId') ?? '',
      )
      requireRequestFormScopeManagement(manager, form.scope)
      return context.json(form)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.put('/api/request-forms/:formId', async (context) => {
    try {
      const manager = await dependencies.requireFormManagement(context)
      const formId = context.req.param('formId') ?? ''
      const input = readUpdateRequestFormInput(await dependencies.readJson(context.req))
      const requestIntake = dependencies.getRequestIntake()
      const current = await requestIntake.getForm(manager.directoryId, formId)
      requireRequestFormScopeManagement(manager, current.scope)
      if (input.scope !== undefined) requireRequestFormScopeManagement(manager, input.scope)
      return context.json(await requestIntake.updateForm(
        manager.directoryId,
        formId,
        { id: manager.userKey },
        input,
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/request-forms/:formId/publish', async (context) => {
    try {
      const principal = await dependencies.requireFormManagement(context)
      const formId = context.req.param('formId') ?? ''
      const publishInput = readPublishRequestFormInput(await dependencies.readJson(context.req))
      const requestIntake = dependencies.getRequestIntake()
      const current = await requestIntake.getForm(principal.directoryId, formId)
      requireRequestFormScopeManagement(principal, current.scope)
      const configurationGuardConditionChecks = await dependencies.validateFormRoutingReferences(
        principal.directoryId,
        current.draft,
      )
      return context.json(await requestIntake.publishForm(
        principal.directoryId,
        formId,
        { id: principal.userKey },
        publishInput,
        configurationGuardConditionChecks ?? [],
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/request-queue', async (context) => {
    try {
      const principal = await dependencies.requireAdministration(context)
      return context.json(await dependencies.getRequestIntake().listSubmissions(principal.directoryId, {
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
      return context.json(await dependencies.getRequestIntake().getSubmission(
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
      return context.json(await dependencies.getRequestIntake().createAttachmentAccess(
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

/** Parses and normalizes a create-form request body at the HTTP boundary.
 *
 * @param value The untrusted JSON value returned by the request parser.
 * @returns A validated create-form input for the application client.
 */
function readCreateRequestFormInput(value: unknown): CreateRequestFormInput {
  const record = readObject(value, 'Create request form input')
  const expiresAt = readOptionalText(record.expiresAt, 'Request link expiry', 100)
  return {
    name: readText(record.name, 'Request form name', 200),
    scope: readRequestFormScope(record.scope),
    accessMode: readRequestFormAccessMode(record.accessMode),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    draft: validateRequestFormDraft(record.draft),
  }
}

/** Parses and normalizes an update-form request body at the HTTP boundary.
 *
 * @param value The untrusted JSON value returned by the request parser.
 * @returns A validated update-form input for the application client.
 */
function readUpdateRequestFormInput(value: unknown): UpdateRequestFormInput {
  const record = readObject(value, 'Update request form input')
  const input: UpdateRequestFormInput = {
    expectedRevision: readExpectedRevision(record.expectedRevision),
  }
  if (record.name !== undefined) input.name = readText(record.name, 'Request form name', 200)
  if (record.scope !== undefined) input.scope = readRequestFormScope(record.scope)
  if (record.status !== undefined) input.status = readRequestFormStatus(record.status)
  if (record.accessMode !== undefined) input.accessMode = readRequestFormAccessMode(record.accessMode)
  if (record.expiresAt !== undefined) {
    input.expiresAt = record.expiresAt === null
      ? null
      : readText(record.expiresAt, 'Request link expiry', 100)
  }
  if (record.draft !== undefined) input.draft = validateRequestFormDraft(record.draft)
  if (record.rotateLinkToken !== undefined) {
    input.rotateLinkToken = readBoolean(record.rotateLinkToken, 'Rotate link token')
  }
  return input
}

/** Parses and normalizes a publish-form request body at the HTTP boundary.
 *
 * @param value The untrusted JSON value returned by the request parser.
 * @returns A validated publish-form input for the application client.
 */
function readPublishRequestFormInput(value: unknown): PublishRequestFormInput {
  const record = readObject(value, 'Publish request form input')
  return { expectedRevision: readExpectedRevision(record.expectedRevision) }
}

/** Narrows an untrusted JSON value to a non-array object.
 *
 * @param value The untrusted JSON value.
 * @param label The field label used in validation errors.
 * @returns The narrowed object value.
 */
function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidRequestIntakeInput(`${label} must be an object.`)
  }
  return value
}

/** Checks whether an untrusted value is a non-array object.
 *
 * @param value The untrusted value.
 * @returns Whether the value can be indexed as a JSON object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads a required trimmed string from an untrusted value.
 *
 * @param value The untrusted value.
 * @param label The field label used in validation errors.
 * @param maximumLength The maximum accepted string length.
 * @returns The trimmed string.
 */
function readText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength) {
    throw invalidRequestIntakeInput(`${label} is invalid.`)
  }
  return value.trim()
}

/** Reads an optional trimmed string from an untrusted value.
 *
 * @param value The untrusted value.
 * @param label The field label used in validation errors.
 * @param maximumLength The maximum accepted string length.
 * @returns The trimmed string, or undefined when the field is absent.
 */
function readOptionalText(
  value: unknown,
  label: string,
  maximumLength: number,
): string | undefined {
  return value === undefined ? undefined : readText(value, label, maximumLength)
}

/** Reads an identifier with the same conservative shape used by Request Intake.
 *
 * @param value The untrusted identifier value.
 * @param label The field label used in validation errors.
 * @returns The normalized identifier.
 */
function readIdentifier(value: unknown, label: string): string {
  const identifier = readText(value, label, 160)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(identifier)) {
    throw invalidRequestIntakeInput(`${label} is invalid.`)
  }
  return identifier
}

/** Reads and normalizes a Request Form scope.
 *
 * @param value The untrusted scope value.
 * @returns A validated Request Form scope.
 */
function readRequestFormScope(value: unknown): RequestFormScope {
  const record = readObject(value, 'Request form scope')
  if (record.type === 'workspace' && record.teamId === undefined) {
    return { type: 'workspace' }
  }
  if (record.type === 'team') {
    return { type: 'team', teamId: readIdentifier(record.teamId, 'Scope Team ID') }
  }
  throw invalidRequestIntakeInput('Request form scope is invalid.')
}

/** Reads a supported Request Form access mode.
 *
 * @param value The untrusted access mode value.
 * @returns The validated access mode.
 */
function readRequestFormAccessMode(value: unknown): RequestFormAccessMode {
  if (value === 'public' || value === 'auth-required' || value === 'internal') return value
  throw invalidRequestIntakeInput('Request form access mode is invalid.')
}

/** Reads a supported mutable Request Form status.
 *
 * @param value The untrusted status value.
 * @returns The validated mutable status.
 */
function readRequestFormStatus(value: unknown): 'draft' | 'archived' {
  if (value === 'draft' || value === 'archived') return value
  throw invalidRequestIntakeInput('Request form status is invalid.')
}

/** Reads a positive safe integer revision.
 *
 * @param value The untrusted revision value.
 * @returns The validated revision.
 */
function readExpectedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalidRequestIntakeInput('Request form revision is invalid.')
  }
  return value
}

/** Reads a required boolean field.
 *
 * @param value The untrusted boolean value.
 * @param label The field label used in validation errors.
 * @returns The validated boolean.
 */
function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidRequestIntakeInput(`${label} must be boolean.`)
  return value
}

/** Creates a stable 400 error for malformed admin Request Intake input.
 *
 * @param message The validation failure message.
 * @returns The Request Intake application error.
 */
function invalidRequestIntakeInput(message: string): RequestIntakeError {
  return new RequestIntakeError(400, 'InvalidRequestIntakeInput', message)
}
