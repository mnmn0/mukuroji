import { expect, test } from 'bun:test'
import type {
  TenantAdministrationSnapshot,
  TenantOperation,
} from '@mukuroji/contracts'
import { createDefaultTenantAdministrationSnapshot } from '../../domain/tenant-administration'
import { TenantAdministrationError } from '../../domain/tenant-administration'
import type { TenantAdministrationClient } from '../../application/ports/tenant-administration-port'
import { createTenantAdministrationRouter } from './tenant-administration-router'

/** Creates one export operation fixture returned by the HTTP adapter test port. */
function createOperation(): TenantOperation {
  return {
    operationId: 'operation-1',
    workspaceId: 'workspace-1',
    kind: 'export',
    status: 'requested',
    requestedBy: 'owner-1',
    requestedAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    updatedBy: 'owner-1',
    completedSteps: [],
    exportFormat: 'jsonl',
    revision: 0,
  }
}

/** Creates a complete in-memory tenant application port for router tests. */
function createClient(
  snapshot: TenantAdministrationSnapshot,
  ensureCalls: Array<[string, string]>,
): TenantAdministrationClient {
  const operation = createOperation()
  return {
    async assertActive() {},
    async ensureSnapshot(workspaceId, ownerMemberKey) {
      ensureCalls.push([workspaceId, ownerMemberKey])
      return snapshot
    },
    async getSnapshot() {
      return snapshot
    },
    async getProfile() {
      return snapshot.profile
    },
    async updateProfile() {
      return snapshot.profile
    },
    async updateGovernance() {
      return snapshot.governance
    },
    async requestExport() {
      return operation
    },
    async requestClosure() {
      return { ...operation, kind: 'closure' }
    },
    async getOperation() {
      return operation
    },
    async advanceOperation() {
      return operation
    },
    async failOperation() {
      return { ...operation, status: 'failed', failureCode: 'EXECUTION_FAILED' }
    },
    async pauseOperation() {
      return { ...operation, status: 'paused' }
    },
    async resumeOperation() {
      return { ...operation, status: 'running' }
    },
    async verifyClosure() {
      return { ...operation, kind: 'closure', status: 'verified' }
    },
  }
}

test('initializes tenant state from authoritative Workspace owner', async () => {
  const snapshot = createDefaultTenantAdministrationSnapshot(
    'workspace-1',
    'owner-1',
    '2026-08-02T00:00:00.000Z',
  )
  const ensureCalls: Array<[string, string]> = []
  let administrationChecks = 0
  const client = createClient(snapshot, ensureCalls)
  client.getSnapshot = async () => {
    throw new TenantAdministrationError(
      404,
      'TenantAdministrationNotInitialized',
      'Tenant administration state is not initialized.',
    )
  }
  const router = createTenantAdministrationRouter({
    async authenticate() {
      return { directoryId: 'workspace-1', userKey: 'admin-1' }
    },
    requireAdministration() {
      administrationChecks += 1
    },
    requireAuditDataExport() {},
    async recordExportDownload() {},
    client,
    tenantExportDownload: {
      async createDownload() {
        return { expiresAt: '2026-08-02T00:05:00.000Z', files: [] }
      },
    },
    async resolveInitialization() {
      return { ownerMemberKey: 'owner-1' }
    },
    async readJson(request) {
      return await request.json()
    },
    mapError(_context, error) {
      return Response.json({
        code: error instanceof Error ? error.name : 'UnknownError',
      }, { status: 500 })
    },
  })

  const response = await router.request('/api/tenant/administration', {
    headers: { Authorization: 'Bearer token-1' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    schemaVersion: 3,
  })
  expect(ensureCalls).toEqual([['workspace-1', 'owner-1']])
  expect(administrationChecks).toBe(1)
})

test('returns a closing tenant snapshot without requiring an active owner', async () => {
  const activeSnapshot = createDefaultTenantAdministrationSnapshot(
    'workspace-1',
    'owner-1',
    '2026-08-02T00:00:00.000Z',
  )
  const snapshot: TenantAdministrationSnapshot = {
    ...activeSnapshot,
    profile: {
      ...activeSnapshot.profile,
      status: 'closing',
      revision: activeSnapshot.profile.revision + 1,
    },
  }
  const ensureCalls: Array<[string, string]> = []
  let initializationCalls = 0
  const router = createTenantAdministrationRouter({
    async authenticate() {
      return { directoryId: 'workspace-1', userKey: 'admin-1' }
    },
    requireAdministration() {},
    requireAuditDataExport() {},
    async recordExportDownload() {},
    client: createClient(snapshot, ensureCalls),
    tenantExportDownload: {
      async createDownload() {
        return { expiresAt: '2026-08-02T00:05:00.000Z', files: [] }
      },
    },
    async resolveInitialization() {
      initializationCalls += 1
      throw new TenantAdministrationError(
        503,
        'TenantOwnerUnavailable',
        'An active Workspace owner is unavailable.',
      )
    },
    async readJson(request) {
      return await request.json()
    },
    mapError(_context, error) {
      if (error instanceof TenantAdministrationError) {
        return Response.json({ code: error.code }, { status: error.status })
      }
      return Response.json({ code: 'UnknownError' }, { status: 500 })
    },
  })

  const response = await router.request('/api/tenant/administration', {
    headers: { Authorization: 'Bearer token-1' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    profile: { status: 'closing' },
  })
  expect(initializationCalls).toBe(0)
  expect(ensureCalls).toEqual([])
})

test('creates export operations without exposing the trusted advance boundary', async () => {
  const snapshot = createDefaultTenantAdministrationSnapshot(
    'workspace-1',
    'owner-1',
    '2026-08-02T00:00:00.000Z',
  )
  const client = createClient(snapshot, [])
  let receivedIdempotencyKey: string | undefined
  client.requestExport = async (_workspaceId, _actorMemberKey, _input, idempotencyKey) => {
    receivedIdempotencyKey = idempotencyKey
    return createOperation()
  }
  const router = createTenantAdministrationRouter({
    async authenticate() {
      return { directoryId: 'workspace-1', userKey: 'owner-1' }
    },
    requireAdministration() {},
    requireAuditDataExport() {},
    async recordExportDownload() {},
    client,
    tenantExportDownload: {
      async createDownload() {
        return { expiresAt: '2026-08-02T00:05:00.000Z', files: [] }
      },
    },
    async resolveInitialization() {
      return { ownerMemberKey: 'owner-1' }
    },
    async readJson(request) {
      return await request.json()
    },
    mapError(_context, error) {
      return Response.json({
        code: error instanceof Error ? error.name : 'UnknownError',
      }, { status: 500 })
    },
  })

  const response = await router.request('/api/tenant/exports', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer token-1',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'tenant-export-1',
    },
    body: JSON.stringify({ format: 'jsonl' }),
  })
  const advanceResponse = await router.request(
    '/api/tenant/operations/operation-1/advance',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer token-1' },
    },
  )

  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({
    operation: { operationId: 'operation-1', status: 'requested' },
  })
  expect(receivedIdempotencyKey).toBe('tenant-export-1')
  expect(advanceResponse.status).toBe(404)
})

test('returns short-lived download locations for a completed export', async () => {
  const snapshot = createDefaultTenantAdministrationSnapshot(
    'workspace-1',
    'owner-1',
    '2026-08-02T00:00:00.000Z',
  )
  const client = createClient(snapshot, [])
  client.getOperation = async () => ({
    ...createOperation(),
    status: 'completed',
  })
  const recordedDownloads: Array<{ operationId: string, fileCount: number }> = []
  const router = createTenantAdministrationRouter({
    async authenticate() {
      return { directoryId: 'workspace-1', userKey: 'owner-1' }
    },
    requireAdministration() {},
    requireAuditDataExport() {},
    async recordExportDownload(_context, _principal, operation, download) {
      recordedDownloads.push({ operationId: operation.operationId, fileCount: download.files.length })
    },
    client,
    tenantExportDownload: {
      async createDownload(operation) {
        expect(operation.status).toBe('completed')
        return {
          expiresAt: '2026-08-02T00:05:00.000Z',
          files: [{ name: 'manifest.json', url: 'https://signed.example/export' }],
        }
      },
    },
    async resolveInitialization() {
      return { ownerMemberKey: 'owner-1' }
    },
    async readJson(request) {
      return await request.json()
    },
    mapError(_context, error) {
      if (error instanceof TenantAdministrationError) {
        return Response.json({ code: error.code }, { status: error.status })
      }
      return Response.json({ code: 'UnknownError' }, { status: 500 })
    },
  })

  const response = await router.request(
    '/api/tenant/operations/operation-1/download',
    { headers: { Authorization: 'Bearer token-1' } },
  )

  expect(response.status).toBe(200)
  expect(recordedDownloads).toEqual([{ operationId: 'operation-1', fileCount: 1 }])
  expect(await response.json()).toEqual({
    download: {
      expiresAt: '2026-08-02T00:05:00.000Z',
      files: [{ name: 'manifest.json', url: 'https://signed.example/export' }],
    },
  })
})

test('refuses lifecycle requests when the export and closure workers are not deployed', async () => {
  const snapshot = createDefaultTenantAdministrationSnapshot(
    'workspace-1',
    'owner-1',
    '2026-08-02T00:00:00.000Z',
  )
  const client = createClient(snapshot, [])
  const lifecycleCalls: string[] = []
  client.requestExport = async () => {
    lifecycleCalls.push('export')
    return createOperation()
  }
  client.requestClosure = async () => {
    lifecycleCalls.push('closure')
    return { ...createOperation(), kind: 'closure' }
  }
  client.pauseOperation = async () => {
    lifecycleCalls.push('pause')
    return { ...createOperation(), status: 'paused' }
  }
  client.resumeOperation = async () => {
    lifecycleCalls.push('resume')
    return { ...createOperation(), status: 'running' }
  }
  client.verifyClosure = async () => {
    lifecycleCalls.push('verify')
    return { ...createOperation(), kind: 'closure', status: 'verified' }
  }
  let downloads = 0
  const router = createTenantAdministrationRouter({
    async authenticate() {
      return { directoryId: 'workspace-1', userKey: 'admin-1' }
    },
    requireAdministration() {},
    requireAuditDataExport() {},
    async recordExportDownload() {},
    client,
    tenantExportDownload: {
      async createDownload() {
        downloads += 1
        return { expiresAt: '2026-08-02T00:05:00.000Z', files: [] }
      },
    },
    async resolveInitialization() {
      return { ownerMemberKey: 'owner-1' }
    },
    async readJson(request) {
      return await request.json()
    },
    lifecycleOperationsDeployed: () => false,
    mapError(_context, error) {
      return error instanceof TenantAdministrationError
        ? Response.json({ code: error.code }, { status: error.status })
        : Response.json({ code: 'UnknownError' }, { status: 500 })
    },
  })
  const headers = {
    Authorization: 'Bearer token-1',
    'Content-Type': 'application/json',
  }
  const requests: Array<[string, RequestInit]> = [
    ['/api/tenant/exports', { method: 'POST', headers, body: JSON.stringify({ format: 'jsonl' }) }],
    ['/api/tenant/closures', { method: 'POST', headers, body: JSON.stringify({}) }],
    ['/api/tenant/operations/operation-1/download', { headers }],
    ['/api/tenant/operations/operation-1/pause', { method: 'POST', headers }],
    ['/api/tenant/operations/operation-1/resume', { method: 'POST', headers }],
    ['/api/tenant/operations/operation-1/verify', { method: 'POST', headers }],
  ]

  for (const [path, init] of requests) {
    const response = await router.request(path, init)
    expect({ path, status: response.status, body: await response.json() }).toEqual({
      path,
      status: 503,
      body: { code: 'TenantLifecycleNotDeployed' },
    })
  }
  expect(lifecycleCalls).toEqual([])
  expect(downloads).toBe(0)

  const administration = await router.request('/api/tenant/administration', { headers })
  expect(administration.status).toBe(200)
  const operation = await router.request('/api/tenant/operations/operation-1', { headers })
  expect(operation.status).toBe(200)
})

test('refuses tenant export requests and downloads without audit export authority', async () => {
  const snapshot = createDefaultTenantAdministrationSnapshot(
    'workspace-1',
    'owner-1',
    '2026-08-02T00:00:00.000Z',
  )
  const client = createClient(snapshot, [])
  let exportRequests = 0
  let downloads = 0
  let recordedDownloads = 0
  client.requestExport = async () => {
    exportRequests += 1
    return createOperation()
  }
  client.getOperation = async () => ({
    ...createOperation(),
    status: 'completed',
  })
  const router = createTenantAdministrationRouter({
    async authenticate() {
      return { directoryId: 'workspace-1', userKey: 'admin-1' }
    },
    requireAdministration() {},
    requireAuditDataExport() {
      throw new TenantAdministrationError(403, 'AuditExportPermissionRequired', 'Audit export is required.')
    },
    async recordExportDownload() {
      recordedDownloads += 1
    },
    client,
    tenantExportDownload: {
      async createDownload() {
        downloads += 1
        return { expiresAt: '2026-08-02T00:05:00.000Z', files: [] }
      },
    },
    async resolveInitialization() {
      return { ownerMemberKey: 'owner-1' }
    },
    async readJson(request) {
      return await request.json()
    },
    mapError(_context, error) {
      if (error instanceof TenantAdministrationError) {
        return Response.json({ code: error.code }, { status: error.status })
      }
      return Response.json({ code: 'UnknownError' }, { status: 500 })
    },
  })

  const exportResponse = await router.request('/api/tenant/exports', {
    method: 'POST',
    headers: { Authorization: 'Bearer token-1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'jsonl' }),
  })
  const downloadResponse = await router.request(
    '/api/tenant/operations/operation-1/download',
    { headers: { Authorization: 'Bearer token-1' } },
  )

  expect(exportResponse.status).toBe(403)
  expect(downloadResponse.status).toBe(403)
  expect({ exportRequests, downloads, recordedDownloads }).toEqual({
    exportRequests: 0,
    downloads: 0,
    recordedDownloads: 0,
  })
})

test('refuses download links when their issuance cannot be audited', async () => {
  const snapshot = createDefaultTenantAdministrationSnapshot(
    'workspace-1',
    'owner-1',
    '2026-08-02T00:00:00.000Z',
  )
  const client = createClient(snapshot, [])
  client.getOperation = async () => ({
    ...createOperation(),
    status: 'completed',
  })
  const router = createTenantAdministrationRouter({
    async authenticate() {
      return { directoryId: 'workspace-1', userKey: 'owner-1' }
    },
    requireAdministration() {},
    requireAuditDataExport() {},
    async recordExportDownload() {
      throw new TenantAdministrationError(503, 'TenantAuditUnavailable', 'Audit is unavailable.')
    },
    client,
    tenantExportDownload: {
      async createDownload() {
        return {
          expiresAt: '2026-08-02T00:05:00.000Z',
          files: [{ name: 'manifest.json', url: 'https://signed.example/export' }],
        }
      },
    },
    async resolveInitialization() {
      return { ownerMemberKey: 'owner-1' }
    },
    async readJson(request) {
      return await request.json()
    },
    mapError(_context, error) {
      if (error instanceof TenantAdministrationError) {
        return Response.json({ code: error.code }, { status: error.status })
      }
      return Response.json({ code: 'UnknownError' }, { status: 500 })
    },
  })

  const response = await router.request(
    '/api/tenant/operations/operation-1/download',
    { headers: { Authorization: 'Bearer token-1' } },
  )

  expect(response.status).toBe(503)
  expect(JSON.stringify(await response.json())).not.toContain('signed.example')
})

/**
 * Creates a router for a member or an administrator that records profile updates.
 *
 * @param client - Tenant application port used by the router.
 * @param updates - Receives each profile update the router forwards.
 * @param administrator - Whether the caller passes the administration check.
 * @returns The tenant administration router under test.
 */
function createCalendarRouter(
  client: TenantAdministrationClient,
  updates: unknown[] = [],
  administrator = false,
) {
  client.updateProfile = async (_workspaceId, _actor, input) => {
    updates.push(input)
    return (await client.getSnapshot('workspace-1')).profile
  }
  return createTenantAdministrationRouter(createCalendarRouterDependencies(client, administrator))
}

/**
 * Builds the router dependencies the calendar tests use.
 *
 * @param client - Tenant administration client.
 * @param administrator - Whether the principal may change settings.
 * @returns Router dependencies.
 */
function createCalendarRouterDependencies(
  client: TenantAdministrationClient,
  administrator = false,
): Parameters<typeof createTenantAdministrationRouter<{ directoryId: string, userKey: string }>>[0] {
  return {
    async authenticate() {
      return { directoryId: 'workspace-1', userKey: 'member-1' }
    },
    requireAdministration() {
      if (!administrator) {
        throw new TenantAdministrationError(403, 'Forbidden', 'Administrator access is required.')
      }
    },
    requireAuditDataExport() {},
    async recordExportDownload() {},
    client,
    tenantExportDownload: {
      async createDownload() {
        return { expiresAt: '2026-08-02T00:05:00.000Z', files: [] }
      },
    },
    async resolveInitialization() {
      return { ownerMemberKey: 'owner-1' }
    },
    async readJson(request) {
      return await request.json()
    },
    mapError(_context, error) {
      const status = error instanceof TenantAdministrationError ? error.status : 500
      const code = error instanceof TenantAdministrationError ? error.code : 'UnknownError'
      return Response.json({ code }, { status })
    },
  }
}

test('lets any member read the Workspace calendar settings, with defaults before setup', async () => {
  const snapshot = createDefaultTenantAdministrationSnapshot(
    'workspace-1',
    'owner-1',
    '2026-08-02T00:00:00.000Z',
  )
  const client = createClient(snapshot, [])
  client.getProfile = async () => undefined
  const ensureCalls: Array<[string, string]> = []
  client.ensureSnapshot = async (workspaceId, ownerMemberKey) => {
    ensureCalls.push([workspaceId, ownerMemberKey])
    return snapshot
  }

  const defaults = await createCalendarRouter(client).request('/api/workspace/calendar-settings', {
    headers: { Authorization: 'Bearer token-1' },
  })
  expect(defaults.status).toBe(200)
  expect(await defaults.json()).toEqual({
    fiscalYearStartMonth: 1,
    weekStartDay: 1,
    workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    holidays: [],
    publicHolidays: 'japan',
    timeZone: 'Asia/Tokyo',
  })
  // Reading must not initialize tenant state on a member's behalf.
  expect(ensureCalls).toEqual([])

  client.getProfile = async () => ({
    ...snapshot.profile,
    calendar: {
      fiscalYearStartMonth: 4,
      weekStartDay: 0,
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday'],
      holidays: ['2027-01-01'],
      publicHolidays: 'none',
      timeZone: 'Asia/Tokyo',
    },
  })
  const stored = await createCalendarRouter(client).request('/api/workspace/calendar-settings', {
    headers: { Authorization: 'Bearer token-1' },
  })
  // Members read the working days and holidays too, so new Work Items can use them.
  expect(await stored.json()).toEqual({
    fiscalYearStartMonth: 4,
    weekStartDay: 0,
    workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday'],
    holidays: ['2027-01-01'],
    publicHolidays: 'none',
    timeZone: 'Asia/Tokyo',
  })

  const unauthenticated = await createCalendarRouter(client).request('/api/workspace/calendar-settings')
  expect(unauthenticated.status).toBe(401)

  // A failed read, such as an incomplete tenant record, must not be reported as the defaults.
  client.getProfile = async () => {
    throw new TenantAdministrationError(503, 'TenantAdministrationUnavailable', 'Tenant state is unavailable.')
  }
  const failed = await createCalendarRouter(client).request('/api/workspace/calendar-settings', {
    headers: { Authorization: 'Bearer token-1' },
  })
  expect(failed.status).toBe(503)
})

test('sends the national holiday dates the server uses with the calendar settings', async () => {
  const snapshot = createDefaultTenantAdministrationSnapshot(
    'workspace-1',
    'owner-1',
    '2026-08-02T00:00:00.000Z',
  )
  const client = createClient(snapshot, [])
  client.getProfile = async () => undefined
  const router = createTenantAdministrationRouter({
    ...createCalendarRouterDependencies(client),
    nationalHolidays: { listDates: async () => ['2027-01-01', '2028-01-01'] },
  })

  const response = await router.request('/api/workspace/calendar-settings', {
    headers: { Authorization: 'Bearer token-1' },
  })

  expect(await response.json()).toMatchObject({
    publicHolidays: 'japan',
    timeZone: 'Asia/Tokyo',
    nationalHolidayDates: ['2027-01-01', '2028-01-01'],
  })
})

test('keeps weekly report reminder settings behind administration and validates them', async () => {
  const snapshot = createDefaultTenantAdministrationSnapshot(
    'workspace-1',
    'owner-1',
    '2026-08-02T00:00:00.000Z',
  )
  const body = {
    region: snapshot.profile.region,
    locale: 'ja',
    defaultPolicy: { defaultMemberRole: 'member' },
    expectedRevision: 1,
  }
  const settings = {
    enabled: true,
    reminder: { weekday: 4, hour: 9 },
    escalationEnabled: false,
    escalation: { weekday: 1, hour: 10 },
  }
  const memberUpdates: unknown[] = []
  const member = await createCalendarRouter(createClient(snapshot, []), memberUpdates).request('/api/tenant/profile', {
    body: JSON.stringify({ ...body, weeklyReportReminders: settings }),
    headers: { Authorization: 'Bearer token-1', 'Content-Type': 'application/json' },
    method: 'PATCH',
  })
  expect(member.status).toBe(403)
  expect(memberUpdates).toEqual([])

  const updates: unknown[] = []
  const admin = createCalendarRouter(createClient(snapshot, []), updates, true)
  for (const weeklyReportReminders of [
    null,
    { ...settings, enabled: 'yes' },
    { ...settings, reminder: { weekday: 7, hour: 9 } },
    { ...settings, reminder: { weekday: 4, hour: 24 } },
    { ...settings, reminder: { weekday: 4, hour: 9.5 } },
    { ...settings, escalation: undefined },
    // Both notices on in the same hour.
    { ...settings, escalationEnabled: true, escalation: { weekday: 4, hour: 9 } },
  ]) {
    const rejected = await admin.request('/api/tenant/profile', {
      body: JSON.stringify({ ...body, weeklyReportReminders }),
      headers: { Authorization: 'Bearer token-1', 'Content-Type': 'application/json' },
      method: 'PATCH',
    })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ code: 'InvalidWeeklyReportReminderSettings' })
  }
  expect(updates).toEqual([])

  const accepted = await admin.request('/api/tenant/profile', {
    body: JSON.stringify({ ...body, weeklyReportReminders: { ...settings, extra: true } }),
    headers: { Authorization: 'Bearer token-1', 'Content-Type': 'application/json' },
    method: 'PATCH',
  })
  expect(accepted.status).toBe(200)
  expect(updates).toEqual([{ ...body, weeklyReportReminders: settings }])
})

test('keeps calendar settings changes behind administration and validates them', async () => {
  const snapshot = createDefaultTenantAdministrationSnapshot(
    'workspace-1',
    'owner-1',
    '2026-08-02T00:00:00.000Z',
  )
  const body = {
    region: snapshot.profile.region,
    locale: 'ja',
    defaultPolicy: { defaultMemberRole: 'member' },
    expectedRevision: 1,
  }
  const memberUpdates: unknown[] = []
  const member = await createCalendarRouter(createClient(snapshot, []), memberUpdates).request('/api/tenant/profile', {
    body: JSON.stringify({ ...body, calendar: { fiscalYearStartMonth: 4, weekStartDay: 1 } }),
    headers: { Authorization: 'Bearer token-1', 'Content-Type': 'application/json' },
    method: 'PATCH',
  })
  expect(member.status).toBe(403)
  expect(memberUpdates).toEqual([])

  const updates: unknown[] = []
  const admin = createCalendarRouter(createClient(snapshot, []), updates, true)

  for (const calendar of [
    { fiscalYearStartMonth: 0, weekStartDay: 1 },
    { fiscalYearStartMonth: 13, weekStartDay: 1 },
    { fiscalYearStartMonth: 4.5, weekStartDay: 1 },
    { fiscalYearStartMonth: 4, weekStartDay: 7 },
    { fiscalYearStartMonth: '4', weekStartDay: 1 },
    { fiscalYearStartMonth: 4, weekStartDay: 1, workingWeekdays: [] },
    { fiscalYearStartMonth: 4, weekStartDay: 1, workingWeekdays: ['funday'] },
    { fiscalYearStartMonth: 4, weekStartDay: 1, workingWeekdays: 'monday' },
    { fiscalYearStartMonth: 4, weekStartDay: 1, holidays: ['2027-02-30'] },
    { fiscalYearStartMonth: 4, weekStartDay: 1, holidays: ['1969-12-31'] },
    { fiscalYearStartMonth: 4, weekStartDay: 1, holidays: '2027-01-01' },
    { fiscalYearStartMonth: 4, weekStartDay: 1, publicHolidays: 'us' },
    {
      fiscalYearStartMonth: 4,
      weekStartDay: 1,
      holidays: Array.from({ length: 513 }, (_, index) =>
        new Date(Date.UTC(2027, 0, 1 + index)).toISOString().slice(0, 10)),
    },
    null,
  ]) {
    const rejected = await admin.request('/api/tenant/profile', {
      body: JSON.stringify({ ...body, calendar }),
      headers: { Authorization: 'Bearer token-1', 'Content-Type': 'application/json' },
      method: 'PATCH',
    })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ code: 'InvalidTenantCalendarSettings' })
  }
  expect(updates).toEqual([])

  const accepted = await admin.request('/api/tenant/profile', {
    body: JSON.stringify({ ...body, calendar: { fiscalYearStartMonth: 4, weekStartDay: 0, extra: true } }),
    headers: { Authorization: 'Bearer token-1', 'Content-Type': 'application/json' },
    method: 'PATCH',
  })
  expect(accepted.status).toBe(200)
  // Settings from before working days existed get the Monday-to-Friday default, no company
  // holidays, and the Japanese national holidays.
  expect(updates).toEqual([{
    ...body,
    locale: 'ja',
    calendar: {
      fiscalYearStartMonth: 4,
      weekStartDay: 0,
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      holidays: [],
      publicHolidays: 'japan',
      timeZone: 'Asia/Tokyo',
    },
  }])

  const withWorkingDays = await admin.request('/api/tenant/profile', {
    body: JSON.stringify({
      ...body,
      calendar: {
        fiscalYearStartMonth: 4,
        weekStartDay: 1,
        workingWeekdays: ['saturday', 'monday', 'monday', 'tuesday'],
        holidays: ['2027-05-03', '2027-01-01', '2027-05-03'],
        publicHolidays: 'none',
        timeZone: 'Asia/Tokyo',
      },
    }),
    headers: { Authorization: 'Bearer token-1', 'Content-Type': 'application/json' },
    method: 'PATCH',
  })
  expect(withWorkingDays.status).toBe(200)
  // Weekdays are stored Monday first and holidays sorted, both without duplicates.
  expect(updates.at(-1)).toEqual({
    ...body,
    locale: 'ja',
    calendar: {
      fiscalYearStartMonth: 4,
      weekStartDay: 1,
      workingWeekdays: ['monday', 'tuesday', 'saturday'],
      holidays: ['2027-01-01', '2027-05-03'],
      publicHolidays: 'none',
      timeZone: 'Asia/Tokyo',
    },
  })
})
