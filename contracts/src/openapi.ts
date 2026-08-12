import {
  WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS,
  WORK_ITEM_SCHEDULE_MAX_HOLIDAYS,
} from './work-items'

const apiScopes = [
  'work-items:read',
  'work-items:write',
  'work-items:delete',
  'webhooks:read',
  'webhooks:write',
  'integrations:read',
  'integrations:write',
  'imports:read',
  'imports:write',
] as const

const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` })

const rateLimitHeaders = {
  'RateLimit-Limit': { $ref: '#/components/headers/RateLimitLimit' },
  'RateLimit-Remaining': { $ref: '#/components/headers/RateLimitRemaining' },
  'RateLimit-Reset': { $ref: '#/components/headers/RateLimitReset' },
} as const

const mutationHeaders = {
  ...rateLimitHeaders,
  'Idempotency-Replayed': { $ref: '#/components/headers/IdempotencyReplayed' },
} as const

const secretCacheHeaders = {
  'Cache-Control': { $ref: '#/components/headers/CacheControlNoStore' },
  Pragma: { $ref: '#/components/headers/PragmaNoCache' },
} as const

const jsonResponse = (
  description: string,
  schema: object,
  mutation = false,
) => ({
  description,
  headers: mutation ? mutationHeaders : rateLimitHeaders,
  content: {
    'application/json': { schema },
  },
})

const secretJsonResponse = (
  description: string,
  schema: object,
  mutation = false,
) => ({
  ...jsonResponse(description, schema, mutation),
  headers: {
    ...(mutation ? mutationHeaders : rateLimitHeaders),
    ...secretCacheHeaders,
  },
})

const emptyResponse = (description: string, mutation = false) => ({
  description,
  headers: mutation ? mutationHeaders : rateLimitHeaders,
})

const problemResponses = {
  '400': { $ref: '#/components/responses/BadRequest' },
  '401': { $ref: '#/components/responses/Unauthorized' },
  '403': { $ref: '#/components/responses/Forbidden' },
  '409': { $ref: '#/components/responses/Conflict' },
  '413': { $ref: '#/components/responses/PayloadTooLarge' },
  '422': { $ref: '#/components/responses/UnprocessableEntity' },
  '429': { $ref: '#/components/responses/TooManyRequests' },
  '500': { $ref: '#/components/responses/InternalServerError' },
  '503': { $ref: '#/components/responses/ServiceUnavailable' },
} as const

const unsupportedMediaTypeResponse = {
  '415': { $ref: '#/components/responses/UnsupportedMediaType' },
} as const

const notFoundResponse = {
  '404': { $ref: '#/components/responses/NotFound' },
} as const

const idempotencyParameters = [
  { $ref: '#/components/parameters/IdempotencyKey' },
  { $ref: '#/components/parameters/CorrelationId' },
] as const

const sessionSecurity = [{ CognitoBearer: [] }] as const

const publicApiSecurity = (...scopes: string[]) => [
  { ApiKeyAuth: [] },
  { OAuth2: scopes },
]

const idPathParameter = (name: string, description: string) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string', minLength: 1 },
})

const cursorParameters = [
  {
    name: 'cursor',
    in: 'query',
    description: '前 response の opaque nextCursor です。',
    schema: { type: 'string' },
  },
  {
    name: 'limit',
    in: 'query',
    description: '1 page に返す最大件数です。',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  },
] as const

const publicCursorParameters = [
  {
    ...cursorParameters[0],
    description: '前 response の opaque nextCursor です。発行から15分で失効します。',
  },
  cursorParameters[1],
] as const

const components = {
  securitySchemes: {
    ApiKeyAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'APIKey',
      description: 'SDK は Authorization: Bearer <api-key> 形式で送信します。',
    },
    OAuth2: {
      type: 'oauth2',
      flows: {
        clientCredentials: {
          tokenUrl: '/api/v1/oauth/token',
          scopes: Object.fromEntries(apiScopes.map((scope) => [scope, scope])),
        },
      },
    },
    CognitoBearer: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'Developer settings management API 用の Cognito access token です。',
    },
  },
  parameters: {
    IdempotencyKey: {
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      description: '同じ actor・operation・payload の retry で再利用する client-generated key です。',
      schema: { type: 'string', minLength: 1, maxLength: 256 },
    },
    CorrelationId: {
      name: 'X-Correlation-Id',
      in: 'header',
      required: false,
      description: 'Client の trace と API request を結び付ける ID です。',
      schema: { type: 'string', minLength: 1, maxLength: 128 },
    },
  },
  headers: {
    RateLimitLimit: {
      description: '現在 window で許可された request 数です。',
      schema: { type: 'integer', minimum: 0 },
    },
    RateLimitRemaining: {
      description: '現在 window に残る request 数です。',
      schema: { type: 'integer', minimum: 0 },
    },
    RateLimitReset: {
      description: 'Quota が回復するまでの秒数です。',
      schema: { type: 'integer', minimum: 0 },
    },
    RetryAfter: {
      description: 'Retry まで待つ秒数です。',
      schema: { type: 'integer', minimum: 0 },
    },
    IdempotencyReplayed: {
      description: '保存済み response の replay かどうかです。',
      schema: { type: 'boolean' },
    },
    CacheControlNoStore: {
      description: 'Secret-bearing response を保存しない cache directive です。',
      schema: { type: 'string', const: 'no-store' },
    },
    PragmaNoCache: {
      description: 'Legacy intermediary に保存禁止を伝える directive です。',
      schema: { type: 'string', const: 'no-cache' },
    },
  },
  responses: {
    BadRequest: {
      description: 'Request syntax または parameter が不正です。',
      headers: rateLimitHeaders,
      content: { 'application/problem+json': { schema: schemaRef('ApiProblem') } },
    },
    Unauthorized: {
      description: 'Credential が無いか無効です。',
      headers: rateLimitHeaders,
      content: { 'application/problem+json': { schema: schemaRef('ApiProblem') } },
    },
    Forbidden: {
      description: 'Scope または Workspace RBAC permission が不足しています。',
      headers: rateLimitHeaders,
      content: { 'application/problem+json': { schema: schemaRef('ApiProblem') } },
    },
    NotFound: {
      description: 'Resource が存在しないか actor から不可視です。',
      headers: rateLimitHeaders,
      content: { 'application/problem+json': { schema: schemaRef('ApiProblem') } },
    },
    Conflict: {
      description: 'Revision、同期、または idempotency fingerprint が競合しました。',
      headers: mutationHeaders,
      content: { 'application/problem+json': { schema: schemaRef('ApiProblem') } },
    },
    PayloadTooLarge: {
      description: '同期処理で受け付ける payload 上限を超えました。',
      headers: mutationHeaders,
      content: { 'application/problem+json': { schema: schemaRef('ApiProblem') } },
    },
    UnsupportedMediaType: {
      description: 'Request の media type が endpoint の要件と一致しません。',
      headers: mutationHeaders,
      content: { 'application/problem+json': { schema: schemaRef('ApiProblem') } },
    },
    UnprocessableEntity: {
      description: 'Request body の field validation に失敗しました。',
      headers: mutationHeaders,
      content: { 'application/problem+json': { schema: schemaRef('ApiProblem') } },
    },
    TooManyRequests: {
      description: 'Rate limit を超過しました。',
      headers: {
        ...rateLimitHeaders,
        'Retry-After': { $ref: '#/components/headers/RetryAfter' },
      },
      content: { 'application/problem+json': { schema: schemaRef('ApiProblem') } },
    },
    InternalServerError: {
      description: '予期しない server error です。',
      headers: rateLimitHeaders,
      content: { 'application/problem+json': { schema: schemaRef('ApiProblem') } },
    },
    ServiceUnavailable: {
      description: '一時的に利用できません。',
      headers: {
        ...rateLimitHeaders,
        'Retry-After': { $ref: '#/components/headers/RetryAfter' },
      },
      content: { 'application/problem+json': { schema: schemaRef('ApiProblem') } },
    },
  },
  schemas: {
    ApiScope: {
      type: 'string',
      enum: apiScopes,
    },
    ApiProblemViolation: {
      type: 'object',
      additionalProperties: false,
      required: ['pointer', 'code', 'message'],
      properties: {
        pointer: { type: 'string' },
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
    ApiProblem: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'title', 'status', 'code', 'requestId', 'retryable'],
      properties: {
        type: { type: 'string', format: 'uri' },
        title: { type: 'string' },
        status: { type: 'integer', minimum: 400, maximum: 599 },
        code: {
          type: 'string',
          enum: [
            'invalid_request',
            'authentication_required',
            'invalid_credentials',
            'insufficient_scope',
            'forbidden',
            'not_found',
            'conflict',
            'idempotency_conflict',
            'validation_failed',
            'rate_limited',
            'temporarily_unavailable',
            'internal_error',
          ],
        },
        detail: { type: 'string' },
        instance: { type: 'string' },
        requestId: { type: 'string' },
        retryable: { type: 'boolean' },
        errors: { type: 'array', items: schemaRef('ApiProblemViolation') },
      },
    },
    WorkItemScheduleDate: {
      type: 'string',
      format: 'date',
      pattern: '^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$',
      description: 'A real Gregorian date from 1000-01-01 through 9999-12-31.',
    },
    WorkItemScheduleCalendarPolicy: {
      type: 'object',
      additionalProperties: false,
      required: ['timeZone', 'workingWeekdays', 'holidays'],
      properties: {
        timeZone: { type: 'string', minLength: 1 },
        workingWeekdays: {
          type: 'array',
          minItems: 1,
          maxItems: 7,
          uniqueItems: true,
          items: {
            type: 'string',
            enum: [
              'monday',
              'tuesday',
              'wednesday',
              'thursday',
              'friday',
              'saturday',
              'sunday',
            ],
          },
        },
        holidays: {
          type: 'array',
          maxItems: WORK_ITEM_SCHEDULE_MAX_HOLIDAYS,
          uniqueItems: true,
          items: schemaRef('WorkItemScheduleDate'),
        },
      },
    },
    WorkItemSchedule: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['mode', 'calendarPolicy'],
          properties: {
            mode: { type: 'string', const: 'unscheduled' },
            calendarPolicy: schemaRef('WorkItemScheduleCalendarPolicy'),
            plannedEffortMinutes: { type: 'integer', minimum: 0 },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['mode', 'calendarPolicy', 'dueDate'],
          properties: {
            mode: { type: 'string', const: 'due-date' },
            calendarPolicy: schemaRef('WorkItemScheduleCalendarPolicy'),
            dueDate: schemaRef('WorkItemScheduleDate'),
            plannedEffortMinutes: { type: 'integer', minimum: 0 },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'mode',
            'calendarPolicy',
            'startDate',
            'endDate',
            'durationDays',
          ],
          properties: {
            mode: { type: 'string', const: 'date-range' },
            calendarPolicy: schemaRef('WorkItemScheduleCalendarPolicy'),
            startDate: schemaRef('WorkItemScheduleDate'),
            endDate: schemaRef('WorkItemScheduleDate'),
            durationDays: {
              type: 'integer',
              minimum: 1,
              maximum: WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS,
            },
            plannedEffortMinutes: { type: 'integer', minimum: 0 },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'mode',
            'calendarPolicy',
            'startDate',
            'endDate',
            'durationDays',
          ],
          properties: {
            mode: { type: 'string', const: 'milestone' },
            calendarPolicy: schemaRef('WorkItemScheduleCalendarPolicy'),
            startDate: schemaRef('WorkItemScheduleDate'),
            endDate: schemaRef('WorkItemScheduleDate'),
            durationDays: { type: 'integer', const: 0 },
            plannedEffortMinutes: { type: 'integer', minimum: 0 },
          },
        },
      ],
    },
    WorkItem: {
      type: 'object',
      additionalProperties: false,
      required: [
        'schemaVersion',
        'revision',
        'id',
        'teamId',
        'title',
        'assigneeUserId',
        'dueDate',
        'schedule',
        'priority',
        'creatorMemberKey',
        'workflowStatusId',
        'statusCategory',
        'workflowSchemaVersion',
        'customFieldValues',
        'relationIds',
        'createdAt',
        'updatedAt',
        'source',
      ],
      properties: {
        schemaVersion: { type: 'integer', const: 2 },
        revision: { type: 'integer', minimum: 1 },
        id: { type: 'string' },
        teamId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        assignedProjectId: { type: 'string' },
        assigneeUserId: { type: 'string' },
        assigneeEmail: { type: 'string', format: 'email' },
        assigneeName: { type: 'string' },
        dueDate: {
          anyOf: [
            schemaRef('WorkItemScheduleDate'),
            { type: 'string', const: '' },
          ],
          description: 'Deadline projection derived from schedule; empty when unscheduled.',
        },
        schedule: schemaRef('WorkItemSchedule'),
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        creatorMemberKey: { type: 'string' },
        workflowStatusId: { type: 'string' },
        statusCategory: {
          type: 'string',
          enum: ['backlog', 'unstarted', 'started', 'completed', 'canceled'],
        },
        workflowSchemaVersion: { type: 'integer', const: 1 },
        customFieldValues: { type: 'object', additionalProperties: true },
        relationIds: { type: 'array', items: { type: 'string' } },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
        source: { type: 'string', const: 'dynamodb' },
      },
    },
    CreatePublicWorkItemRequest: {
      type: 'object',
      additionalProperties: false,
      required: ['teamId', 'title', 'assigneeUserId', 'schedule', 'priority'],
      properties: {
        teamId: { type: 'string' },
        title: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        assignedProjectId: { type: 'string' },
        assigneeUserId: { type: 'string' },
        workflowStatusId: { type: 'string' },
        customFieldValues: { type: 'object', additionalProperties: true },
        quickCapture: {
          type: 'boolean',
          description: 'When true, workflowStatusId must identify a backlog status so required custom fields can be completed later.',
        },
        schedule: schemaRef('WorkItemSchedule'),
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
    },
    UpdatePublicWorkItemRequest: {
      type: 'object',
      additionalProperties: false,
      minProperties: 2,
      required: ['expectedRevision'],
      properties: {
        expectedRevision: { type: 'integer', minimum: 1 },
        title: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        assignedProjectId: { type: ['string', 'null'] },
        assigneeUserId: { type: 'string' },
        workflowStatusId: { type: 'string' },
        customFieldValues: { type: 'object', additionalProperties: true },
        schedule: schemaRef('WorkItemSchedule'),
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
    },
    DeletePublicWorkItemRequest: {
      type: 'object',
      additionalProperties: false,
      required: ['expectedRevision'],
      properties: {
        expectedRevision: { type: 'integer', minimum: 1 },
      },
    },
    PublicWorkItemPage: {
      type: 'object',
      additionalProperties: false,
      required: ['items', 'hasMore'],
      properties: {
        items: { type: 'array', items: schemaRef('WorkItem') },
        hasMore: { type: 'boolean' },
        nextCursor: { type: 'string' },
      },
    },
    ApiKeySummary: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name', 'prefix', 'scopes', 'status', 'createdByUserId', 'createdAt'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        prefix: { type: 'string' },
        scopes: { type: 'array', items: schemaRef('ApiScope') },
        status: { type: 'string', enum: ['active', 'expired', 'revoked'] },
        createdByUserId: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
        expiresAt: { type: 'string', format: 'date-time' },
        lastUsedAt: { type: 'string', format: 'date-time' },
        revokedAt: { type: 'string', format: 'date-time' },
      },
    },
    CreateApiKeyInput: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'scopes'],
      properties: {
        name: { type: 'string', minLength: 1 },
        scopes: { type: 'array', minItems: 1, uniqueItems: true, items: schemaRef('ApiScope') },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
    RotateApiKeyInput: {
      type: 'object',
      additionalProperties: false,
      properties: {
        expiresAt: { type: ['string', 'null'], format: 'date-time' },
      },
    },
    ApiKeyOneTimeSecretOutput: {
      type: 'object',
      additionalProperties: false,
      required: ['apiKey', 'secret'],
      properties: {
        apiKey: schemaRef('ApiKeySummary'),
        secret: { type: 'string', readOnly: true },
      },
    },
    OAuthAppSummary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'id', 'name', 'clientId', 'grantTypes', 'scopes', 'status',
        'createdByUserId', 'createdAt', 'updatedAt',
      ],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        clientId: { type: 'string' },
        grantTypes: {
          type: 'array',
          items: { type: 'string', const: 'client_credentials' },
        },
        scopes: { type: 'array', items: schemaRef('ApiScope') },
        status: { type: 'string', enum: ['active', 'expired', 'revoked'] },
        createdByUserId: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
        expiresAt: { type: 'string', format: 'date-time' },
        lastUsedAt: { type: 'string', format: 'date-time' },
        revokedAt: { type: 'string', format: 'date-time' },
      },
    },
    CreateOAuthAppInput: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'grantTypes', 'scopes'],
      properties: {
        name: { type: 'string', minLength: 1 },
        grantTypes: {
          type: 'array', minItems: 1, uniqueItems: true,
          items: { type: 'string', const: 'client_credentials' },
        },
        scopes: { type: 'array', minItems: 1, uniqueItems: true, items: schemaRef('ApiScope') },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
    OAuthAppOneTimeSecretOutput: {
      type: 'object',
      additionalProperties: false,
      required: ['oauthApp', 'clientSecret'],
      properties: {
        oauthApp: schemaRef('OAuthAppSummary'),
        clientSecret: { type: 'string', readOnly: true },
      },
    },
    OAuthTokenRequest: {
      type: 'object',
      additionalProperties: false,
      required: ['grant_type', 'client_id', 'client_secret'],
      properties: {
        grant_type: {
          type: 'string',
          const: 'client_credentials',
        },
        client_id: { type: 'string' },
        client_secret: { type: 'string', writeOnly: true },
        scope: { type: 'string' },
      },
    },
    OAuthTokenOutput: {
      type: 'object',
      additionalProperties: false,
      required: ['access_token', 'token_type', 'expires_in', 'scope'],
      properties: {
        access_token: { type: 'string', readOnly: true },
        token_type: { type: 'string', const: 'Bearer' },
        expires_in: { type: 'integer', minimum: 1 },
        scope: { type: 'string' },
      },
    },
    WebhookEventType: {
      type: 'string',
      enum: [
        'work-item.created', 'work-item.updated', 'work-item.deleted',
        'external-link.created', 'external-link.updated',
        'sync-conflict.created', 'sync-conflict.resolved',
        'import.completed', 'import.failed',
      ],
    },
    WebhookSubscription: {
      type: 'object',
      additionalProperties: false,
      required: [
        'id', 'name', 'url', 'createdByUserId', 'teamIds', 'eventTypes', 'scopes',
        'status', 'createdAt', 'updatedAt', 'failureCount',
      ],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        url: { type: 'string', format: 'uri' },
        createdByUserId: { type: 'string' },
        teamIds: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string' },
        },
        eventTypes: { type: 'array', items: schemaRef('WebhookEventType') },
        scopes: { type: 'array', items: schemaRef('ApiScope') },
        status: { type: 'string', enum: ['active', 'paused', 'disabled'] },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
        lastDeliveryAt: { type: 'string', format: 'date-time' },
        failureCount: { type: 'integer', minimum: 0 },
      },
    },
    CreateWebhookSubscriptionInput: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'url', 'teamIds', 'eventTypes'],
      properties: {
        name: { type: 'string', minLength: 1 },
        url: { type: 'string', format: 'uri', pattern: '^https://' },
        teamIds: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          uniqueItems: true,
          items: { type: 'string' },
        },
        eventTypes: { type: 'array', minItems: 1, uniqueItems: true, items: schemaRef('WebhookEventType') },
        scopes: { type: 'array', uniqueItems: true, items: schemaRef('ApiScope') },
      },
    },
    UpdateWebhookSubscriptionInput: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        name: { type: 'string', minLength: 1 },
        url: { type: 'string', format: 'uri', pattern: '^https://' },
        eventTypes: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: schemaRef('WebhookEventType'),
        },
        scopes: { type: 'array', uniqueItems: true, items: schemaRef('ApiScope') },
        status: { type: 'string', enum: ['active', 'paused', 'disabled'] },
      },
    },
    WebhookSubscriptionSecretOutput: {
      type: 'object',
      additionalProperties: false,
      required: ['subscription', 'signingSecret'],
      properties: {
        subscription: schemaRef('WebhookSubscription'),
        signingSecret: { type: 'string', readOnly: true },
      },
    },
    WebhookDelivery: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'subscriptionId', 'eventId', 'eventType', 'status', 'attempts', 'createdAt', 'updatedAt'],
      properties: {
        id: { type: 'string' },
        subscriptionId: { type: 'string' },
        eventId: { type: 'string' },
        eventType: schemaRef('WebhookEventType'),
        status: { type: 'string', enum: ['pending', 'retrying', 'delivered', 'failed'] },
        attempts: { type: 'integer', minimum: 0 },
        responseStatus: { type: 'integer', minimum: 100, maximum: 599 },
        replayOfDeliveryId: { type: 'string' },
        replayNumber: { type: 'integer', minimum: 1 },
        nextAttemptAt: { type: 'string', format: 'date-time' },
        deliveredAt: { type: 'string', format: 'date-time' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
    ConnectorProvider: {
      type: 'string',
      enum: [
        'github', 'gitlab', 'slack', 'microsoft-teams', 'gmail', 'outlook',
        'google-calendar', 'outlook-calendar', 'google-drive', 'onedrive',
        'dropbox',
      ],
    },
    ConnectorDefinition: {
      type: 'object',
      additionalProperties: false,
      required: ['provider', 'category', 'name', 'capabilities'],
      properties: {
        provider: schemaRef('ConnectorProvider'),
        category: {
          type: 'string',
          enum: ['source-control', 'chat', 'email', 'calendar', 'cloud-storage'],
        },
        name: { type: 'string' },
        capabilities: { type: 'array', items: { type: 'string' } },
      },
    },
    ConnectorInstallation: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'category', 'provider', 'name', 'status', 'scopes', 'installedByUserId', 'installedAt', 'updatedAt'],
      properties: {
        id: { type: 'string' },
        category: {
          type: 'string',
          enum: ['source-control', 'chat', 'email', 'calendar', 'cloud-storage'],
        },
        provider: schemaRef('ConnectorProvider'),
        name: { type: 'string' },
        status: {
          type: 'string',
          enum: ['connected', 'needs-reauth', 'degraded', 'disconnected', 'conflict'],
        },
        scopes: { type: 'array', items: { type: 'string' } },
        externalAccountId: { type: 'string' },
        externalAccountName: { type: 'string' },
        installedByUserId: { type: 'string' },
        installedAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
        lastSyncAt: { type: 'string', format: 'date-time' },
        lastError: schemaRef('ApiProblem'),
        reauthorizationUrl: { type: 'string', format: 'uri' },
      },
    },
    CreateConnectorInstallationInput: {
      type: 'object',
      additionalProperties: false,
      required: ['provider', 'name', 'scopes', 'returnUrl'],
      properties: {
        provider: schemaRef('ConnectorProvider'),
        name: { type: 'string', minLength: 1 },
        scopes: { type: 'array', uniqueItems: true, items: { type: 'string' } },
        returnUrl: { type: 'string' },
      },
    },
    ConnectorAuthorizationOutput: {
      type: 'object',
      additionalProperties: false,
      required: ['authorizationUrl', 'stateId', 'expiresAt'],
      properties: {
        authorizationUrl: { type: 'string', format: 'uri' },
        stateId: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
    ExternalWorkItemLink: {
      type: 'object',
      additionalProperties: false,
      required: [
        'id', 'teamId', 'workItemId', 'installationId', 'resourceType', 'externalId',
        'externalUrl', 'syncDirection', 'syncStatus', 'createdAt', 'updatedAt',
      ],
      properties: {
        id: { type: 'string' },
        teamId: { type: 'string' },
        workItemId: { type: 'string' },
        installationId: { type: 'string' },
        provider: schemaRef('ConnectorProvider'),
        installationName: { type: 'string' },
        externalAccountName: { type: 'string' },
        resourceType: { type: 'string', enum: ['issue', 'merge-request', 'commit', 'deploy'] },
        externalId: { type: 'string' },
        externalUrl: { type: 'string', format: 'uri' },
        displayKey: { type: 'string' },
        syncDirection: { type: 'string', enum: ['inbound', 'outbound', 'bidirectional', 'none'] },
        syncStatus: { type: 'string', enum: ['pending', 'synced', 'conflict', 'failed', 'paused'] },
        lastSyncedAt: { type: 'string', format: 'date-time' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
    WorkItemSyncConflictField: {
      type: 'object',
      additionalProperties: false,
      required: ['field', 'localValue', 'externalValue'],
      properties: {
        field: { type: 'string', minLength: 1 },
        localValue: {},
        externalValue: {},
      },
    },
    WorkItemSyncConflict: {
      type: 'object',
      additionalProperties: false,
      required: [
        'id', 'externalLinkId', 'workItemId', 'localRevision',
        'externalRevision', 'fields', 'status', 'detectedAt',
      ],
      properties: {
        id: { type: 'string' },
        externalLinkId: { type: 'string' },
        workItemId: { type: 'string' },
        localRevision: { type: 'integer', minimum: 0 },
        externalRevision: { type: 'string' },
        fields: {
          type: 'array',
          items: schemaRef('WorkItemSyncConflictField'),
        },
        status: { type: 'string', enum: ['open', 'resolved', 'ignored'] },
        detectedAt: { type: 'string', format: 'date-time' },
        resolvedAt: { type: 'string', format: 'date-time' },
        resolvedByUserId: { type: 'string' },
      },
    },
    ResolveWorkItemSyncConflictInput: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['resolution'],
          properties: {
            resolution: {
              type: 'string',
              enum: ['use-local', 'use-external', 'ignore'],
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['resolution', 'mergedValues'],
          properties: {
            resolution: { const: 'merge' },
            mergedValues: {
              type: 'object',
              additionalProperties: true,
            },
          },
        },
      ],
    },
    CreateExternalWorkItemLinkInput: {
      type: 'object',
      additionalProperties: false,
      required: ['teamId', 'installationId', 'resourceType', 'externalId', 'externalUrl', 'syncDirection'],
      properties: {
        teamId: { type: 'string' },
        installationId: { type: 'string' },
        resourceType: { type: 'string', enum: ['issue', 'merge-request', 'commit', 'deploy'] },
        externalId: { type: 'string' },
        externalUrl: { type: 'string', format: 'uri' },
        displayKey: { type: 'string' },
        syncDirection: { type: 'string', enum: ['inbound', 'outbound', 'bidirectional', 'none'] },
      },
    },
    CreatePublicExternalWorkItemLinkInput: {
      type: 'object',
      additionalProperties: false,
      required: ['installationId', 'resourceType', 'externalId', 'externalUrl', 'syncDirection'],
      properties: {
        installationId: { type: 'string' },
        resourceType: { type: 'string', enum: ['issue', 'merge-request', 'commit', 'deploy'] },
        externalId: { type: 'string' },
        externalUrl: { type: 'string', format: 'uri' },
        displayKey: { type: 'string' },
        syncDirection: { type: 'string', enum: ['inbound', 'outbound', 'bidirectional', 'none'] },
      },
    },
    UpdateExternalWorkItemLinkInput: {
      type: 'object',
      additionalProperties: false,
      required: ['syncDirection'],
      properties: {
        syncDirection: { type: 'string', enum: ['inbound', 'outbound', 'bidirectional', 'none'] },
      },
    },
    ImportFieldMapping: {
      type: 'object',
      additionalProperties: false,
      required: ['sourceField', 'targetField'],
      properties: {
        sourceField: { type: 'string' },
        targetField: { type: 'string' },
        transform: {
          type: 'string',
          enum: ['none', 'trim', 'lowercase', 'uppercase', 'parse-date', 'parse-number', 'split-comma'],
        },
        required: { type: 'boolean' },
        defaultValue: true,
      },
    },
    ImportSource: {
      type: 'object',
      additionalProperties: false,
      required: ['fileName', 'mediaType', 'content'],
      properties: {
        fileName: { type: 'string' },
        mediaType: { type: 'string', enum: ['text/csv', 'application/json'] },
        content: { type: 'string' },
      },
    },
    CreateImportInput: {
      type: 'object',
      additionalProperties: false,
      required: ['format', 'source', 'teamId', 'mapping'],
      properties: {
        format: { type: 'string', enum: ['csv', 'json'] },
        source: schemaRef('ImportSource'),
        teamId: { type: 'string' },
        assignedProjectId: { type: 'string' },
        mapping: { type: 'array', items: schemaRef('ImportFieldMapping') },
      },
    },
    ImportRowError: {
      type: 'object',
      additionalProperties: false,
      required: ['row', 'code', 'message'],
      properties: {
        row: { type: 'integer', minimum: 1 },
        field: { type: 'string' },
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
    ImportReport: {
      type: 'object',
      additionalProperties: false,
      required: ['totalRows', 'validRows', 'invalidRows', 'errors'],
      properties: {
        totalRows: { type: 'integer', minimum: 0 },
        validRows: { type: 'integer', minimum: 0 },
        invalidRows: { type: 'integer', minimum: 0 },
        errors: { type: 'array', items: schemaRef('ImportRowError') },
      },
    },
    ImportDryRunReport: {
      type: 'object',
      additionalProperties: false,
      required: [
        'totalRows', 'validRows', 'invalidRows', 'errors', 'valid', 'sample',
      ],
      properties: {
        totalRows: { type: 'integer', minimum: 0 },
        validRows: { type: 'integer', minimum: 0 },
        invalidRows: { type: 'integer', minimum: 0 },
        errors: { type: 'array', items: schemaRef('ImportRowError') },
        valid: { type: 'boolean' },
        sample: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['row', 'input', 'mapped', 'valid', 'errors'],
            properties: {
              row: { type: 'integer', minimum: 1 },
              input: { type: 'object', additionalProperties: true },
              mapped: { type: 'object', additionalProperties: true },
              valid: { type: 'boolean' },
              errors: { type: 'array', items: schemaRef('ImportRowError') },
            },
          },
        },
      },
    },
    ImportJob: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'format', 'teamId', 'status', 'mapping', 'dryRun', 'createdByUserId', 'createdAt'],
      properties: {
        id: { type: 'string' },
        format: { type: 'string', enum: ['csv', 'json'] },
        teamId: { type: 'string' },
        assignedProjectId: { type: 'string' },
        status: {
          type: 'string',
          enum: ['queued', 'validating', 'running', 'completed', 'failed', 'cancelled'],
        },
        mapping: { type: 'array', items: schemaRef('ImportFieldMapping') },
        dryRun: { type: 'boolean' },
        createdByUserId: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
        startedAt: { type: 'string', format: 'date-time' },
        completedAt: { type: 'string', format: 'date-time' },
        report: schemaRef('ImportReport'),
        error: schemaRef('ApiProblem'),
      },
    },
    DeveloperPlatformOverview: {
      type: 'object',
      additionalProperties: false,
      required: [
        'capabilities', 'apiKeys', 'oauthApps', 'webhookSubscriptions',
        'webhookDeliveries', 'connectors', 'imports',
      ],
      properties: {
        capabilities: {
          type: 'object',
          additionalProperties: false,
          required: [
            'canManageCredentials', 'canManageWebhooks', 'canManageIntegrations',
            'canImport', 'canExport',
          ],
          properties: {
            canManageCredentials: { type: 'boolean' },
            canManageWebhooks: { type: 'boolean' },
            canManageIntegrations: { type: 'boolean' },
            canImport: { type: 'boolean' },
            canExport: { type: 'boolean' },
          },
        },
        apiKeys: { type: 'array', items: schemaRef('ApiKeySummary') },
        oauthApps: { type: 'array', items: schemaRef('OAuthAppSummary') },
        webhookSubscriptions: { type: 'array', items: schemaRef('WebhookSubscription') },
        webhookDeliveries: { type: 'array', items: schemaRef('WebhookDelivery') },
        connectors: { type: 'array', items: schemaRef('ConnectorInstallation') },
        imports: { type: 'array', items: schemaRef('ImportJob') },
      },
    },
  },
} as const

const jsonRequestBody = (schemaName: string) => ({
  required: true,
  content: {
    'application/json': { schema: schemaRef(schemaName) },
  },
})

const cursorPageSchema = (itemSchemaName: string) => ({
  type: 'object',
  additionalProperties: false,
  required: ['items', 'hasMore'],
  properties: {
    items: { type: 'array', items: schemaRef(itemSchemaName) },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
})

const paths = {
  '/api/v1/openapi.json': {
    get: {
      operationId: 'getPublicApiOpenApiDocument',
      tags: ['Schema'],
      summary: 'OpenAPI 3.1 document を取得する',
      security: [],
      responses: {
        '200': {
          description: 'Public API の OpenAPI 3.1 document です。',
          headers: rateLimitHeaders,
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: true },
            },
          },
        },
        '429': problemResponses['429'],
        '500': problemResponses['500'],
      },
    },
  },
  '/api/v1/oauth/token': {
    post: {
      operationId: 'exchangeOAuthToken',
      tags: ['OAuth'],
      summary: 'Server-to-server OAuth credential を access token と交換する',
      description: 'client_credentials grant の client ID と client secret を交換します。',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/x-www-form-urlencoded': { schema: schemaRef('OAuthTokenRequest') },
        },
      },
      responses: {
        '200': secretJsonResponse('Access token を発行しました。', schemaRef('OAuthTokenOutput')),
        '400': problemResponses['400'],
        '401': problemResponses['401'],
        ...unsupportedMediaTypeResponse,
        '429': problemResponses['429'],
        '500': problemResponses['500'],
        '503': problemResponses['503'],
      },
    },
  },
  '/api/v1/work-items': {
    get: {
      operationId: 'listPublicWorkItems',
      tags: ['Work Items'],
      summary: 'Work Item を cursor pagination で取得する',
      security: publicApiSecurity('work-items:read'),
      parameters: [
        {
          name: 'teamId',
          in: 'query',
          required: true,
          schema: { type: 'string' },
          description: '取得対象を所有する Team ID です。',
        },
        {
          name: 'assignedProjectId',
          in: 'query',
          schema: { type: 'string' },
          description: 'Assigned Project ID filter です。',
        },
        {
          name: 'assigneeUserId',
          in: 'query',
          schema: { type: 'string' },
          description: 'Assignee Workspace user ID filter です。',
        },
        {
          name: 'workflowStatusId',
          in: 'query',
          schema: { type: 'string' },
          description: 'Workflow status ID filter です。',
        },
        {
          name: 'updatedAfter',
          in: 'query',
          schema: { type: 'string', format: 'date-time' },
          description: '指定 timestamp 以降に更新された resource へ絞り込みます。',
        },
        ...publicCursorParameters,
      ],
      responses: {
        '200': jsonResponse('Work Item page です。', schemaRef('PublicWorkItemPage')),
        ...problemResponses,
      },
    },
    post: {
      operationId: 'createPublicWorkItem',
      tags: ['Work Items'],
      summary: 'Work Item を作成する',
      security: publicApiSecurity('work-items:write'),
      parameters: idempotencyParameters,
      requestBody: jsonRequestBody('CreatePublicWorkItemRequest'),
      responses: {
        '201': jsonResponse('Work Item を作成しました。', schemaRef('WorkItem'), true),
        ...problemResponses,
      },
    },
  },
  '/api/v1/work-items/{workItemId}': {
    get: {
      operationId: 'getPublicWorkItem',
      tags: ['Work Items'],
      summary: 'Work Item を取得する',
      security: publicApiSecurity('work-items:read'),
      parameters: [
        idPathParameter('workItemId', 'Work Item ID です。'),
        {
          name: 'teamId', in: 'query', required: true,
          description: 'Work Item を所有する Team ID です。',
          schema: { type: 'string' },
        },
      ],
      responses: {
        '200': jsonResponse('Work Item です。', schemaRef('WorkItem')),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
    patch: {
      operationId: 'updatePublicWorkItem',
      tags: ['Work Items'],
      summary: 'Work Item を optimistic concurrency 付きで更新する',
      security: publicApiSecurity('work-items:write'),
      parameters: [
        idPathParameter('workItemId', 'Work Item ID です。'),
        {
          name: 'teamId', in: 'query', required: true,
          description: 'Work Item を所有する Team ID です。',
          schema: { type: 'string' },
        },
        ...idempotencyParameters,
      ],
      requestBody: jsonRequestBody('UpdatePublicWorkItemRequest'),
      responses: {
        '200': jsonResponse('Work Item を更新しました。', schemaRef('WorkItem'), true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
    delete: {
      operationId: 'deletePublicWorkItem',
      tags: ['Work Items'],
      summary: 'Work Item を削除する',
      security: publicApiSecurity('work-items:delete'),
      parameters: [
        idPathParameter('workItemId', 'Work Item ID です。'),
        {
          name: 'teamId', in: 'query', required: true,
          description: 'Work Item を所有する Team ID です。',
          schema: { type: 'string' },
        },
        ...idempotencyParameters,
      ],
      requestBody: jsonRequestBody('DeletePublicWorkItemRequest'),
      responses: {
        '204': emptyResponse('Work Item を削除しました。', true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/v1/work-items/{workItemId}/external-links': {
    get: {
      operationId: 'listPublicExternalWorkItemLinks',
      tags: ['External Links'],
      summary: 'Work Item の外部 resource link を取得する',
      security: publicApiSecurity('work-items:read', 'integrations:read'),
      parameters: [
        idPathParameter('workItemId', 'Work Item ID です。'),
        {
          name: 'teamId', in: 'query', required: true,
          description: 'Work Item を所有する Team ID です。',
          schema: { type: 'string' },
        },
        ...publicCursorParameters,
      ],
      responses: {
        '200': jsonResponse(
          'External Work Item link page です。',
          cursorPageSchema('ExternalWorkItemLink'),
        ),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
    post: {
      operationId: 'createPublicExternalWorkItemLink',
      tags: ['External Links'],
      summary: 'Work Item と外部 resource を link する',
      security: publicApiSecurity('work-items:write', 'integrations:write'),
      parameters: [
        idPathParameter('workItemId', 'Work Item ID です。'),
        {
          name: 'teamId', in: 'query', required: true,
          description: 'Work Item を所有する Team ID です。',
          schema: { type: 'string' },
        },
        ...idempotencyParameters,
      ],
      requestBody: jsonRequestBody('CreatePublicExternalWorkItemLinkInput'),
      responses: {
        '201': jsonResponse(
          'External Work Item link を作成しました。',
          schemaRef('ExternalWorkItemLink'),
          true,
        ),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/v1/work-items/{workItemId}/external-links/{externalLinkId}': {
    delete: {
      operationId: 'deletePublicExternalWorkItemLink',
      tags: ['External Links'],
      summary: 'Work Item の外部 resource link を削除する',
      security: publicApiSecurity('work-items:write', 'integrations:write'),
      parameters: [
        idPathParameter('workItemId', 'Work Item ID です。'),
        idPathParameter('externalLinkId', 'External Work Item link ID です。'),
        {
          name: 'teamId', in: 'query', required: true,
          description: 'Work Item を所有する Team ID です。',
          schema: { type: 'string' },
        },
        ...idempotencyParameters,
      ],
      responses: {
        '204': emptyResponse('External Work Item link を削除しました。', true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/developer': {
    get: {
      operationId: 'getDeveloperPlatformOverview',
      tags: ['Developer Management'],
      summary: 'Developer settings overview を取得する',
      security: sessionSecurity,
      responses: {
        '200': jsonResponse('Developer settings overview です。', schemaRef('DeveloperPlatformOverview')),
        ...problemResponses,
      },
    },
  },
  '/api/developer/api-keys': {
    get: {
      operationId: 'listManagedApiKeys',
      tags: ['API Key Management'],
      summary: 'API key metadata を取得する',
      security: sessionSecurity,
      parameters: cursorParameters,
      responses: {
        '200': jsonResponse('API key metadata page です。', cursorPageSchema('ApiKeySummary')),
        ...problemResponses,
      },
    },
    post: {
      operationId: 'createManagedApiKey',
      tags: ['API Key Management'],
      summary: 'API key を作成する',
      description: '平文 secret はこの response で一度だけ返します。',
      security: sessionSecurity,
      parameters: idempotencyParameters,
      requestBody: jsonRequestBody('CreateApiKeyInput'),
      responses: {
        '201': secretJsonResponse('API key と一度限りの secret です。', schemaRef('ApiKeyOneTimeSecretOutput'), true),
        ...problemResponses,
      },
    },
  },
  '/api/developer/api-keys/{apiKeyId}': {
    get: {
      operationId: 'getManagedApiKey',
      tags: ['API Key Management'],
      summary: 'API key metadata を取得する',
      security: sessionSecurity,
      parameters: [idPathParameter('apiKeyId', 'API key resource ID です。')],
      responses: {
        '200': jsonResponse('API key metadata です。', schemaRef('ApiKeySummary')),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
    delete: {
      operationId: 'revokeManagedApiKey',
      tags: ['API Key Management'],
      summary: 'API key を revoke する',
      security: sessionSecurity,
      parameters: [idPathParameter('apiKeyId', 'API key resource ID です。'), ...idempotencyParameters],
      responses: {
        '200': jsonResponse('Revoke 済み API key metadata です。', schemaRef('ApiKeySummary'), true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/developer/api-keys/{apiKeyId}/rotate': {
    post: {
      operationId: 'rotateManagedApiKey',
      tags: ['API Key Management'],
      summary: 'API key secret を rotation する',
      description: '旧 key を失効し、新しい平文 secret をこの response で一度だけ返します。',
      security: sessionSecurity,
      parameters: [idPathParameter('apiKeyId', 'API key resource ID です。'), ...idempotencyParameters],
      requestBody: {
        required: false,
        content: {
          'application/json': { schema: schemaRef('RotateApiKeyInput') },
        },
      },
      responses: {
        '200': secretJsonResponse('Rotation 後の API key と一度限りの secret です。', schemaRef('ApiKeyOneTimeSecretOutput'), true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/developer/oauth-apps': {
    get: {
      operationId: 'listManagedOAuthApps',
      tags: ['OAuth App Management'],
      summary: 'OAuth app metadata を取得する',
      security: sessionSecurity,
      parameters: cursorParameters,
      responses: {
        '200': jsonResponse('OAuth app metadata page です。', cursorPageSchema('OAuthAppSummary')),
        ...problemResponses,
      },
    },
    post: {
      operationId: 'createManagedOAuthApp',
      tags: ['OAuth App Management'],
      summary: 'OAuth app を作成する',
      description: '平文 client secret はこの response で一度だけ返します。',
      security: sessionSecurity,
      parameters: idempotencyParameters,
      requestBody: jsonRequestBody('CreateOAuthAppInput'),
      responses: {
        '201': secretJsonResponse('OAuth app と一度限りの client secret です。', schemaRef('OAuthAppOneTimeSecretOutput'), true),
        ...problemResponses,
      },
    },
  },
  '/api/developer/oauth-apps/{oauthAppId}': {
    get: {
      operationId: 'getManagedOAuthApp',
      tags: ['OAuth App Management'],
      summary: 'OAuth app metadata を取得する',
      security: sessionSecurity,
      parameters: [idPathParameter('oauthAppId', 'OAuth app resource ID です。')],
      responses: {
        '200': jsonResponse('OAuth app metadata です。', schemaRef('OAuthAppSummary')),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
    delete: {
      operationId: 'revokeManagedOAuthApp',
      tags: ['OAuth App Management'],
      summary: 'OAuth app credential を revoke する',
      security: sessionSecurity,
      parameters: [idPathParameter('oauthAppId', 'OAuth app resource ID です。'), ...idempotencyParameters],
      responses: {
        '200': jsonResponse('Revoke 済み OAuth app metadata です。', schemaRef('OAuthAppSummary'), true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/developer/oauth-apps/{oauthAppId}/rotate-secret': {
    post: {
      operationId: 'rotateManagedOAuthAppSecret',
      tags: ['OAuth App Management'],
      summary: 'OAuth client secret を rotation する',
      description: '旧 secret を失効し、新しい平文 secret をこの response で一度だけ返します。',
      security: sessionSecurity,
      parameters: [idPathParameter('oauthAppId', 'OAuth app resource ID です。'), ...idempotencyParameters],
      responses: {
        '200': secretJsonResponse('OAuth app と一度限りの client secret です。', schemaRef('OAuthAppOneTimeSecretOutput'), true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/developer/webhook-subscriptions': {
    get: {
      operationId: 'listManagedWebhookSubscriptions',
      tags: ['Webhook Management'],
      summary: 'Webhook subscription を取得する',
      security: sessionSecurity,
      parameters: cursorParameters,
      responses: {
        '200': jsonResponse('Webhook subscription page です。', cursorPageSchema('WebhookSubscription')),
        ...problemResponses,
      },
    },
    post: {
      operationId: 'createManagedWebhookSubscription',
      tags: ['Webhook Management'],
      summary: 'Webhook subscription を作成する',
      description: 'Signing secret はこの response で一度だけ返します。',
      security: sessionSecurity,
      parameters: idempotencyParameters,
      requestBody: jsonRequestBody('CreateWebhookSubscriptionInput'),
      responses: {
        '201': secretJsonResponse('Webhook subscription と一度限りの signing secret です。', schemaRef('WebhookSubscriptionSecretOutput'), true),
        ...problemResponses,
      },
    },
  },
  '/api/developer/webhook-subscriptions/{webhookSubscriptionId}': {
    get: {
      operationId: 'getManagedWebhookSubscription',
      tags: ['Webhook Management'],
      summary: 'Webhook subscription を取得する',
      security: sessionSecurity,
      parameters: [idPathParameter('webhookSubscriptionId', 'Webhook subscription ID です。')],
      responses: {
        '200': jsonResponse('Webhook subscription です。', schemaRef('WebhookSubscription')),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
    patch: {
      operationId: 'updateManagedWebhookSubscription',
      tags: ['Webhook Management'],
      summary: 'Webhook subscription の metadata または配信状態を更新する',
      security: sessionSecurity,
      parameters: [idPathParameter('webhookSubscriptionId', 'Webhook subscription ID です。'), ...idempotencyParameters],
      requestBody: jsonRequestBody('UpdateWebhookSubscriptionInput'),
      responses: {
        '200': jsonResponse('更新した webhook subscription です。', schemaRef('WebhookSubscription'), true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
    delete: {
      operationId: 'deleteManagedWebhookSubscription',
      tags: ['Webhook Management'],
      summary: 'Webhook subscription を無効化する',
      security: sessionSecurity,
      parameters: [idPathParameter('webhookSubscriptionId', 'Webhook subscription ID です。'), ...idempotencyParameters],
      responses: {
        '204': emptyResponse('Webhook subscription を無効化しました。', true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/developer/webhook-subscriptions/{webhookSubscriptionId}/rotate-secret': {
    post: {
      operationId: 'rotateManagedWebhookSigningSecret',
      tags: ['Webhook Management'],
      summary: 'Webhook signing secret を rotation する',
      security: sessionSecurity,
      parameters: [idPathParameter('webhookSubscriptionId', 'Webhook subscription ID です。'), ...idempotencyParameters],
      responses: {
        '200': secretJsonResponse('Webhook subscription と一度限りの signing secret です。', schemaRef('WebhookSubscriptionSecretOutput'), true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/developer/webhook-deliveries': {
    get: {
      operationId: 'listManagedWebhookDeliveries',
      tags: ['Webhook Management'],
      summary: 'Webhook delivery log を取得する',
      security: sessionSecurity,
      parameters: [
        {
          name: 'subscriptionId', in: 'query',
          description: 'Webhook subscription ID filter です。',
          schema: { type: 'string' },
        },
        ...cursorParameters,
      ],
      responses: {
        '200': jsonResponse('Webhook delivery page です。', cursorPageSchema('WebhookDelivery')),
        ...problemResponses,
      },
    },
  },
  '/api/developer/webhook-deliveries/{webhookDeliveryId}': {
    get: {
      operationId: 'getManagedWebhookDelivery',
      tags: ['Webhook Management'],
      summary: 'Webhook delivery log を取得する',
      security: sessionSecurity,
      parameters: [idPathParameter('webhookDeliveryId', 'Webhook delivery ID です。')],
      responses: {
        '200': jsonResponse('Webhook delivery log です。', schemaRef('WebhookDelivery')),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/developer/webhook-deliveries/{webhookDeliveryId}/replay': {
    post: {
      operationId: 'replayManagedWebhookDelivery',
      tags: ['Webhook Management'],
      summary: 'Webhook delivery を同じ event ID で replay する',
      security: sessionSecurity,
      parameters: [idPathParameter('webhookDeliveryId', 'Webhook delivery ID です。'), ...idempotencyParameters],
      responses: {
        '202': jsonResponse('Replay を queue に追加しました。', schemaRef('WebhookDelivery'), true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/developer/connectors': {
    get: {
      operationId: 'listManagedConnectorCatalog',
      tags: ['Connector Management'],
      summary: '利用可能な connector catalog を取得する',
      security: sessionSecurity,
      parameters: [
        {
          name: 'category', in: 'query',
          description: 'Connector category filter です。',
          schema: {
            type: 'string',
            enum: ['source-control', 'chat', 'email', 'calendar', 'cloud-storage'],
          },
        },
      ],
      responses: {
        '200': jsonResponse('Connector catalog です。', {
          type: 'array', items: schemaRef('ConnectorDefinition'),
        }),
        ...problemResponses,
      },
    },
  },
  '/api/developer/connector-oauth/callback': {
    get: {
      operationId: 'completeManagedConnectorOAuthCallback',
      tags: ['Connector Management'],
      summary: 'Provider OAuth callback を完了する',
      description:
        'HMAC 署名済み single-use state と PKCE code を検証し、検証済み application-relative URL へ戻します。',
      security: [],
      parameters: [
        {
          name: 'code', in: 'query',
          description: 'Provider authorization code です。error 時は省略します。',
          schema: { type: 'string', maxLength: 8192 },
        },
        {
          name: 'state', in: 'query', required: true,
          description: 'Authorization 開始時に発行した signed state です。',
          schema: { type: 'string', maxLength: 2048 },
        },
        {
          name: 'error', in: 'query',
          description: 'Provider が認可を完了しなかった場合の OAuth error です。',
          schema: { type: 'string', maxLength: 256 },
        },
      ],
      responses: {
        '303': {
          description: 'Connector settings の検証済み return URL へ戻します。',
          headers: {
            ...rateLimitHeaders,
            Location: { schema: { type: 'string' } },
            'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
            'Referrer-Policy': { schema: { type: 'string', enum: ['no-referrer'] } },
          },
        },
        ...problemResponses,
      },
    },
  },
  '/api/developer/connector-installations': {
    get: {
      operationId: 'listManagedConnectorInstallations',
      tags: ['Connector Management'],
      summary: 'Connector installation を取得する',
      security: sessionSecurity,
      parameters: [
        {
          name: 'status', in: 'query',
          description: 'Connector status filter です。',
          schema: {
            type: 'string',
            enum: ['connected', 'needs-reauth', 'degraded', 'disconnected', 'conflict'],
          },
        },
        ...cursorParameters,
      ],
      responses: {
        '200': jsonResponse('Connector installation page です。', cursorPageSchema('ConnectorInstallation')),
        ...problemResponses,
      },
    },
    post: {
      operationId: 'createManagedConnectorInstallation',
      tags: ['Connector Management'],
      summary: 'Connector authorization flow を開始する',
      security: sessionSecurity,
      parameters: idempotencyParameters,
      requestBody: jsonRequestBody('CreateConnectorInstallationInput'),
      responses: {
        '201': jsonResponse('Connector authorization flow です。', schemaRef('ConnectorAuthorizationOutput'), true),
        ...problemResponses,
      },
    },
  },
  '/api/developer/connector-installations/{connectorInstallationId}': {
    get: {
      operationId: 'getManagedConnectorInstallation',
      tags: ['Connector Management'],
      summary: 'Connector installation を取得する',
      security: sessionSecurity,
      parameters: [idPathParameter('connectorInstallationId', 'Connector installation ID です。')],
      responses: {
        '200': jsonResponse('Connector installation です。', schemaRef('ConnectorInstallation')),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
    delete: {
      operationId: 'disconnectManagedConnectorInstallation',
      tags: ['Connector Management'],
      summary: 'Connector installation を切断する',
      security: sessionSecurity,
      parameters: [idPathParameter('connectorInstallationId', 'Connector installation ID です。'), ...idempotencyParameters],
      responses: {
        '200': jsonResponse('切断した connector installation です。', schemaRef('ConnectorInstallation'), true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/developer/connector-installations/{connectorInstallationId}/reauthorize': {
    post: {
      operationId: 'reauthorizeManagedConnectorInstallation',
      tags: ['Connector Management'],
      summary: 'Connector 再認証 flow を開始する',
      security: sessionSecurity,
      parameters: [idPathParameter('connectorInstallationId', 'Connector installation ID です。'), ...idempotencyParameters],
      responses: {
        '200': jsonResponse('Connector 再認証 flow です。', schemaRef('ConnectorAuthorizationOutput'), true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/developer/work-items/{workItemId}/external-links': {
    get: {
      operationId: 'listManagedExternalWorkItemLinks',
      tags: ['External Link Management'],
      summary: 'Work Item の外部 link を取得する',
      security: sessionSecurity,
      parameters: [
        idPathParameter('workItemId', 'Work Item ID です。'),
        {
          name: 'teamId', in: 'query', required: true,
          description: 'Work Item を所有する Team ID です。',
          schema: { type: 'string' },
        },
        {
          name: 'installationId', in: 'query',
          description: 'Connector installation ID filter です。',
          schema: { type: 'string' },
        },
        ...cursorParameters,
      ],
      responses: {
        '200': jsonResponse('External Work Item link page です。', cursorPageSchema('ExternalWorkItemLink')),
        ...problemResponses,
      },
    },
    post: {
      operationId: 'createManagedExternalWorkItemLink',
      tags: ['External Link Management'],
      summary: 'Work Item と外部 resource を link する',
      security: sessionSecurity,
      parameters: [idPathParameter('workItemId', 'Work Item ID です。'), ...idempotencyParameters],
      requestBody: jsonRequestBody('CreateExternalWorkItemLinkInput'),
      responses: {
        '201': jsonResponse('作成した external Work Item link です。', schemaRef('ExternalWorkItemLink'), true),
        ...problemResponses,
      },
    },
  },
  '/api/developer/external-links/{externalLinkId}': {
    get: {
      operationId: 'getManagedExternalWorkItemLink',
      tags: ['External Link Management'],
      summary: '外部 Work Item link を取得する',
      security: sessionSecurity,
      parameters: [idPathParameter('externalLinkId', 'External Work Item link ID です。')],
      responses: {
        '200': jsonResponse('External Work Item link です。', schemaRef('ExternalWorkItemLink')),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
    patch: {
      operationId: 'updateManagedExternalWorkItemLink',
      tags: ['External Link Management'],
      summary: '外部 Work Item link の同期方向を更新する',
      security: sessionSecurity,
      parameters: [idPathParameter('externalLinkId', 'External Work Item link ID です。'), ...idempotencyParameters],
      requestBody: jsonRequestBody('UpdateExternalWorkItemLinkInput'),
      responses: {
        '200': jsonResponse('更新した External Work Item link です。', schemaRef('ExternalWorkItemLink'), true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
    delete: {
      operationId: 'deleteManagedExternalWorkItemLink',
      tags: ['External Link Management'],
      summary: '外部 Work Item link を削除する',
      security: sessionSecurity,
      parameters: [
        idPathParameter('externalLinkId', 'External Work Item link ID です。'),
        {
          name: 'teamId', in: 'query', required: true,
          description: 'External link が属する Team ID です。',
          schema: { type: 'string' },
        },
        {
          name: 'workItemId', in: 'query', required: true,
          description: 'External link が属する Work Item ID です。',
          schema: { type: 'string' },
        },
        ...idempotencyParameters,
      ],
      responses: {
        '204': emptyResponse('External Work Item link を削除しました。', true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/developer/sync-conflicts': {
    get: {
      operationId: 'listManagedWorkItemSyncConflicts',
      tags: ['External Link Management'],
      summary: 'Work Item の同期競合を取得する',
      security: sessionSecurity,
      parameters: [
        {
          name: 'status', in: 'query',
          description: 'Sync conflict status filter です。',
          schema: {
            type: 'string',
            enum: ['open', 'resolved', 'ignored'],
          },
        },
        ...cursorParameters,
      ],
      responses: {
        '200': jsonResponse('Work Item sync conflict page です。', cursorPageSchema('WorkItemSyncConflict')),
        ...problemResponses,
      },
    },
  },
  '/api/developer/sync-conflicts/{conflictId}/resolve': {
    post: {
      operationId: 'resolveManagedWorkItemSyncConflict',
      tags: ['External Link Management'],
      summary: 'Work Item の同期競合を解決する',
      security: sessionSecurity,
      parameters: [
        idPathParameter('conflictId', 'Work Item sync conflict ID です。'),
        ...idempotencyParameters,
      ],
      requestBody: jsonRequestBody('ResolveWorkItemSyncConflictInput'),
      responses: {
        '200': jsonResponse('解決後の Work Item sync conflict です。', schemaRef('WorkItemSyncConflict'), true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/developer/imports/dry-run': {
    post: {
      operationId: 'dryRunManagedWorkItemImport',
      tags: ['Import and Export'],
      summary: 'Work Item import を保存せず検証する',
      security: sessionSecurity,
      parameters: idempotencyParameters,
      requestBody: jsonRequestBody('CreateImportInput'),
      responses: {
        '200': jsonResponse('Import mapping と row validation report です。', schemaRef('ImportDryRunReport'), true),
        ...problemResponses,
      },
    },
  },
  '/api/developer/imports': {
    get: {
      operationId: 'listManagedWorkItemImports',
      tags: ['Import and Export'],
      summary: 'Work Item import job を取得する',
      security: sessionSecurity,
      parameters: cursorParameters,
      responses: {
        '200': jsonResponse('Import job page です。', cursorPageSchema('ImportJob')),
        ...problemResponses,
      },
    },
    post: {
      operationId: 'createManagedWorkItemImport',
      tags: ['Import and Export'],
      summary: '検証済み source から非同期 Work Item import を開始する',
      description: 'Source 全体を再送し、現在の管理権限を確認して durable job を queue します。Row と設定の再検証は Worker が current RBAC で実行します。',
      security: sessionSecurity,
      parameters: idempotencyParameters,
      requestBody: jsonRequestBody('CreateImportInput'),
      responses: {
        '202': jsonResponse('Queue 済み import job です。', schemaRef('ImportJob'), true),
        ...problemResponses,
      },
    },
  },
  '/api/developer/imports/{importJobId}': {
    get: {
      operationId: 'getManagedWorkItemImport',
      tags: ['Import and Export'],
      summary: 'Work Item import job を取得する',
      security: sessionSecurity,
      parameters: [idPathParameter('importJobId', 'Import job ID です。')],
      responses: {
        '200': jsonResponse('Import job です。', schemaRef('ImportJob')),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
    delete: {
      operationId: 'cancelManagedWorkItemImport',
      tags: ['Import and Export'],
      summary: '未完了の Work Item import job を cancel する',
      security: sessionSecurity,
      parameters: [idPathParameter('importJobId', 'Import job ID です。'), ...idempotencyParameters],
      responses: {
        '200': jsonResponse('Cancel 済み import job です。', schemaRef('ImportJob'), true),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/developer/imports/{importJobId}/report': {
    get: {
      operationId: 'getManagedWorkItemImportReport',
      tags: ['Import and Export'],
      summary: 'Work Item import error report を取得する',
      security: sessionSecurity,
      parameters: [idPathParameter('importJobId', 'Import job ID です.')],
      responses: {
        '200': jsonResponse('Import validation と error report です。', schemaRef('ImportReport')),
        ...notFoundResponse,
        ...problemResponses,
      },
    },
  },
  '/api/developer/exports': {
    get: {
      operationId: 'listManagedWorkItemExportPage',
      tags: ['Import and Export'],
      summary: '閲覧可能な Work Item の bounded export page を取得する',
      security: sessionSecurity,
      parameters: [
        {
          name: 'format',
          in: 'query',
          description: 'UI が page を集約して生成する download file の形式です。',
          schema: { type: 'string', enum: ['csv', 'json'], default: 'csv' },
        },
        ...publicCursorParameters,
      ],
      responses: {
        '200': jsonResponse(
          'RBAC で閲覧可能な Work Item の bounded export page です。',
          schemaRef('PublicWorkItemPage'),
        ),
        ...problemResponses,
      },
    },
  },
} as const

/**
 * Public REST API の major version です。
 */
export const PUBLIC_API_VERSION = 'v1' as const

/**
 * OpenAPI document を取得する公開 endpoint です。
 */
export const PUBLIC_API_OPENAPI_PATH = '/api/v1/openapi.json' as const

/**
 * Public API と developer management API の OpenAPI 3.1 document です。
 */
export const PUBLIC_API_OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: {
    title: 'mukuroji Public API',
    version: '1.0.0-alpha.1',
    description: [
      'Versioned Work Item API と developer platform management API です。',
      'Credential scope と Workspace RBAC permission の積集合で認可します。',
      'Mutation は Idempotency-Key を必須とし、全 response に rate-limit headers を返します。',
    ].join('\n\n'),
  },
  servers: [{ url: '/', description: 'Current mukuroji deployment' }],
  tags: [
    { name: 'Schema', description: 'SDK generation 用 schema' },
    { name: 'OAuth', description: 'OAuth token exchange' },
    { name: 'Work Items', description: 'Versioned public Work Item API' },
    { name: 'Developer Management', description: 'Developer settings overview' },
    { name: 'API Key Management', description: 'Scoped API key lifecycle' },
    { name: 'OAuth App Management', description: 'OAuth app lifecycle' },
    { name: 'Webhook Management', description: 'Signed webhook と delivery replay' },
    { name: 'Connector Management', description: 'Connector installation と recovery' },
    { name: 'External Link Management', description: 'External Work Item link と sync conflict' },
    { name: 'Import and Export', description: 'CSV/JSON transfer job' },
  ],
  security: [{ ApiKeyAuth: [] }, { OAuth2: [] }],
  paths,
  components,
  externalDocs: {
    description: 'Public API 運用ガイド',
    url: 'https://github.com/mnmn0/mukuroji/blob/main/docs/public-api.md',
  },
} as const

/**
 * Camel case を利用する consumer 向け OpenAPI document alias です。
 */
export const publicApiOpenApiDocument = PUBLIC_API_OPENAPI_DOCUMENT
