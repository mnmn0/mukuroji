import { Hono, type Context } from 'hono'
import type {
  MyRequestPage,
  MyRequestWorkItem,
  RequestRequesterReplyInput,
  RequestWorkItemReference,
} from '@mukuroji/contracts'
import { createMyRequestDetailView, createMyRequestView } from '../../my-requests'
import {
  RequestIntakeError,
  type RequestExternalContext,
  type RequestIntakeClient,
} from '../../request-intake'

/** The signed-in member who reads their own requests. */
export type MyRequestsRequester<Principal> = {
  /** Workspace the member belongs to. */
  workspaceId: string
  /** Member key of the requester. */
  userKey: string
  /** Authenticated principal passed back to the Work Item reader. */
  principal: Principal
}

/** Dependencies of the "My requests" HTTP adapter. */
export type MyRequestsRouterDependencies<Principal> = {
  /** Returns the Request Intake application client bound to the current request. */
  getRequestIntake(): RequestIntakeClient
  /** Authenticates the Workspace member who reads their own requests. */
  authenticate(context: Context): Promise<MyRequestsRequester<Principal>>
  /**
   * Reads the Work Item made from a request as the requester may see it.
   *
   * @returns The visible or restricted view, or undefined when the Work Item no longer exists.
   */
  readWorkItem(
    principal: Principal,
    reference: RequestWorkItemReference,
  ): Promise<MyRequestWorkItem | undefined>
  /** Creates trusted request context for rate limiting and idempotency. */
  createExternalContext(context: Context): RequestExternalContext
  /** Maps errors to the HTTP response contract. */
  mapError(context: Context, error: unknown): Response
  /** Safely parses request JSON and returns undefined when parsing fails. */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
  /** Reads an optional positive page-size query value. */
  readLimit(value: string | undefined): number | undefined
}

/**
 * Creates the routes with which a member reads and answers the requests they sent.
 *
 * Every route reads only requests recorded with the signed-in member as requester; any other
 * request is reported as not found.
 *
 * @param dependencies - Authentication, Work Item visibility, and transport callbacks.
 * @returns A Hono router containing the "My requests" endpoints.
 */
export function createMyRequestsRouter<Principal>(
  dependencies: MyRequestsRouterDependencies<Principal>,
) {
  const router = new Hono()

  router.get('/api/my-requests', async (context) => {
    try {
      const requester = await dependencies.authenticate(context)
      const limit = dependencies.readLimit(context.req.query('limit'))
      const cursor = context.req.query('cursor')
      const page = await dependencies.getRequestIntake().listRequesterSubmissions(
        requester.workspaceId,
        requester.userKey,
        {
          ...(limit === undefined ? {} : { limit }),
          ...(cursor ? { cursor } : {}),
        },
      )
      const requests = await Promise.all(page.submissions.map(async (submission) =>
        createMyRequestView(
          submission,
          submission.workItem
            ? await dependencies.readWorkItem(requester.principal, submission.workItem)
            : undefined,
        )
      ))
      return context.json({
        requests,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      } satisfies MyRequestPage)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/my-requests/:submissionId', async (context) => {
    try {
      const requester = await dependencies.authenticate(context)
      const submission = await dependencies.getRequestIntake().getRequesterSubmission(
        requester.workspaceId,
        requester.userKey,
        context.req.param('submissionId'),
      )
      return context.json(createMyRequestDetailView(
        submission,
        submission.workItem
          ? await dependencies.readWorkItem(requester.principal, submission.workItem)
          : undefined,
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/my-requests/:submissionId/replies', async (context) => {
    try {
      const requester = await dependencies.authenticate(context)
      const body = parseReply(await dependencies.readJson(context.req))
      return context.json(await dependencies.getRequestIntake().replyAsRequester(
        requester.workspaceId,
        requester.userKey,
        context.req.param('submissionId'),
        body,
        dependencies.createExternalContext(context),
      ), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  return router
}

/**
 * Validates a requester reply body.
 *
 * @param value - Parsed JSON body.
 * @returns The trimmed reply.
 */
function parseReply(value: unknown): RequestRequesterReplyInput {
  const body = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Reflect.get(value, 'body')
    : undefined
  if (typeof body !== 'string' || !body.trim() || body.trim().length > 20_000) {
    throw new RequestIntakeError(400, 'InvalidRequestIntakeInput', 'Requester reply body is invalid.')
  }
  return { body: body.trim() }
}
