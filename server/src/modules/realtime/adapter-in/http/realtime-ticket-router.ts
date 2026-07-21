import { Hono, type Context } from 'hono'
import {
  RealtimeTicketError,
  type RealtimeTicket,
} from '../../realtime-ticket'

/** Realtime ticket route が参照する認証済み principal の最小表現です。 */
export type RealtimeTicketPrincipal = {
  /** Canonical Workspace ID です。 */
  directoryId: string
  /** Canonical Workspace member key です。 */
  userKey: string
  /** System administrator かどうかです。 */
  isSystemAdmin: boolean
}

/** Realtime ticket 発行 operation に渡す認証・HTTP context です。 */
export type IssueRealtimeTicketRequest<Principal extends RealtimeTicketPrincipal> = {
  /** 検証済み Cognito access token です。 */
  accessToken: string
  /** Realtime ticket を要求した認証済み principal です。 */
  principal: Principal
  /** 購読対象 Work Item の team ID です。 */
  teamId: string
  /** 購読対象 Work Item の issue ID です。 */
  issueId: string
  /** Transport metadata を解決する Hono request context です。 */
  context: Context
}

/** Realtime ticket HTTP adapter に注入する application 境界です。 */
export type RealtimeTicketRouterDependencies<
  Principal extends RealtimeTicketPrincipal,
> = {
  /** Bearer token を current Workspace principal へ解決します。 */
  authenticate(accessToken: string, context: Context): Promise<Principal>
  /** 認可済み Work Item scope 用の one-time ticket を発行します。 */
  issueTicket(request: IssueRealtimeTicketRequest<Principal>): Promise<RealtimeTicket>
  /** Cognito、Workspace、Project data error を既存 HTTP response へ変換します。 */
  mapError(context: Context, error: unknown): Response
  /** Request JSON を安全に parse し、失敗時は undefined を返します。 */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
}

/** 認証・認可済み Work Item scope 用の Realtime ticket route を作成します。 */
export function createRealtimeTicketRouter<
  Principal extends RealtimeTicketPrincipal,
>(dependencies: RealtimeTicketRouterDependencies<Principal>) {
  const router = new Hono()

  router.post('/api/realtime/tickets', async (context) => {
    const accessToken = readBearerAccessToken(context)
    if (!accessToken) {
      return context.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await dependencies.authenticate(accessToken, context)
      const value = await dependencies.readJson(context.req)
      const body = isRecord(value) ? value : {}
      const teamId = readRequiredString(body.teamId)
      if (!teamId) {
        return context.json({ message: 'Team ID is required.' }, 400)
      }
      const issueId = readRequiredString(body.issueId)
      if (!issueId) {
        return context.json({ message: 'Issue ID is required.' }, 400)
      }

      return context.json(await dependencies.issueTicket({
        accessToken,
        principal,
        teamId,
        issueId,
        context,
      }), 201)
    } catch (error) {
      if (error instanceof RealtimeTicketError) {
        const status = error.status === 400 || error.status === 403 || error.status === 503
          ? error.status
          : 503

        return context.json({ code: error.code, message: error.message }, status)
      }

      return dependencies.mapError(context, error)
    }
  })

  return router
}

function readBearerAccessToken(context: Context) {
  const authorization = context.req.header('Authorization') ?? ''
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]
}

function readRequiredString(value: unknown) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
