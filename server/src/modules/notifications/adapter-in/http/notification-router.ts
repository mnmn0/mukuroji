import { Hono, type Context } from 'hono'
import {
  NotificationError,
  type NotificationAction,
  type NotificationClient,
  type NotificationFilter,
  type NotificationVisibilityFilter,
  type UpdateNotificationPreferencesInput,
} from '../../notifications'

/**
 * Notification route が参照する認証済み principal の最小表現です。
 */
export type NotificationPrincipal = {
  /** Canonical Workspace ID です。 */
  directoryId: string
  /** Canonical Workspace member key です。 */
  userKey: string
}

/**
 * Notification HTTP adapter に注入する application 境界です。
 */
export type NotificationRouterDependencies<
  Principal extends NotificationPrincipal,
> = {
  /** Notification application port です。 */
  notifications: NotificationClient
  /** Bearer token を current Workspace principal へ解決します。 */
  authenticate(
    accessToken: string,
    context: Context,
  ): Promise<Principal>
  /** Current authorization state に束縛された visibility predicate を作成します。 */
  createVisibilityFilter(
    principal: Principal,
  ): Promise<NotificationVisibilityFilter>
  /** Domain/application error を既存 HTTP response へ変換します。 */
  mapError(context: Context, error: unknown): Response
  /** Request JSON を安全に parse し、失敗時は undefined を返します。 */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
}

/**
 * Notification timeline HTTP routes を作成します。
 */
export function createNotificationRouter<
  Principal extends NotificationPrincipal,
>(
  dependencies: NotificationRouterDependencies<Principal>,
) {
  const router = new Hono()

  router.get('/api/notifications', async (context) => {
    const accessToken = readBearerAccessToken(context)
    if (!accessToken) {
      return context.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await dependencies.authenticate(accessToken, context)
      const isVisible = await dependencies.createVisibilityFilter(principal)
      const filter = context.req.query('filter') as NotificationFilter | undefined
      const limitValue = context.req.query('limit')
      const input = {
        workspaceId: principal.directoryId,
        memberKey: principal.userKey,
        filter,
        eventType: context.req.query('type')?.trim() || undefined,
        limit: limitValue === undefined ? undefined : Number(limitValue),
        cursor: context.req.query('cursor')?.trim() || undefined,
        isVisible,
      }
      const [page, unreadCount] = await Promise.all([
        dependencies.notifications.list(input),
        dependencies.notifications.countUnread({
          workspaceId: principal.directoryId,
          memberKey: principal.userKey,
          isVisible,
        }),
      ])

      return context.json({ ...page, unreadCount })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/notifications/unread-count', async (context) => {
    const accessToken = readBearerAccessToken(context)
    if (!accessToken) {
      return context.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await dependencies.authenticate(accessToken, context)
      const isVisible = await dependencies.createVisibilityFilter(principal)
      const unreadCount = await dependencies.notifications.countUnread({
        workspaceId: principal.directoryId,
        memberKey: principal.userKey,
        isVisible,
      })
      return context.json({ unreadCount })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/notifications/mark-all-read', async (context) => {
    const accessToken = readBearerAccessToken(context)
    if (!accessToken) {
      return context.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await dependencies.authenticate(accessToken, context)
      const isVisible = await dependencies.createVisibilityFilter(principal)
      const updatedCount = await dependencies.notifications.markAllRead({
        workspaceId: principal.directoryId,
        memberKey: principal.userKey,
        isVisible,
      })
      const unreadCount = await dependencies.notifications.countUnread({
        workspaceId: principal.directoryId,
        memberKey: principal.userKey,
        isVisible,
      })
      return context.json({ updatedCount, unreadCount })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.patch('/api/notifications/:notificationId', async (context) => {
    const accessToken = readBearerAccessToken(context)
    if (!accessToken) {
      return context.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await dependencies.authenticate(accessToken, context)
      const isVisible = await dependencies.createVisibilityFilter(principal)
      const value = await dependencies.readJson(context.req)
      const body = isRecord(value) ? value : {}
      const notification = await dependencies.notifications.update({
        workspaceId: principal.directoryId,
        memberKey: principal.userKey,
        notificationId: context.req.param('notificationId'),
        action: readNotificationAction(body.action),
        snoozedUntil: readOptionalNotificationTimestamp(body.snoozedUntil),
        isVisible,
      })
      return context.json(notification)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/notification-preferences', async (context) => {
    const accessToken = readBearerAccessToken(context)
    if (!accessToken) {
      return context.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await dependencies.authenticate(accessToken, context)
      return context.json(await dependencies.notifications.getPreferences({
        workspaceId: principal.directoryId,
        memberKey: principal.userKey,
      }))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.put('/api/notification-preferences', async (context) => {
    const accessToken = readBearerAccessToken(context)
    if (!accessToken) {
      return context.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await dependencies.authenticate(accessToken, context)
      const value = await dependencies.readJson(context.req)
      const body = isRecord(value) ? value : {}
      const preferences = await dependencies.notifications.savePreferences({
        workspaceId: principal.directoryId,
        memberKey: principal.userKey,
        preferences: readNotificationPreferencesInput(body),
      })
      return context.json(preferences)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  return router
}

function readBearerAccessToken(context: Context) {
  const authorization = context.req.header('Authorization') ?? ''
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]
}

function readNotificationAction(value: unknown): NotificationAction {
  if (
    value === 'mark-read' ||
    value === 'mark-unread' ||
    value === 'archive' ||
    value === 'restore' ||
    value === 'snooze'
  ) {
    return value
  }
  throw new NotificationError(
    400,
    'InvalidNotificationAction',
    'Notification action is invalid.',
  )
}

function readOptionalNotificationTimestamp(value: unknown) {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new NotificationError(
      400,
      'InvalidNotificationSnooze',
      'Snooze time is invalid.',
    )
  }
  return value.trim()
}

function readNotificationPreferencesInput(
  value: Record<string, unknown>,
): UpdateNotificationPreferencesInput {
  const channels = isRecord(value.channels) ? value.channels : {}
  const quietHours = isRecord(value.quietHours) ? value.quietHours : {}

  return {
    version: Number(value.version),
    channels: {
      inApp: channels.inApp as boolean,
      email: channels.email as boolean,
      push: channels.push as boolean,
    },
    frequency: value.frequency as UpdateNotificationPreferencesInput['frequency'],
    quietHours: {
      enabled: quietHours.enabled as boolean,
      start: quietHours.start as string,
      end: quietHours.end as string,
      timeZone: quietHours.timeZone as string,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
