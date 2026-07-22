import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  createAnalyticsQueryInput,
  createCyclePlanningInput,
  createNotificationItem,
  createNotificationVisibilityProbe,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()
import {
  InMemoryAnalyticsRepository,
} from '../../../analytics/analytics'
import {
  resolveDocumentCapabilities,
} from '../../../documents/document-access'
import type {
  DocumentClient,
} from '../../../documents/documents'
import {
  DocumentError,
} from '../../../documents/documents'
import type {
  NotificationItem,
} from '../../../notifications/notifications'
import {
  InMemoryPlanningClient,
} from '../../../planning/planning'
import {
  createWorkspaceSearchDocument,
} from '../../../workspace-search/workspace-search'
import type {
  WorkspaceSearchClient,
} from '../../../workspace-search/workspace-search'
import {
  InMemoryEnterpriseIdentityClient,
} from '../../enterprise-identity'
import type {
  AnalyticsSnapshot,
  DocumentDetail,
  PlanningSnapshot,
} from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'
import {
  createHash,
} from 'node:crypto'

afterEach(() => {
  resetTestApp()
})

test('applies a directory-mapped custom role to only its assigned Project APIs', async () => {
  await withTestEnvironment({
    COGNITO_CLIENT_ID: 'mukuroji-main-client',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
  }, async () => {
  configureFakeProjectClients(true, {
    workspaceRole: 'member',
    projectAccesses: [{ projectId: 'private-project', role: 'manager' }],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'private-project', name: 'Private', tone: 'purple' },
    ],
    teamIssueCount: 2,
    inaccessibleTeamIssueCount: 1,
  })
  const workspaceId = 'user#demo@example.com'
  const identity = new InMemoryEnterpriseIdentityClient()
  const now = new Date().toISOString()
  await identity.putIdentityProvider({
    workspaceId,
    providerId: 'idp-project-role',
    kind: 'oidc',
    displayName: 'Project directory',
    cognitoProviderName: 'EnterpriseOidc',
    status: 'active',
    revision: 1,
    issuer: 'https://idp.example.com',
    clientId: 'enterprise-client',
    authorizationEndpoint: 'https://idp.example.com/authorize',
    tokenEndpoint: 'https://idp.example.com/token',
    jwksUri: 'https://idp.example.com/jwks',
    scopes: ['openid', 'email'],
    createdAt: now,
    updatedAt: now,
    lastTestedAt: now,
  })
  await identity.putCustomRole({
    workspaceId,
    roleId: 'custom:project-reader',
    name: 'Project reader',
    permissions: ['projects.read', 'work-items.read', 'automation.manage'],
    guestAssignable: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  const user = await identity.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-project-role',
    externalId: 'demo-user',
    userName: 'demo@example.com',
    emails: ['demo@example.com'],
    active: true,
    linkedMemberKey: 'demo@example.com',
    idempotencyKey: 'project-reader-user',
  })
  const group = await identity.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-project-role',
    externalId: 'project-readers',
    displayName: 'Project readers',
    active: true,
    memberUserIds: [user.userId],
    idempotencyKey: 'project-reader-group',
  })
  const desiredUser = (await identity.getSnapshot(workspaceId)).scimUsers.find((candidate) =>
    candidate.userId === user.userId
  )
  if (!desiredUser) throw new Error('Expected the SCIM user to exist.')
  await identity.markScimUserApplied(
    workspaceId,
    desiredUser.userId,
    desiredUser.version,
  )
  await identity.markScimGroupApplied(
    workspaceId,
    group.groupId,
    group.version,
  )
  await identity.putGroupMapping({
    workspaceId,
    mappingId: 'project-reader-mapping',
    identityProviderId: 'idp-project-role',
    directoryGroupId: group.groupId,
    roleId: 'custom:project-reader',
    scope: { workspaceId, kind: 'project', targetId: 'refero' },
    enabled: true,
    priority: 0,
    revision: 1,
    updatedAt: now,
  })
  await identity.putCustomRole({
    workspaceId,
    roleId: 'custom:team-project-creator',
    name: 'Team project creator',
    permissions: ['projects.write'],
    guestAssignable: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  await identity.putGroupMapping({
    workspaceId,
    mappingId: 'team-project-creator-mapping',
    identityProviderId: 'idp-project-role',
    directoryGroupId: group.groupId,
    roleId: 'custom:team-project-creator',
    scope: { workspaceId, kind: 'team', targetId: 'core-team' },
    enabled: true,
    priority: 1,
    revision: 1,
    updatedAt: now,
  })
  await identity.putCustomRole({
    workspaceId,
    roleId: 'custom:project-team-writer',
    name: 'Project-scoped Team writer',
    permissions: ['teams.write'],
    guestAssignable: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  await identity.putGroupMapping({
    workspaceId,
    mappingId: 'project-team-writer-mapping',
    identityProviderId: 'idp-project-role',
    directoryGroupId: group.groupId,
    roleId: 'custom:project-team-writer',
    scope: { workspaceId, kind: 'project', targetId: 'refero' },
    enabled: true,
    priority: 2,
    revision: 1,
    updatedAt: now,
  })
  await identity.putCustomRole({
    workspaceId,
    roleId: 'custom:project-planner',
    name: 'Project planner',
    permissions: ['planning.read', 'planning.write', 'automation.manage'],
    guestAssignable: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  await identity.putGroupMapping({
    workspaceId,
    mappingId: 'project-planner-mapping',
    identityProviderId: 'idp-project-role',
    directoryGroupId: group.groupId,
    roleId: 'custom:project-planner',
    scope: { workspaceId, kind: 'project', targetId: 'refero' },
    enabled: true,
    priority: 3,
    revision: 1,
    updatedAt: now,
  })
  await identity.putCustomRole({
    workspaceId,
    roleId: 'custom:service-account-manager',
    name: 'Service account manager',
    permissions: ['service-accounts.manage'],
    guestAssignable: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  await identity.putGroupMapping({
    workspaceId,
    mappingId: 'service-account-manager-mapping',
    identityProviderId: 'idp-project-role',
    directoryGroupId: group.groupId,
    roleId: 'custom:service-account-manager',
    scope: { workspaceId, kind: 'workspace' },
    enabled: true,
    priority: 4,
    revision: 1,
    updatedAt: now,
  })
  const analyticsRepository = new InMemoryAnalyticsRepository()
  const analyticsQuery = createAnalyticsQueryInput()
  const analyticsReport = await analyticsRepository.createReport(
    workspaceId,
    'demo@example.com',
    {
      id: 'enterprise-project-report',
      name: 'Enterprise Project report',
      visibility: 'team',
      teamId: 'core-team',
      timeZone: analyticsQuery.timeZone,
      filter: analyticsQuery.filter,
      widgets: analyticsQuery.widgets,
    },
  )
  const createEnterpriseDocument = (
    id: string,
    scope: DocumentDetail['scope'],
  ): DocumentDetail => ({
    schemaVersion: 1,
    id,
    kind: 'page',
    scope,
    title: id,
    position: 'a0',
    revision: 1,
    permission: { mode: 'inherit', memberGrants: [] },
    relations: [],
    favorite: false,
    capabilities: {
      canView: false,
      canEdit: false,
      canComment: false,
      canShare: false,
      canManagePermissions: false,
      canArchive: false,
      canRestore: false,
      canExport: false,
    },
    createdByUserId: 'demo@example.com',
    updatedByUserId: 'demo@example.com',
    createdAt: now,
    updatedAt: now,
    blocks: [],
  })
  const enterpriseDocuments = new Map([
    [
      'refero-document',
      createEnterpriseDocument(
        'refero-document',
        { type: 'project', projectId: 'refero' },
      ),
    ],
    [
      'private-project-document',
      createEnterpriseDocument(
        'private-project-document',
        { type: 'project', projectId: 'private-project' },
      ),
    ],
    [
      'workspace-document',
      createEnterpriseDocument(
        'workspace-document',
        { type: 'workspace' },
      ),
    ],
  ])
  const documentAccesses: Array<
    Parameters<DocumentClient['get']>[0]['access']
  > = []
  const documentSearchAccesses: Array<
    Parameters<
      DocumentClient['resolveSearchAccess']
    >[0]['access']
  > = []
  const documentSearchVisibilities =
    new Map<string, boolean>()
  const resolveEnterpriseDocumentForAccess = (
    documentId: string,
    access:
      Parameters<DocumentClient['get']>[0]['access'],
  ) => {
    const document =
      enterpriseDocuments.get(documentId)
    if (!document) {
      throw new DocumentError(
        404,
        'DocumentNotFound',
        'Document was not found.',
      )
    }
    const capabilities =
      resolveDocumentCapabilities({
        principal: {
          memberKey: access.memberKey,
          workspaceRole:
            access.workspaceRole,
          isSystemAdmin:
            access.isSystemAdmin ?? false,
        },
        document,
        projectRole:
          document.scope.type === 'project'
            ? access.projectRoles?.[
                document.scope.projectId
              ] ?? access.projectRole
            : undefined,
        restrictToAuthorizedScopes:
          access.restrictToAuthorizedScopes,
        workspaceScopeRole:
          access.workspaceScopeRole,
      })
    if (!capabilities.canView) {
      throw new DocumentError(
        404,
        'DocumentNotFound',
        'Document was not found.',
      )
    }
    return { ...document, capabilities }
  }
  const documentNotifications = [
    createNotificationItem({
      id: 'refero-document-notification',
      eventId:
        'refero-document-notification-event',
      eventType: 'document.comment.created',
      entityId: 'refero-document',
      reasons: ['mention'],
      teamId: undefined,
      projectId: undefined,
      issueId: undefined,
    }),
    createNotificationItem({
      id:
        'private-project-document-notification',
      eventId:
        'private-project-document-notification-event',
      eventType: 'document.comment.created',
      entityId: 'private-project-document',
      reasons: ['mention'],
      teamId: undefined,
      projectId: undefined,
      issueId: undefined,
    }),
    createNotificationItem({
      id: 'workspace-document-notification',
      eventId:
        'workspace-document-notification-event',
      eventType: 'document.comment.created',
      entityId: 'workspace-document',
      reasons: ['mention'],
      teamId: undefined,
      projectId: undefined,
      issueId: undefined,
    }),
    createNotificationItem({
      id: 'missing-document-id-notification',
      eventId:
        'missing-document-id-notification-event',
      eventType: 'document.comment.created',
      entityId: undefined,
      reasons: ['mention'],
      teamId: undefined,
      projectId: undefined,
      issueId: undefined,
    }),
  ]
  const documentNotificationProbe =
    createNotificationVisibilityProbe(
      documentNotifications,
    )
  setTestAppDependencies({
    enterpriseIdentity: identity,
    planning: new InMemoryPlanningClient(),
    analytics: analyticsRepository,
    documents: {
      async get(input) {
        documentAccesses.push(input.access)
        return resolveEnterpriseDocumentForAccess(
          input.documentId,
          input.access,
        )
      },
      async resolveSearchAccess(input) {
        documentSearchAccesses.push(input.access)
        try {
          const document =
            resolveEnterpriseDocumentForAccess(
              input.documentId,
              input.access,
            )
          return {
            scope: document.scope,
            revision: document.revision,
            updatedAt: document.updatedAt,
            body: document.title,
          }
        } catch (error) {
          if (
            error instanceof DocumentError &&
            (
              error.status === 403 ||
              error.status === 404
            )
          ) {
            return undefined
          }
          throw error
        }
      },
    } as unknown as DocumentClient,
    notifications: documentNotificationProbe.client,
    workspaceSearch: {
      async upsertDocument(document) {
        return createWorkspaceSearchDocument(
          document,
        )
      },
      async search(input) {
        for (
          const documentId of
          enterpriseDocuments.keys()
        ) {
          const resolved =
            await input.resolveCurrentScope?.(
              createWorkspaceSearchDocument({
                workspaceId:
                  input.workspaceId,
                entityType: 'document',
                entityId: documentId,
                title: documentId,
                body: documentId,
                url:
                  `/documents/${documentId}`,
                updatedAt: now,
                sourceRevision: 1,
              }),
            )
          documentSearchVisibilities.set(
            documentId,
            resolved?.permissionVerified === true,
          )
        }
        return { schemaVersion: 1, results: [] }
      },
    } as unknown as WorkspaceSearchClient,
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query() {
        return { events: [] }
      },
    },
  })
  const authorization = `Bearer ${createAccessToken([], {
    client_id: 'mukuroji-main-client',
    token_use: 'access',
  })}`

  const allowed = await app.request('/api/projects/refero/tasks', {
    headers: { Authorization: authorization },
  })
  const denied = await app.request('/api/projects/private-project/tasks', {
    headers: { Authorization: authorization },
  })
  const documentsPermissionDenied = await app.request(
    '/api/documents/refero-document',
    { headers: { Authorization: authorization } },
  )
  await identity.putCustomRole({
    workspaceId,
    roleId: 'custom:project-document-reader',
    name: 'Project Document reader',
    permissions: ['documents.read'],
    guestAssignable: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  await identity.putGroupMapping({
    workspaceId,
    mappingId: 'project-document-reader-mapping',
    identityProviderId: 'idp-project-role',
    directoryGroupId: group.groupId,
    roleId: 'custom:project-document-reader',
    scope: {
      workspaceId,
      kind: 'project',
      targetId: 'refero',
    },
    enabled: true,
    priority: 50,
    revision: 1,
    updatedAt: now,
  })
  const allowedProjectDocument = await app.request(
    '/api/documents/refero-document',
    { headers: { Authorization: authorization } },
  )
  const deniedProjectDocument = await app.request(
    '/api/documents/private-project-document',
    { headers: { Authorization: authorization } },
  )
  const deniedWorkspaceDocument = await app.request(
    '/api/documents/workspace-document',
    { headers: { Authorization: authorization } },
  )
  const documentSearchResponse = await app.request(
    '/api/search',
    { headers: { Authorization: authorization } },
  )
  const documentNotificationsResponse =
    await app.request(
      '/api/notifications',
      { headers: { Authorization: authorization } },
    )
  const directoryResponse = await app.request('/api/teams/projects', {
    headers: { Authorization: authorization },
  })
  const projectCreateResponse = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Scoped project', tone: 'green' }),
  })
  const teamCreateResponse = await app.request('/api/teams', {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Escaped Team' }),
  })
  const projectUserCandidatesResponse = await app.request('/api/projects/refero/users', {
    headers: { Authorization: authorization },
  })
  const planningCreateResponse = await app.request('/api/planning/entities', {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: 'scoped-plan',
      type: 'portfolio',
      title: 'Scoped plan',
      teamId: 'core-team',
      projectId: 'refero',
      ownerMemberKey: 'demo@example.com',
      status: 'planned',
      health: 'on-track',
      risk: 'low',
      progressMode: 'manual',
      manualProgress: 0,
      baseline: { startDate: '2026-07-01', endDate: '2026-07-31' },
      forecast: { startDate: '2026-07-01', endDate: '2026-07-31' },
      expectedRevision: 0,
    }),
  })
  const planningArchiveResponse = await app.request(
    '/api/planning/entities/scoped-plan/archive',
    {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedRevision: 1 }),
    },
  )
  const breakGlassAccountResponse = await app.request(
    '/api/enterprise/security/break-glass/accounts',
    {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: 'demo@example.com' }),
    },
  )
  const breakGlassDeactivateResponse = await app.request(
    '/api/enterprise/security/break-glass/deactivate',
    {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        administratorId: 'recovery-demo',
        expectedVersion: 1,
      }),
    },
  )
  const enterpriseAnalyticsRequest = (
    path: string,
    body: unknown,
    method = 'POST',
  ) => app.request(path, {
    method,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const analyticsQueryResponse = await enterpriseAnalyticsRequest(
    '/api/analytics/query',
    analyticsQuery,
  )
  expect(analyticsQueryResponse.status).toBe(200)
  const analyticsQueryBody = await analyticsQueryResponse.json() as {
    snapshot: AnalyticsSnapshot
  }
  expect(analyticsQueryBody.snapshot.widgets).toEqual([
    expect.objectContaining({ sampleSize: 1, value: 1 }),
  ])
  const analyticsEvidenceResponse = await enterpriseAnalyticsRequest(
    '/api/analytics/evidence',
    {
      metric: 'wip',
      filter: analyticsQuery.filter,
      asOf: analyticsQuery.asOf,
      timeZone: analyticsQuery.timeZone,
    },
  )
  const analyticsReportsResponse = await app.request('/api/analytics/reports', {
    headers: { Authorization: authorization },
  })
  await analyticsRepository.putSnapshot({
    id: 'enterprise-project-snapshot',
    workspaceId,
    reportId: analyticsReport.id,
    reportRevision: analyticsReport.revision,
    createdByMemberKey: 'demo@example.com',
    createdAt: analyticsQuery.asOf,
    query: analyticsQuery,
    snapshot: analyticsQueryBody.snapshot,
  })
  const analyticsSnapshotsResponse = await app.request(
    `/api/analytics/reports/${analyticsReport.id}/snapshots`,
    { headers: { Authorization: authorization } },
  )
  const analyticsExportResponse = await enterpriseAnalyticsRequest(
    '/api/analytics/export',
    { snapshotId: 'enterprise-project-snapshot', format: 'csv' },
  )
  const deniedAnalyticsWrites = [
    await enterpriseAnalyticsRequest('/api/analytics/reports', {
      id: 'denied-enterprise-report',
      name: 'Denied Enterprise report',
      visibility: 'personal',
      timeZone: analyticsQuery.timeZone,
      filter: analyticsQuery.filter,
      widgets: analyticsQuery.widgets,
    }),
    await enterpriseAnalyticsRequest(
      `/api/analytics/reports/${analyticsReport.id}`,
      { expectedRevision: analyticsReport.revision, name: 'Denied update' },
      'PATCH',
    ),
    await enterpriseAnalyticsRequest(
      `/api/analytics/reports/${analyticsReport.id}`,
      { expectedRevision: analyticsReport.revision },
      'DELETE',
    ),
    await enterpriseAnalyticsRequest(
      `/api/analytics/reports/${analyticsReport.id}/snapshots`,
      analyticsQuery,
    ),
  ]

  expect(allowed.status).toBe(200)
  expect(denied.status).toBe(403)
  expect(documentsPermissionDenied.status).toBe(403)
  expect(await documentsPermissionDenied.json())
    .toMatchObject({
      code: 'WorkspacePermissionDenied',
    })
  expect(allowedProjectDocument.status).toBe(200)
  expect(await allowedProjectDocument.json())
    .toMatchObject({
      document: {
        id: 'refero-document',
        capabilities: {
          canView: true,
          canEdit: false,
        },
      },
    })
  expect(deniedProjectDocument.status).toBe(404)
  expect(await deniedProjectDocument.json())
    .toMatchObject({ code: 'DocumentNotFound' })
  expect(deniedWorkspaceDocument.status).toBe(404)
  expect(await deniedWorkspaceDocument.json())
    .toMatchObject({ code: 'DocumentNotFound' })
  expect(documentSearchResponse.status).toBe(200)
  expect(documentSearchVisibilities).toEqual(
    new Map([
      ['refero-document', true],
      ['private-project-document', false],
      ['workspace-document', false],
    ]),
  )
  expect(documentNotificationsResponse.status).toBe(200)
  expect(
    (
      await documentNotificationsResponse.json() as {
        notifications: NotificationItem[]
      }
    ).notifications.map(({ entityId }) => entityId),
  ).toEqual(['refero-document'])
  expect(documentNotificationProbe.visibility)
    .toEqual(new Map([
      ['refero-document-notification', true],
      [
        'private-project-document-notification',
        false,
      ],
      ['workspace-document-notification', false],
      ['missing-document-id-notification', false],
    ]))
  expect(documentAccesses).toHaveLength(6)
  expect(documentSearchAccesses).toHaveLength(3)
  for (
    const access of [
      ...documentAccesses,
      ...documentSearchAccesses,
    ]
  ) {
    expect(access).toMatchObject({
      projectRoles: { refero: 'viewer' },
      restrictToAuthorizedScopes: true,
    })
    expect(access.workspaceScopeRole)
      .toBeUndefined()
  }
  expect(projectCreateResponse.status).toBe(201)
  expect(teamCreateResponse.status).toBe(403)
  expect(projectUserCandidatesResponse.status).toBe(403)
  expect(planningCreateResponse.status).toBe(201)
  expect(planningArchiveResponse.status).toBe(403)
  expect(breakGlassAccountResponse.status).toBe(403)
  expect(await breakGlassAccountResponse.json()).toMatchObject({
    code: 'WorkspacePermissionDenied',
  })
  expect(breakGlassDeactivateResponse.status).toBe(403)
  expect(await breakGlassDeactivateResponse.json()).toMatchObject({
    code: 'WorkspacePermissionDenied',
  })
  expect(await directoryResponse.json()).toEqual({
    teams: [{
      id: 'core-team',
      name: 'コアチーム',
      expanded: true,
      projects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
    }],
  })
  expect(analyticsEvidenceResponse.status).toBe(200)
  expect(await analyticsEvidenceResponse.json()).toMatchObject({
    items: [expect.objectContaining({ workItemId: 'work-item-1', projectId: 'refero' })],
  })
  expect(analyticsReportsResponse.status).toBe(200)
  expect(await analyticsReportsResponse.json()).toMatchObject({
    reports: [expect.objectContaining({ id: analyticsReport.id })],
  })
  expect(analyticsSnapshotsResponse.status).toBe(200)
  expect(await analyticsSnapshotsResponse.json()).toMatchObject({
    snapshots: [expect.objectContaining({ id: 'enterprise-project-snapshot' })],
  })
  expect(analyticsExportResponse.status).toBe(200)
  expect(analyticsExportResponse.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
  expect(deniedAnalyticsWrites.map((response) => response.status)).toEqual([
    403,
    403,
    403,
    403,
  ])
  for (const response of deniedAnalyticsWrites) {
    expect(await response.json()).toMatchObject({ code: 'WorkspacePermissionDenied' })
  }
  await identity.putCustomRole({
    workspaceId,
    roleId: 'custom:project-analytics-writer',
    name: 'Project Analytics writer',
    permissions: ['work-items.write'],
    guestAssignable: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  await identity.putGroupMapping({
    workspaceId,
    mappingId: 'project-analytics-writer-mapping',
    identityProviderId: 'idp-project-role',
    directoryGroupId: group.groupId,
    roleId: 'custom:project-analytics-writer',
    scope: { workspaceId, kind: 'project', targetId: 'refero' },
    enabled: true,
    priority: 5,
    revision: 1,
    updatedAt: now,
  })
  const writableReportResponse = await enterpriseAnalyticsRequest(
    '/api/analytics/reports',
    {
      id: 'enterprise-writable-report',
      name: 'Enterprise writable report',
      visibility: 'personal',
      timeZone: analyticsQuery.timeZone,
      filter: analyticsQuery.filter,
      widgets: analyticsQuery.widgets,
    },
  )
  expect(writableReportResponse.status).toBe(201)
  const writableReport = await writableReportResponse.json() as {
    report: { id: string; revision: number }
  }
  const writablePatchResponse = await enterpriseAnalyticsRequest(
    `/api/analytics/reports/${writableReport.report.id}`,
    { expectedRevision: writableReport.report.revision, name: 'Enterprise updated report' },
    'PATCH',
  )
  const writableSnapshotResponse = await enterpriseAnalyticsRequest(
    `/api/analytics/reports/${writableReport.report.id}/snapshots`,
    analyticsQuery,
  )
  const writableDeleteResponse = await enterpriseAnalyticsRequest(
    `/api/analytics/reports/${writableReport.report.id}`,
    { expectedRevision: writableReport.report.revision + 1 },
    'DELETE',
  )
  expect(writablePatchResponse.status).toBe(200)
  expect(writableSnapshotResponse.status).toBe(201)
  expect(writableDeleteResponse.status).toBe(200)
  configureFakeProjectClients(false, {
    workspaceRole: 'member',
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'private-project', name: 'Private', tone: 'purple' },
    ],
    cognitoProviderDetails: {
      oidc_issuer: 'https://replacement.example.com',
      client_id: 'enterprise-client',
    },
  })
  setTestAppDependencies({ enterpriseIdentity: identity })
  const drifted = await app.request('/api/projects/refero/tasks', {
    headers: { Authorization: authorization },
  })
  expect(drifted.status).toBe(403)
  })
})

test('binds Enterprise Analytics report writes to Team and Workspace visibility scopes', async () => {
  await withTestEnvironment({
    COGNITO_CLIENT_ID: 'mukuroji-main-client',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
  }, async () => {
    configureFakeProjectClients(false, {
      workspaceRole: 'member',
      additionalTeams: [{
        id: 'writer-team',
        name: 'Writer Team',
        projects: [],
      }],
    })
    const workspaceId = 'user#demo@example.com'
    const identity = new InMemoryEnterpriseIdentityClient()
    const now = new Date().toISOString()
    await identity.putIdentityProvider({
      workspaceId,
      providerId: 'idp-analytics-visibility',
      kind: 'oidc',
      displayName: 'Analytics visibility directory',
      cognitoProviderName: 'EnterpriseOidc',
      status: 'active',
      revision: 1,
      issuer: 'https://idp.example.com',
      clientId: 'enterprise-client',
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      jwksUri: 'https://idp.example.com/jwks',
      scopes: ['openid', 'email'],
      createdAt: now,
      updatedAt: now,
      lastTestedAt: now,
    })
    const user = await identity.upsertScimUser({
      workspaceId,
      identityProviderId: 'idp-analytics-visibility',
      externalId: 'analytics-visibility-user',
      userName: 'demo@example.com',
      emails: ['demo@example.com'],
      active: true,
      linkedMemberKey: 'demo@example.com',
      idempotencyKey: 'analytics-visibility-user',
    })
    const group = await identity.upsertScimGroup({
      workspaceId,
      identityProviderId: 'idp-analytics-visibility',
      externalId: 'analytics-visibility-group',
      displayName: 'Analytics visibility writers',
      active: true,
      memberUserIds: [user.userId],
      idempotencyKey: 'analytics-visibility-group',
    })
    const desiredUser = (await identity.getSnapshot(workspaceId)).scimUsers.find((candidate) =>
      candidate.userId === user.userId
    )
    if (!desiredUser) throw new Error('Expected the SCIM user to exist.')
    await identity.markScimUserApplied(workspaceId, desiredUser.userId, desiredUser.version)
    await identity.markScimGroupApplied(workspaceId, group.groupId, group.version)
    await identity.putGroupMapping({
      workspaceId,
      mappingId: 'analytics-workspace-member-mapping',
      identityProviderId: 'idp-analytics-visibility',
      directoryGroupId: group.groupId,
      roleId: 'workspace:member',
      scope: { workspaceId, kind: 'workspace' },
      enabled: true,
      priority: 0,
      revision: 1,
      updatedAt: now,
    })

    const analyticsRepository = new InMemoryAnalyticsRepository()
    const analyticsQuery = createAnalyticsQueryInput()
    const sharedReport = await analyticsRepository.createReport(
      workspaceId,
      'demo@example.com',
      {
        id: 'enterprise-shared-report',
        name: 'Enterprise shared report',
        visibility: 'shared',
        timeZone: analyticsQuery.timeZone,
        filter: analyticsQuery.filter,
        widgets: analyticsQuery.widgets,
      },
    )
    const teamReport = await analyticsRepository.createReport(
      workspaceId,
      'demo@example.com',
      {
        id: 'enterprise-team-report',
        name: 'Enterprise Team report',
        visibility: 'team',
        teamId: 'core-team',
        timeZone: analyticsQuery.timeZone,
        filter: analyticsQuery.filter,
        widgets: analyticsQuery.widgets,
      },
    )
    setTestAppDependencies({
      enterpriseIdentity: identity,
      analytics: analyticsRepository,
      developerPlatform: {
        async consumeRateLimit() {
          return {
            allowed: true,
            limit: 120,
            remaining: 119,
            resetAt: '2026-07-18T00:01:00.000Z',
          }
        },
        async listApiKeys() {
          return []
        },
      } as never,
    })
    const authorization = `Bearer ${createAccessToken([], {
      client_id: 'mukuroji-main-client',
      token_use: 'access',
    })}`
    const patchReport = (reportId: string, expectedRevision: number, name: string) =>
      app.request(`/api/analytics/reports/${reportId}`, {
        method: 'PATCH',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expectedRevision, name }),
      })
    const createSnapshot = (reportId: string) =>
      app.request(`/api/analytics/reports/${reportId}/snapshots`, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(analyticsQuery),
      })

    const workspaceMemberDeveloperAccess = await app.request(
      '/api/developer/api-keys',
      { headers: { Authorization: authorization } },
    )
    expect(workspaceMemberDeveloperAccess.status).toBe(403)
    expect(await workspaceMemberDeveloperAccess.json()).toMatchObject({
      code: 'forbidden',
    })

    const workspaceMemberSharedWrite = await patchReport(
      sharedReport.id,
      sharedReport.revision,
      'Workspace Member edit',
    )
    expect(workspaceMemberSharedWrite.status).toBe(403)
    expect(await workspaceMemberSharedWrite.json()).toMatchObject({
      code: 'AnalyticsReportForbidden',
    })

    await identity.putGroupMapping({
      workspaceId,
      mappingId: 'analytics-team-manager-mapping',
      identityProviderId: 'idp-analytics-visibility',
      directoryGroupId: group.groupId,
      roleId: 'team:manager',
      scope: { workspaceId, kind: 'team', targetId: 'core-team' },
      enabled: true,
      priority: 1,
      revision: 1,
      updatedAt: now,
    })
    const teamManagerTeamWrite = await patchReport(
      teamReport.id,
      teamReport.revision,
      'Team Manager edit',
    )
    expect(teamManagerTeamWrite.status).toBe(200)
    expect(await teamManagerTeamWrite.json()).toMatchObject({
      report: { name: 'Team Manager edit', revision: 2 },
    })

    const teamManagerSharedWrite = await patchReport(
      sharedReport.id,
      sharedReport.revision,
      'Team Manager shared edit',
    )
    expect(teamManagerSharedWrite.status).toBe(403)
    expect(await teamManagerSharedWrite.json()).toMatchObject({
      code: 'AnalyticsReportForbidden',
    })

    await identity.putGroupMapping({
      workspaceId,
      mappingId: 'analytics-workspace-member-mapping',
      identityProviderId: 'idp-analytics-visibility',
      directoryGroupId: group.groupId,
      roleId: 'workspace:member',
      scope: { workspaceId, kind: 'workspace' },
      enabled: false,
      priority: 0,
      revision: 2,
      updatedAt: now,
    })
    await identity.putGroupMapping({
      workspaceId,
      mappingId: 'analytics-team-manager-mapping',
      identityProviderId: 'idp-analytics-visibility',
      directoryGroupId: group.groupId,
      roleId: 'team:manager',
      scope: { workspaceId, kind: 'team', targetId: 'core-team' },
      enabled: false,
      priority: 1,
      revision: 2,
      updatedAt: now,
    })
    await identity.putCustomRole({
      workspaceId,
      roleId: 'custom:analytics-team-manager',
      name: 'Analytics Team manager',
      permissions: ['teams.manage'],
      guestAssignable: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    await identity.putGroupMapping({
      workspaceId,
      mappingId: 'analytics-custom-team-manager-mapping',
      identityProviderId: 'idp-analytics-visibility',
      directoryGroupId: group.groupId,
      roleId: 'custom:analytics-team-manager',
      scope: { workspaceId, kind: 'team', targetId: 'core-team' },
      enabled: true,
      priority: 2,
      revision: 1,
      updatedAt: now,
    })
    const customTeamManagerWrite = await patchReport(
      teamReport.id,
      teamReport.revision + 1,
      'Custom Team Manager edit',
    )
    expect(customTeamManagerWrite.status).toBe(200)
    expect(await customTeamManagerWrite.json()).toMatchObject({
      report: { name: 'Custom Team Manager edit', revision: 3 },
    })
    const customTeamManagerSnapshot = await createSnapshot(teamReport.id)
    expect(customTeamManagerSnapshot.status).toBe(403)
    expect(await customTeamManagerSnapshot.json()).toMatchObject({
      code: 'WorkspacePermissionDenied',
    })
    const missingTeamWrite = await app.request('/api/analytics/reports', {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: 'missing-team-report',
        name: 'Missing Team report',
        visibility: 'team',
        teamId: 'missing-team',
        timeZone: analyticsQuery.timeZone,
        filter: analyticsQuery.filter,
        widgets: analyticsQuery.widgets,
      }),
    })
    expect(missingTeamWrite.status).toBe(404)
    expect(await missingTeamWrite.json()).toEqual({ message: 'Team was not found.' })

    await identity.putGroupMapping({
      workspaceId,
      mappingId: 'analytics-custom-team-manager-mapping',
      identityProviderId: 'idp-analytics-visibility',
      directoryGroupId: group.groupId,
      roleId: 'custom:analytics-team-manager',
      scope: { workspaceId, kind: 'team', targetId: 'core-team' },
      enabled: false,
      priority: 2,
      revision: 2,
      updatedAt: now,
    })
    await identity.putCustomRole({
      workspaceId,
      roleId: 'custom:analytics-workspace-manager',
      name: 'Analytics Workspace manager',
      permissions: ['workspace.manage'],
      guestAssignable: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    await identity.putGroupMapping({
      workspaceId,
      mappingId: 'analytics-custom-workspace-manager-mapping',
      identityProviderId: 'idp-analytics-visibility',
      directoryGroupId: group.groupId,
      roleId: 'custom:analytics-workspace-manager',
      scope: { workspaceId, kind: 'workspace' },
      enabled: true,
      priority: 3,
      revision: 1,
      updatedAt: now,
    })
    const customWorkspaceManagerWrite = await patchReport(
      sharedReport.id,
      sharedReport.revision,
      'Custom Workspace Manager edit',
    )
    expect(customWorkspaceManagerWrite.status).toBe(200)
    expect(await customWorkspaceManagerWrite.json()).toMatchObject({
      report: { name: 'Custom Workspace Manager edit', revision: 2 },
    })
    const customWorkspaceManagerDeveloperAccess = await app.request(
      '/api/developer/api-keys',
      { headers: { Authorization: authorization } },
    )
    expect({
      status: customWorkspaceManagerDeveloperAccess.status,
      body: await customWorkspaceManagerDeveloperAccess.json(),
    }).toMatchObject({
      status: 200,
      body: {
        items: [],
        hasMore: false,
      },
    })
    const customWorkspaceManagerSnapshot = await createSnapshot(sharedReport.id)
    expect(customWorkspaceManagerSnapshot.status).toBe(403)
    expect(await customWorkspaceManagerSnapshot.json()).toMatchObject({
      code: 'WorkspacePermissionDenied',
    })

    await identity.putGroupMapping({
      workspaceId,
      mappingId: 'analytics-custom-workspace-manager-mapping',
      identityProviderId: 'idp-analytics-visibility',
      directoryGroupId: group.groupId,
      roleId: 'custom:analytics-workspace-manager',
      scope: { workspaceId, kind: 'workspace' },
      enabled: false,
      priority: 3,
      revision: 2,
      updatedAt: now,
    })
    await identity.putGroupMapping({
      workspaceId,
      mappingId: 'analytics-custom-team-manager-mapping',
      identityProviderId: 'idp-analytics-visibility',
      directoryGroupId: group.groupId,
      roleId: 'custom:analytics-team-manager',
      scope: { workspaceId, kind: 'workspace' },
      enabled: true,
      priority: 2,
      revision: 3,
      updatedAt: now,
    })
    await identity.putCustomRole({
      workspaceId,
      roleId: 'custom:analytics-work-item-writer',
      name: 'Analytics Work Item writer',
      permissions: ['work-items.write'],
      guestAssignable: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    await identity.putGroupMapping({
      workspaceId,
      mappingId: 'analytics-custom-work-item-writer-mapping',
      identityProviderId: 'idp-analytics-visibility',
      directoryGroupId: group.groupId,
      roleId: 'custom:analytics-work-item-writer',
      scope: { workspaceId, kind: 'team', targetId: 'writer-team' },
      enabled: true,
      priority: 4,
      revision: 1,
      updatedAt: now,
    })
    const mixedScopePersonalWrite = await app.request('/api/analytics/reports', {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: 'mixed-scope-personal-report',
        name: 'Mixed scope personal report',
        visibility: 'personal',
        timeZone: analyticsQuery.timeZone,
        filter: analyticsQuery.filter,
        widgets: analyticsQuery.widgets,
      }),
    })
    expect(mixedScopePersonalWrite.status).toBe(201)
    expect(await mixedScopePersonalWrite.json()).toMatchObject({
      report: { id: 'mixed-scope-personal-report' },
    })
  })
})

test('preserves an empty Team and Team-scoped Planning aggregates for a directory mapping', async () => {
  await withTestEnvironment({
    COGNITO_CLIENT_ID: 'mukuroji-main-client',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
  }, async () => {
    configureFakeProjectClients(false, {
      workspaceRole: 'member',
      teamProjects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
      additionalTeams: [{
        id: 'empty-team',
        name: 'Empty Team',
        projects: [],
      }],
      unassignedIssue: true,
    })
    const workspaceId = 'user#demo@example.com'
    const identity = new InMemoryEnterpriseIdentityClient()
    const now = new Date().toISOString()
    await identity.putIdentityProvider({
      workspaceId,
      providerId: 'idp-team-role',
      kind: 'oidc',
      displayName: 'Team directory',
      cognitoProviderName: 'EnterpriseOidc',
      status: 'active',
      revision: 1,
      issuer: 'https://idp.example.com',
      clientId: 'enterprise-client',
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      jwksUri: 'https://idp.example.com/jwks',
      scopes: ['openid', 'email'],
      createdAt: now,
      updatedAt: now,
      lastTestedAt: now,
    })
    await identity.putCustomRole({
      workspaceId,
      roleId: 'custom:empty-team-reader',
      name: 'Empty Team reader',
      permissions: ['teams.read', 'planning.read', 'work-items.read'],
      guestAssignable: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    const user = await identity.upsertScimUser({
      workspaceId,
      identityProviderId: 'idp-team-role',
      externalId: 'team-reader-user',
      userName: 'demo@example.com',
      emails: ['demo@example.com'],
      active: true,
      linkedMemberKey: 'demo@example.com',
      idempotencyKey: 'team-reader-user',
    })
    const group = await identity.upsertScimGroup({
      workspaceId,
      identityProviderId: 'idp-team-role',
      externalId: 'empty-team-readers',
      displayName: 'Empty Team readers',
      active: true,
      memberUserIds: [user.userId],
      idempotencyKey: 'empty-team-reader-group',
    })
    const desiredUser = (await identity.getSnapshot(workspaceId)).scimUsers.find((candidate) =>
      candidate.userId === user.userId
    )
    if (!desiredUser) throw new Error('Expected the SCIM user to exist.')
    await identity.markScimUserApplied(workspaceId, desiredUser.userId, desiredUser.version)
    await identity.markScimGroupApplied(workspaceId, group.groupId, group.version)
    await identity.putGroupMapping({
      workspaceId,
      mappingId: 'empty-team-reader-mapping',
      identityProviderId: 'idp-team-role',
      directoryGroupId: group.groupId,
      roleId: 'custom:empty-team-reader',
      scope: { workspaceId, kind: 'team', targetId: 'empty-team' },
      enabled: true,
      priority: 0,
      revision: 1,
      updatedAt: now,
    })

    const planningClient = new InMemoryPlanningClient()
    const teamWorkItemState = {
      workItems: [{
        id: 'onboarding-friction',
        revision: 1,
        teamId: 'empty-team',
        title: 'Empty Team Work Item',
        statusCategory: 'started' as const,
        dueDate: '2026/06/18',
      }],
    }
    await planningClient.create(workspaceId, {
      ...createCyclePlanningInput('empty-team-cycle-a', 0),
      teamId: 'empty-team',
      projectId: undefined,
    }, teamWorkItemState)
    await planningClient.create(workspaceId, {
      ...createCyclePlanningInput('empty-team-cycle-b', 1),
      teamId: 'empty-team',
      projectId: undefined,
    }, teamWorkItemState)
    await planningClient.create(
      workspaceId,
      createCyclePlanningInput('private-project-cycle', 2),
      teamWorkItemState,
    )
    await planningClient.createDependency(workspaceId, {
      id: 'empty-team-dependency',
      predecessorId: 'empty-team-cycle-a',
      successorId: 'empty-team-cycle-b',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 3,
    }, teamWorkItemState)
    await planningClient.putWorkItemLink(workspaceId, {
      teamId: 'empty-team',
      workItemId: 'onboarding-friction',
      cycleId: 'empty-team-cycle-a',
      goalIds: [],
      expectedRevision: 4,
    }, teamWorkItemState)
    setTestAppDependencies({
      enterpriseIdentity: identity,
      planning: planningClient,
      analytics: new InMemoryAnalyticsRepository(),
      auditEvents: {
        async getEvent() {
          return undefined
        },
        async query() {
          return { events: [] }
        },
      },
    })

    const accessToken = createAccessToken([], {
      client_id: 'mukuroji-main-client',
      token_use: 'access',
    })
    const headers = { Authorization: `Bearer ${accessToken}` }
    const directoryResponse = await app.request('/api/teams/projects', { headers })
    const workItemsResponse = await app.request('/api/work-items', { headers })
    const planningResponse = await app.request('/api/planning', { headers })
    const emptyTeamAnalyticsQuery = {
      ...createAnalyticsQueryInput(),
      filter: {
        ...createAnalyticsQueryInput().filter,
        teamIds: ['empty-team'],
      },
    }
    const analyticsQueryResponse = await app.request('/api/analytics/query', {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emptyTeamAnalyticsQuery),
    })
    const analyticsEvidenceResponse = await app.request('/api/analytics/evidence', {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        metric: 'wip',
        filter: emptyTeamAnalyticsQuery.filter,
        asOf: emptyTeamAnalyticsQuery.asOf,
        timeZone: emptyTeamAnalyticsQuery.timeZone,
      }),
    })

    expect(directoryResponse.status).toBe(200)
    expect(await directoryResponse.json()).toEqual({
      teams: [{
        id: 'empty-team',
        name: 'Empty Team',
        expanded: true,
        projects: [],
      }],
    })
    expect(workItemsResponse.status).toBe(200)
    expect(await workItemsResponse.json()).toMatchObject({
      workItems: [{ id: 'onboarding-friction', teamId: 'empty-team' }],
    })
    expect(analyticsQueryResponse.status).toBe(200)
    expect(await analyticsQueryResponse.json()).toMatchObject({
      snapshot: {
        widgets: [expect.objectContaining({ sampleSize: 1, value: 1 })],
      },
    })
    expect(analyticsEvidenceResponse.status).toBe(200)
    expect(await analyticsEvidenceResponse.json()).toMatchObject({
      items: [
        expect.objectContaining({
          teamId: 'empty-team',
          workItemId: 'onboarding-friction',
        }),
      ],
    })
    expect(planningResponse.status).toBe(200)
    const planningSnapshot = await planningResponse.json() as PlanningSnapshot
    expect(planningSnapshot.entities.map((entity) => entity.id)).toEqual([
      'empty-team-cycle-a',
      'empty-team-cycle-b',
    ])
    expect(planningSnapshot.dependencies).toEqual([
      expect.objectContaining({ id: 'empty-team-dependency' }),
    ])
    expect(planningSnapshot.workItemLinks).toEqual([
      expect.objectContaining({
        teamId: 'empty-team',
        workItemId: 'onboarding-friction',
        cycleId: 'empty-team-cycle-a',
      }),
    ])
    expect(planningSnapshot.workItems).toEqual([
      expect.objectContaining({ id: 'onboarding-friction', teamId: 'empty-team' }),
    ])
    expect(planningSnapshot.criticalPath.entityIds).not.toContain('private-project-cycle')
    expect(planningSnapshot.criticalPath.slackByEntityId)
      .not.toHaveProperty('private-project-cycle')
  })
})

test('enforces service-account Project scope before recording successful use', async () => {
  await withTestEnvironment({
    ENTERPRISE_IDENTITY_TABLE_NAME:
      'EnterpriseIdentityTable',
    MUKUROJI_WORKSPACE_DIRECTORY_ID: 'workspace-service-account',
    PLANNING_TABLE_NAME: 'PlanningTable',
    WORKSPACE_ACCESS_TABLE_NAME:
      'WorkspaceAccessTable',
  }, async () => {
    configureFakeProjectClients(false, {
      teamProjects: [
        { id: 'refero', name: 'Refero', tone: 'blue' },
        { id: 'private-project', name: 'Private', tone: 'purple' },
      ],
    })
    const identity = new InMemoryEnterpriseIdentityClient()
    const timestamp = new Date().toISOString()
    const issued = await identity.createServiceAccountWithToken({
      workspaceId: 'workspace-service-account',
      accountId: 'project-reader-service',
      displayName: 'Project reader',
      permissions: [
        'projects.read',
        'work-items.read',
        'documents.write',
        'service-accounts.use',
      ],
      roleId: 'project:member',
      scope: {
        workspaceId: 'workspace-service-account',
        kind: 'project',
        targetId: 'refero',
      },
      credentialLifetimeDays: 30,
      allowedSourceCidrs: [],
      status: 'active',
      credentialGeneration: 0,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }, 'create-project-reader', 'create-project-reader-fingerprint')
    const recordServiceAccountUse = identity.recordServiceAccountUse.bind(identity)
    let serviceAccountAuditContext:
      Parameters<typeof identity.recordServiceAccountUse>[2]
    identity.recordServiceAccountUse = async (workspaceId, accountId, auditContext) => {
      serviceAccountAuditContext = auditContext
      await recordServiceAccountUse(workspaceId, accountId, auditContext)
    }
    let documentAuthorizationGuards:
      Parameters<
        DocumentClient['update']
      >[0]['access']['authorizationGuards']
    let documentMutationControlRevision:
      number | undefined
    let documentGuardControlRevision:
      number | undefined
    setTestAppDependencies({
      documents: {
        async update(input) {
          documentAuthorizationGuards =
            input.access.authorizationGuards
          const enterpriseGuard =
            documentAuthorizationGuards?.find(
              ({ tableName }) =>
                tableName ===
                  'EnterpriseIdentityTable',
            )
          documentGuardControlRevision =
            enterpriseGuard?.expectedGeneration
          documentMutationControlRevision =
            (
              await identity.getSnapshot(
                'workspace-service-account',
              )
            ).controlRevision
          if (
            documentGuardControlRevision !==
              documentMutationControlRevision
          ) {
            throw new DocumentError(
              409,
              'DocumentAuthorizationChanged',
              'Document authorization changed.',
            )
          }
          return {
            schemaVersion: 1,
            id: 'refero-document',
            kind: 'page',
            scope: {
              type: 'project',
              projectId: 'refero',
            },
            title:
              input.title ??
              'Refero document',
            position: 'a0',
            revision: 1,
            permission: {
              mode: 'inherit',
              memberGrants: [],
            },
            relations: [],
            favorite: false,
            capabilities: {
              canView: true,
              canEdit: false,
              canComment: false,
              canShare: false,
              canManagePermissions: false,
              canArchive: false,
              canRestore: false,
              canExport: true,
            },
            createdByUserId:
              'project-reader-service',
            updatedByUserId:
              'project-reader-service',
            createdAt: timestamp,
            updatedAt: timestamp,
            blocks: [],
          }
        },
      } as unknown as DocumentClient,
      enterpriseIdentity: identity,
    })
    const headers = { Authorization: `Bearer ${issued.token}` }

    const denied = await app.request('/api/projects/private-project/tasks', { headers })
    expect(denied.status).toBe(403)
    expect(
      (await identity.getSnapshot('workspace-service-account'))
        .serviceAccounts[0]?.lastUsedAt,
    ).toBeUndefined()

    const controlRevisionBeforeDocumentMutation =
      (
        await identity.getSnapshot(
          'workspace-service-account',
        )
      ).controlRevision
    const documentResponse = await app.request(
      '/api/documents/refero-document',
      {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expectedRevision: 1,
          title: 'Updated by service account',
        }),
      },
    )
    expect(documentResponse.status).toBe(200)
    expect(documentMutationControlRevision)
      .toBe(
        controlRevisionBeforeDocumentMutation +
          1,
      )
    expect(documentGuardControlRevision)
      .toBe(documentMutationControlRevision)
    expect(documentAuthorizationGuards)
      .toEqual([
        expect.objectContaining({
          tableName: 'PlanningTable',
          key: {
            workspaceId:
              'workspace-service-account',
            recordKey: 'META',
          },
        }),
        expect.objectContaining({
          tableName:
            'EnterpriseIdentityTable',
          key: {
            scopeKey:
              'WORKSPACE#workspace-service-account',
            recordKey: 'CONTROL',
          },
        }),
      ])
    expect(
      documentAuthorizationGuards?.some(
        (guard) =>
          guard.tableName ===
            'WorkspaceAccessTable' ||
          guard.key.recordKey ===
            'MEMBER#project-reader-service',
      ),
    ).toBeFalse()

    const allowed = await app.request('/api/projects/refero/tasks', { headers })
    expect(allowed.status).toBe(200)
    expect(
      (await identity.getSnapshot('workspace-service-account'))
        .serviceAccounts[0]?.lastUsedAt,
    ).toEqual(expect.any(String))
    expect(serviceAccountAuditContext).toMatchObject({
      actor: {
        id: 'project-reader-service',
        kind: 'service',
      },
      source: {
        kind: 'api',
        route: '/api/projects/refero/tasks',
      },
    })
  })
})

test('uses an active break-glass elevation to repair an IP allowlist lockout', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'member' })
  const workspaceId = 'user#demo@example.com'
  const timestamp = new Date()
  const now = timestamp.toISOString()
  const nowSeconds = Math.floor(timestamp.getTime() / 1_000)
  const accessToken = [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({
      auth_time: nowSeconds,
      iat: nowSeconds,
      exp: nowSeconds + 3_600,
      token_use: 'access',
    })).toString('base64url'),
    'test-signature',
  ].join('.')
  const alternateAccessToken = [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({
      auth_time: nowSeconds,
      iat: nowSeconds,
      exp: nowSeconds + 3_600,
      token_use: 'access',
    })).toString('base64url'),
    'alternate-test-signature',
  ].join('.')
  const identity = new InMemoryEnterpriseIdentityClient()
  await identity.putSecurityPolicy({
    workspaceId,
    loginMode: 'password-or-sso',
    mfaRequirement: 'required',
    sessionLifetimeMinutes: 480,
    idleTimeoutMinutes: 60,
    reauthenticationIntervalMinutes: 120,
    sensitiveActionReauthenticationMinutes: 15,
    ipAllowlistMode: 'all-users',
    ipAllowlist: ['203.0.113.0/24'],
    externalAccess: {
      allowGuests: true,
      allowExternalCollaborators: true,
      requireMfa: true,
      maximumSessionLifetimeMinutes: 120,
      allowedGuestDomains: [],
      permissionCeiling: ['workspace.read'],
    },
    revision: 1,
    updatedAt: now,
    updatedBy: 'owner@example.com',
  })
  await identity.putBreakGlassAccount({
    workspaceId,
    accountId: 'recovery-demo',
    linkedMemberKey: 'demo@example.com',
    email: 'recovery@outside.example',
    status: 'active',
    requireMfa: true,
    maximumActivationMinutes: 30,
    mfaVerifiedAt: now,
    lastTestedAt: now,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  const putSecurityPolicy = identity.putSecurityPolicy.bind(identity)
  let breakGlassAuditContext: Parameters<typeof identity.putSecurityPolicy>[1]
  identity.putSecurityPolicy = async (policy, auditContext) => {
    breakGlassAuditContext = auditContext
    return putSecurityPolicy(policy, auditContext)
  }
  let verifyRecoveryDomainDuringMfa = false
  setTestAppDependencies({
    enterpriseIdentity: identity,
    enterpriseSessionActivity: {
      async getAuthenticationMethods() {
        if (verifyRecoveryDomainDuringMfa) {
          verifyRecoveryDomainDuringMfa = false
          await identity.putVerifiedDomain({
            workspaceId,
            domainId: 'outside-example',
            domain: 'outside.example',
            status: 'verified',
            revision: 1,
            verificationRecordName: '_mukuroji-challenge.outside.example',
            verifiedAt: now,
            enforceSso: false,
            createdAt: now,
            updatedAt: now,
          })
        }
        return ['software_token_mfa']
      },
      async recordAuthenticationAssurance() {
        return undefined
      },
      async validateAndTouch(input) {
        return [...input.authenticationMethods]
      },
    },
  })
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }

  const activation = await app.request(
    '/api/enterprise/security/break-glass/activate',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        reason: 'Repair mistaken IP policy',
        durationMinutes: 15,
      }),
    },
  )
  const snapshotResponse = await app.request('/api/enterprise/security', { headers })
  const alternateSessionResponse = await app.request('/api/enterprise/security', {
    headers: { Authorization: `Bearer ${alternateAccessToken}` },
  })
  const policyResponse = await app.request('/api/enterprise/security/policy', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      expectedVersion: 1,
      mfaRequired: true,
      sessionLifetimeMinutes: 480,
      idleTimeoutMinutes: 60,
      reauthenticationMinutes: 120,
      sensitiveActionReauthenticationMinutes: 15,
      ipAllowlist: [],
      guestsAllowed: true,
      externalCollaboratorsAllowed: true,
      guestSessionLifetimeMinutes: 120,
      allowedGuestDomains: [],
    }),
  })

  expect(activation.status).toBe(201)
  const activationBody = await activation.clone().json() as {
    activation: { id: string }
  }
  expect(snapshotResponse.status).toBe(200)
  expect(alternateSessionResponse.status).toBe(403)
  expect(await alternateSessionResponse.json()).toMatchObject({
    code: 'EnterpriseSessionIpDenied',
  })
  expect(await identity.getActiveBreakGlassActivation(
    workspaceId,
    'demo@example.com',
    createHash('sha256').update(accessToken).digest('base64url'),
  )).toMatchObject({ accountId: 'recovery-demo' })
  expect(await identity.getActiveBreakGlassActivation(
    workspaceId,
    'demo@example.com',
    createHash('sha256').update(alternateAccessToken).digest('base64url'),
  )).toBeUndefined()
  expect(await snapshotResponse.json()).toMatchObject({
    activeBreakGlassActivation: {
      expiresAt: expect.any(String),
    },
  })
  expect(policyResponse.status).toBe(200)
  expect(breakGlassAuditContext).toMatchObject({
    actor: {
      id: 'demo@example.com',
      kind: 'break-glass',
    },
    correlationId: activationBody.activation.id,
  })
  expect((await identity.getSnapshot(workspaceId)).policy?.ipAllowlist).toEqual([])

  verifyRecoveryDomainDuringMfa = true
  const managedDomainActivation = await app.request(
    '/api/enterprise/security/break-glass/activate',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alternateAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reason: 'Attempt recovery after domain verification',
        durationMinutes: 15,
      }),
    },
  )
  expect(managedDomainActivation.status).toBe(409)
  expect(await managedDomainActivation.json()).toMatchObject({
    code: 'EnterpriseBreakGlassRecoveryDomainManaged',
    message: 'Break-glass recovery must use an account outside every managed domain.',
  })
  expect(await identity.getActiveBreakGlassActivation(
    workspaceId,
    'demo@example.com',
    createHash('sha256').update(alternateAccessToken).digest('base64url'),
  )).toBeUndefined()
})
