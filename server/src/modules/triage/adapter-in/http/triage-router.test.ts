import { describe, expect, test } from 'bun:test'
import {
  TRIAGE_CONFIGURATION_SCHEMA_VERSION,
  TRIAGE_ENTRY_SCHEMA_VERSION,
  type TriageConfiguration,
  type TriageEntry,
} from '@mukuroji/contracts'
import { createAuditEventId, createRequestFingerprint } from '../../../audit'
import { createTriageCapabilities, TriageError } from '../../domain/triage-entry'
import {
  createTriageBulkTargetIdempotencyKey,
  createTriageInputFingerprint,
  type TriageClient,
} from '../../triage'
import {
  createTriageRouter,
  type TriagePrincipal,
  type TriageRouterActionRequest,
  type TriageRouterBulkActionRequest,
  type TriageRouterDependencies,
} from './triage-router'

/** Stable router test instant. */
const NOW = '2026-08-09T00:00:00.000Z'

/** Creates a complete entry fixture with intentionally sensitive content.
 *
 * @param visibility Stored source visibility.
 * @param id Stable entry identifier.
 * @param projectId Optional selected Project.
 * @returns A complete entry fixture.
 */
function createEntry(
  visibility: TriageEntry['permission']['visibility'] = 'full',
  id = 'triage-1',
  projectId?: string,
): TriageEntry {
  const permission = {
    visibility,
    canReply: visibility === 'full',
    guestVisible: false,
    checkedAt: NOW,
  } satisfies TriageEntry['permission']
  return {
    schemaVersion: TRIAGE_ENTRY_SCHEMA_VERSION,
    id,
    workspaceId: 'workspace-1',
    source: { kind: 'chat', sourceId: 'thread-1', provider: 'slack' },
    sourcePreview: {
      title: 'Sensitive request',
      body: 'secret body',
      permalink: 'https://chat.example.com/thread/1',
      attachmentCount: 1,
      commentCount: 2,
      watcherCount: 1,
      sanitized: true,
      truncated: false,
    },
    requester: {
      displayName: 'Requester',
      email: 'requester@example.com',
      avatarUrl: 'https://cdn.example.com/avatar.png',
      guest: false,
    },
    receivedAt: NOW,
    lastActivityAt: NOW,
    state: 'pending',
    routing: {
      reason: 'Secret routing rule.',
      candidates: [{ teamId: 'support', reason: 'Secret match.', permitted: true }],
    },
    teamId: 'support',
    ...(projectId === undefined ? {} : { projectId }),
    permission,
    retention: { expiresAt: '2027-08-09T00:00:00.000Z' },
    capabilities: createTriageCapabilities({ state: 'pending', permission }),
    events: [{
      id: 'created-1',
      type: 'created',
      actorId: 'system:intake',
      summary: 'Sensitive internal event.',
      createdAt: NOW,
    }],
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

/** Creates safe Team settings for the client double. */
function createConfiguration(): TriageConfiguration {
  return {
    schemaVersion: TRIAGE_CONFIGURATION_SCHEMA_VERSION,
    workspaceId: 'workspace-1',
    teamId: 'support',
    rules: [],
    rotations: [],
    slaPolicies: [],
    allowedBulkActions: ['assign', 'decline', 'snooze'],
    retentionDays: 365,
    revision: 1,
    updatedAt: NOW,
  }
}

/** Creates a Project-scoped principal used by authorization boundary tests.
 *
 * @returns A write-capable principal restricted to the visible Project.
 */
function createProjectScopedTriagePrincipal(): TriagePrincipal {
  return {
    workspaceId: 'workspace-1',
    userId: 'member-1',
    auditActor: { id: 'actor-1', kind: 'user' },
    teamAccess: 'write',
    visibleProjectIds: ['project-visible'],
  }
}

/** Creates a complete TriageClient test double.
 *
 * @param entry Entry returned by read and mutation methods.
 * @returns A complete client boundary.
 */
function createClient(entry: TriageEntry, entries: TriageEntry[] = [entry]): TriageClient {
  let configurationReceipt: TriageConfiguration | undefined
  return {
    listEntries: async () => ({
      allowedBulkActions: ['assign', 'decline', 'snooze'],
      entries,
    }),
    getEntry: async (_workspaceId, _teamId, entryId) => {
      const matchingEntry = entries.find((candidate) => candidate.id === entryId)
      if (matchingEntry === undefined) {
        throw new TriageError(404, 'TriageEntryNotFound', 'Triage entry not found.')
      }
      return matchingEntry
    },
    applyAction: async () => ({ entry, replayed: false }),
    getActionReceipt: async () => undefined,
    applyBulkAction: async () => ({ results: [] }),
    getConfiguration: async () => createConfiguration(),
    getConfigurationUpdateReceipt: async () => configurationReceipt,
    updateConfiguration: async () => {
      configurationReceipt = createConfiguration()
      return configurationReceipt
    },
    createManualHandoff: async () => ({ entry, replayed: false }),
    listWorkItemSources: async () => ({ entries: [entry] }),
  }
}

/** Creates router dependencies and mutation call capture.
 *
 * @param entry Default mutation result entry.
 * @param principal Authenticated principal returned by the authorization double.
 * @param entries Queue and strong-read entries exposed by the client double.
 * @param overrides Optional dependency overrides.
 * @returns Router and captured mutation calls.
 */
function createDependencies(
  entry: TriageEntry,
  principal: TriagePrincipal = {
    workspaceId: 'workspace-1',
    userId: 'member-1',
    auditActor: { id: 'actor-1', kind: 'user' },
    teamAccess: 'write',
  },
  entries: TriageEntry[] = [entry],
  overrides: Partial<TriageRouterDependencies> = {},
) {
  const actions: TriageRouterActionRequest[] = []
  const bulkInputs: Parameters<TriageClient['applyBulkAction']>[3][] = []
  const bulkAuditContextFactories: Parameters<TriageClient['applyBulkAction']>[5][] = []
  const manualInputs: Parameters<TriageClient['createManualHandoff']>[3][] = []
  const manualIdempotencies: Parameters<TriageClient['createManualHandoff']>[4][] = []
  const configurationReceiptIdempotencies:
    Parameters<TriageClient['getConfigurationUpdateReceipt']>[2][] = []
  const configurationIdempotencies: Parameters<TriageClient['updateConfiguration']>[4][] = []
  const baseClient = createClient(entry, entries)
  const client: TriageClient = {
    ...baseClient,
    applyBulkAction: async (...parameters) => {
      bulkInputs.push(parameters[3])
      bulkAuditContextFactories.push(parameters[5])
      return await baseClient.applyBulkAction(...parameters)
    },
    createManualHandoff: async (...parameters) => {
      manualInputs.push(parameters[3])
      manualIdempotencies.push(parameters[4])
      return await baseClient.createManualHandoff(...parameters)
    },
    getConfigurationUpdateReceipt: async (...parameters) => {
      configurationReceiptIdempotencies.push(parameters[2])
      return await baseClient.getConfigurationUpdateReceipt(...parameters)
    },
    updateConfiguration: async (...parameters) => {
      configurationIdempotencies.push(parameters[4])
      return await baseClient.updateConfiguration(...parameters)
    },
  }
  const dependencies: TriageRouterDependencies = {
    getTriage: () => client,
    requireTeamAccess: async (_context, teamId) => {
      if (teamId !== 'support') throw new TriageError(404, 'TeamNotFound', 'Team not found.')
      return principal
    },
    requireWorkItemAccess: async () => {},
    readJson: async (request) => await request.json(),
    applyAction: async (request) => {
      actions.push(request)
      return { entry, replayed: false }
    },
    mapError: (context, error) => {
      if (error instanceof TriageError) {
        if (error.status === 400) return context.json({ code: error.code }, 400)
        if (error.status === 403) return context.json({ code: error.code }, 403)
        if (error.status === 404) return context.json({ code: error.code }, 404)
        return context.json({ code: error.code }, 409)
      }
      return context.json({ code: 'UnexpectedTriageError' }, 500)
    },
    ...overrides,
  }
  return {
    actions,
    bulkAuditContextFactories,
    bulkInputs,
    configurationIdempotencies,
    configurationReceiptIdempotencies,
    manualIdempotencies,
    manualInputs,
    router: createTriageRouter(dependencies),
  }
}

describe('triage HTTP router', () => {
  test('passes authenticated context to atomic accept-create orchestration', async () => {
    const { actions, router } = createDependencies(createEntry())
    const response = await router.request('/api/teams/support/triage-entries/triage-1/actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'accept-triage-1',
        'X-Correlation-Id': 'correlation-triage-1',
        'X-Request-Id': 'request-triage-1',
      },
      body: JSON.stringify({ action: 'accept', mode: 'create', expectedRevision: 1 }),
    })

    expect(response.status).toBe(200)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      workspaceId: 'workspace-1',
      teamId: 'support',
      entryId: 'triage-1',
      actor: { id: 'member-1' },
      action: { action: 'accept', mode: 'create', expectedRevision: 1 },
    })
    expect(actions[0]?.context.req.path).toBe(
      '/api/teams/support/triage-entries/triage-1/actions',
    )
    expect(actions[0]?.auditContext).toMatchObject({
      actor: { id: 'actor-1', kind: 'user' },
      correlationId: 'correlation-triage-1',
      source: {
        kind: 'api',
        requestId: 'request-triage-1',
        method: 'POST',
        route: '/api/teams/support/triage-entries/triage-1/actions',
      },
    })
  })

  test('preserves service and break-glass audit identity from authorization', async () => {
    const servicePrincipal: TriagePrincipal = {
      workspaceId: 'workspace-1',
      userId: 'member-1',
      auditActor: { id: 'service-account-1', kind: 'service' },
      teamAccess: 'write',
    }
    const serviceDependencies = createDependencies(createEntry(), servicePrincipal)
    const serviceResponse = await serviceDependencies.router.request(
      '/api/teams/support/triage-entries/triage-1/actions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'service-assign',
          'X-Correlation-Id': 'service-correlation-1',
        },
        body: JSON.stringify({
          action: 'assign',
          expectedRevision: 1,
          ownerUserId: null,
        }),
      },
    )
    expect(serviceResponse.status).toBe(200)
    expect(serviceDependencies.actions[0]?.auditContext).toMatchObject({
      actor: { id: 'service-account-1', kind: 'service' },
      correlationId: 'service-correlation-1',
    })

    const principal: TriagePrincipal = {
      workspaceId: 'workspace-1',
      userId: 'member-1',
      auditActor: { id: 'break-glass-actor-1', kind: 'break-glass' },
      auditCorrelationId: 'break-glass-activation-1',
      teamAccess: 'write',
    }
    const { actions, router } = createDependencies(createEntry(), principal)
    const response = await router.request(
      '/api/teams/support/triage-entries/triage-1/actions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'break-glass-assign',
          'X-Correlation-Id': 'client-correlation-must-not-win',
        },
        body: JSON.stringify({
          action: 'assign',
          expectedRevision: 1,
          ownerUserId: null,
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(actions[0]?.auditContext).toMatchObject({
      actor: { id: 'break-glass-actor-1', kind: 'break-glass' },
      correlationId: 'break-glass-activation-1',
    })
  })

  test('namespaces single-action audit identity across Entries sharing one raw key', async () => {
    const firstEntry = createEntry('full', 'triage-1')
    const secondEntry = createEntry('full', 'triage-2')
    const { actions, router } = createDependencies(
      firstEntry,
      undefined,
      [firstEntry, secondEntry],
    )
    const request = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'same-raw-key',
      },
      body: JSON.stringify({
        action: 'assign',
        expectedRevision: 1,
        ownerUserId: null,
      }),
    }

    const firstResponse = await router.request(
      '/api/teams/support/triage-entries/triage-1/actions',
      request,
    )
    const secondResponse = await router.request(
      '/api/teams/support/triage-entries/triage-2/actions',
      request,
    )
    const firstContext = actions[0]?.auditContext
    const secondContext = actions[1]?.auditContext
    if (!firstContext || !secondContext) {
      throw new TypeError('Expected both single-action audit contexts.')
    }

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(secondContext.idempotencyKeyHash).not.toBe(firstContext.idempotencyKeyHash)
    expect(secondContext.correlationId).not.toBe(firstContext.correlationId)
    expect(createAuditEventId(
      secondContext,
      'triage.assigned',
      { type: 'triage-entry', id: secondEntry.id },
    )).not.toBe(createAuditEventId(
      firstContext,
      'triage.assigned',
      { type: 'triage-entry', id: firstEntry.id },
    ))
  })

  test('projects denied source content before returning queue and action responses', async () => {
    const { router } = createDependencies(createEntry('denied'))
    const queueResponse = await router.request('/api/teams/support/triage-entries')
    const queueBody: unknown = await queueResponse.json()
    const actionResponse = await router.request('/api/teams/support/triage-entries/triage-1/actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'assign-triage-1',
      },
      body: JSON.stringify({ action: 'assign', expectedRevision: 1, ownerUserId: null }),
    })
    const actionBody: unknown = await actionResponse.json()

    expect(queueBody).toMatchObject({
      entries: [{
        sourcePreview: { title: 'Restricted source', body: '', attachmentCount: 0 },
        requester: { displayName: 'Restricted requester' },
        routing: { candidates: [] },
        events: [],
      }],
    })
    expect(JSON.stringify(queueBody)).not.toContain('secret body')
    expect(JSON.stringify(queueBody)).not.toContain('requester@example.com')
    expect(JSON.stringify(actionBody)).not.toContain('chat.example.com')
  })

  test('projects read-only Team access to non-mutating response capabilities', async () => {
    const entry = createEntry()
    const { router: viewerRouter } = createDependencies(entry, {
      workspaceId: 'workspace-1',
      userId: 'viewer-1',
      auditActor: { id: 'viewer-actor-1', kind: 'user' },
      teamAccess: 'read',
    })
    const { router: managerRouter } = createDependencies(entry, {
      workspaceId: 'workspace-1',
      userId: 'manager-1',
      auditActor: { id: 'manager-actor-1', kind: 'user' },
      teamAccess: 'manage',
    })

    const viewerResponse = await viewerRouter.request(
      '/api/teams/support/triage-entries/triage-1',
    )
    const managerResponse = await managerRouter.request(
      '/api/teams/support/triage-entries/triage-1',
    )
    const viewerQueueResponse = await viewerRouter.request('/api/teams/support/triage-entries')
    const managerQueueResponse = await managerRouter.request('/api/teams/support/triage-entries')
    const viewerBody: TriageEntry = await viewerResponse.json()
    const managerBody: TriageEntry = await managerResponse.json()
    const viewerQueueBody: { allowedBulkActions: string[] } = await viewerQueueResponse.json()
    const managerQueueBody: { allowedBulkActions: string[] } = await managerQueueResponse.json()

    expect(viewerBody.capabilities).toEqual({
      canAssign: false,
      canAcceptCreate: false,
      canAcceptLink: false,
      canMarkDuplicate: false,
      canDecline: false,
      canSnooze: false,
      canRequestInformation: false,
      canReply: false,
      canViewInternalContext: true,
    })
    expect(managerBody.capabilities).toEqual(entry.capabilities)
    expect(viewerQueueBody.allowedBulkActions).toEqual([])
    expect(managerQueueBody.allowedBulkActions).toEqual(['assign', 'decline', 'snooze'])
  })

  test('projects Enterprise Team read plus legacy Project write without widening scope', async () => {
    const writable = createEntry('full', 'triage-writable', 'project-writable')
    const readOnly = createEntry('full', 'triage-read-only', 'project-read-only')
    const unassigned = createEntry('full', 'triage-unassigned')
    const { router } = createDependencies(writable, {
      workspaceId: 'workspace-1',
      userId: 'mixed-member-1',
      auditActor: { id: 'mixed-actor-1', kind: 'user' },
      teamAccess: 'write',
      writableProjectIds: ['project-writable'],
    }, [writable, readOnly, unassigned])

    const response = await router.request('/api/teams/support/triage-entries')
    const body: { entries: TriageEntry[] } = await response.json()

    expect(body.entries.find(({ id }) => id === writable.id)?.capabilities.canDecline).toBe(true)
    expect(body.entries.find(({ id }) => id === readOnly.id)?.capabilities).toEqual({
      canAssign: false,
      canAcceptCreate: false,
      canAcceptLink: false,
      canMarkDuplicate: false,
      canDecline: false,
      canSnooze: false,
      canRequestInformation: false,
      canReply: false,
      canViewInternalContext: true,
    })
    expect(body.entries.find(({ id }) => id === unassigned.id)?.capabilities.canDecline).toBe(false)
  })

  test('requires an idempotency key and rejects unsupported action fields', async () => {
    const { router } = createDependencies(createEntry())
    const missingKey = await router.request('/api/teams/support/triage-entries/triage-1/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'decline', expectedRevision: 1, reason: 'No.' }),
    })
    const unknownField = await router.request('/api/teams/support/triage-entries/triage-1/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'decline-1' },
      body: JSON.stringify({
        action: 'decline',
        expectedRevision: 1,
        reason: 'No.',
        internalSecret: 'unexpected',
      }),
    })

    expect(missingKey.status).toBe(400)
    expect(unknownField.status).toBe(400)
  })

  test('accepts email-shaped Workspace member keys for assignment', async () => {
    const { actions, router } = createDependencies(createEntry())
    const response = await router.request('/api/teams/support/triage-entries/triage-1/actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'assign-member-email',
      },
      body: JSON.stringify({
        action: 'assign',
        expectedRevision: 1,
        ownerUserId: 'member@example.com',
      }),
    })

    expect(response.status).toBe(200)
    expect(actions[0]?.action).toMatchObject({ ownerUserId: 'member@example.com' })
  })

  test('filters queue entries and hides details outside a Project-scoped principal', async () => {
    const visible = createEntry('full', 'triage-visible', 'project-visible')
    visible.routing = {
      reason: 'Matched visible and hidden Project rules.',
      candidates: [
        {
          teamId: 'support',
          projectId: 'project-visible',
          reason: 'Visible candidate.',
          permitted: true,
        },
        {
          teamId: 'support',
          projectId: 'project-hidden',
          reason: 'Hidden candidate.',
          permitted: true,
        },
      ],
    }
    const hidden = createEntry('full', 'triage-hidden', 'project-hidden')
    const unassigned = createEntry('full', 'triage-unassigned')
    const principal: TriagePrincipal = createProjectScopedTriagePrincipal()
    const { router } = createDependencies(visible, principal, [visible, hidden, unassigned])

    const queueResponse = await router.request('/api/teams/support/triage-entries')
    const queueBody: unknown = await queueResponse.json()
    const hiddenDetail = await router.request(
      '/api/teams/support/triage-entries/triage-hidden',
    )
    const unassignedDetail = await router.request(
      '/api/teams/support/triage-entries/triage-unassigned',
    )

    expect(queueResponse.status).toBe(200)
    expect(queueBody).toMatchObject({ entries: [{ id: 'triage-visible' }] })
    expect(JSON.stringify(queueBody)).not.toContain('triage-hidden')
    expect(JSON.stringify(queueBody)).not.toContain('triage-unassigned')
    expect(JSON.stringify(queueBody)).not.toContain('Hidden candidate')
    expect(JSON.stringify(queueBody)).toContain('Visible candidate')
    expect(hiddenDetail.status).toBe(404)
    expect(unassignedDetail.status).toBe(404)
  })

  test('denies Team-wide settings to a Project-scoped principal', async () => {
    const principal: TriagePrincipal = createProjectScopedTriagePrincipal()
    const { router } = createDependencies(
      createEntry('full', 'triage-visible', 'project-visible'),
      principal,
    )

    const response = await router.request('/api/teams/support/triage-settings')

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ code: 'TriageSettingsAccessDenied' })
  })

  test('replays settings before live validation with a stable fingerprint', async () => {
    let validationCalls = 0
    const {
      configurationIdempotencies,
      configurationReceiptIdempotencies,
      router,
    } = createDependencies(createEntry(), undefined, undefined, {
      validateConfiguration: async () => {
        validationCalls += 1
      },
    })
    const input = {
      expectedRevision: 1,
      rules: [],
      rotations: [],
      slaPolicies: [],
      allowedBulkActions: ['assign', 'decline', 'snooze'],
      retentionDays: 365,
    }
    const request = {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'settings-response-loss',
      },
      body: JSON.stringify(input),
    }

    const missingKey = await router.request('/api/teams/support/triage-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    const first = await router.request('/api/teams/support/triage-settings', request)
    const retry = await router.request('/api/teams/support/triage-settings', request)

    expect(missingKey.status).toBe(400)
    expect(first.status).toBe(200)
    expect(retry.status).toBe(200)
    expect(validationCalls).toBe(1)
    expect(configurationIdempotencies).toEqual([
      {
        key: 'settings-response-loss',
        fingerprint: createTriageInputFingerprint({
          workspaceId: 'workspace-1',
          teamId: 'support',
          input,
        }),
      },
    ])
    expect(configurationReceiptIdempotencies).toEqual([
      {
        key: 'settings-response-loss',
        fingerprint: createTriageInputFingerprint({
          workspaceId: 'workspace-1',
          teamId: 'support',
          input,
        }),
      },
      {
        key: 'settings-response-loss',
        fingerprint: createTriageInputFingerprint({
          workspaceId: 'workspace-1',
          teamId: 'support',
          input,
        }),
      },
    ])
  })

  test('fails closed before single actions outside the current or destination Project scope', async () => {
    const visible = createEntry('full', 'triage-visible', 'project-visible')
    const hidden = createEntry('full', 'triage-hidden', 'project-hidden')
    const principal: TriagePrincipal = createProjectScopedTriagePrincipal()
    const { actions, router } = createDependencies(visible, principal, [visible, hidden])
    const headers = {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'project-scoped-action',
    }

    const hiddenEntryResponse = await router.request(
      '/api/teams/support/triage-entries/triage-hidden/actions',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'decline',
          expectedRevision: 1,
          reason: 'Not actionable.',
        }),
      },
    )
    const hiddenDestinationResponse = await router.request(
      '/api/teams/support/triage-entries/triage-visible/actions',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'assign',
          expectedRevision: 1,
          ownerUserId: null,
          projectId: 'project-hidden',
        }),
      },
    )

    expect(hiddenEntryResponse.status).toBe(404)
    expect(hiddenDestinationResponse.status).toBe(404)
    expect(actions).toHaveLength(0)
  })

  test('validates visible bulk actions and rejects hidden targets or destinations first', async () => {
    const visible = createEntry('full', 'triage-visible', 'project-visible')
    const hidden = createEntry('full', 'triage-hidden', 'project-hidden')
    const principal: TriagePrincipal = createProjectScopedTriagePrincipal()
    const validated: Parameters<NonNullable<TriageRouterDependencies['validateBulkAction']>>[2][] = []
    const { bulkAuditContextFactories, bulkInputs, router } = createDependencies(
      visible,
      principal,
      [visible, hidden],
      {
        validateBulkAction: async (_context, _teamId, input) => {
          validated.push(input)
        },
      },
    )
    const headers = {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'project-scoped-bulk',
      'X-Correlation-Id': 'correlation-bulk-1',
    }

    const hiddenTargetResponse = await router.request(
      '/api/teams/support/triage-entries/bulk-actions',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          targets: [{ entryId: 'triage-hidden', expectedRevision: 1 }],
          operation: { action: 'decline', reason: 'Not actionable.' },
        }),
      },
    )
    const hiddenDestinationResponse = await router.request(
      '/api/teams/support/triage-entries/bulk-actions',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          targets: [{ entryId: 'triage-visible', expectedRevision: 1 }],
          operation: { action: 'assign', ownerUserId: null, projectId: 'project-hidden' },
        }),
      },
    )
    const visibleResponse = await router.request(
      '/api/teams/support/triage-entries/bulk-actions',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          targets: [{ entryId: 'triage-visible', expectedRevision: 1 }],
          operation: { action: 'assign', ownerUserId: null, projectId: 'project-visible' },
        }),
      },
    )

    expect(hiddenTargetResponse.status).toBe(404)
    expect(hiddenDestinationResponse.status).toBe(404)
    expect(visibleResponse.status).toBe(200)
    expect(validated).toHaveLength(1)
    expect(bulkInputs).toHaveLength(1)
    const createAuditContext = bulkAuditContextFactories[0]
    if (!createAuditContext || !bulkInputs[0]) {
      throw new TypeError('Expected the bulk audit context factory and parsed input.')
    }
    const target = bulkInputs[0].targets[0]
    if (!target) throw new TypeError('Expected one parsed bulk target.')
    const auditContext = createAuditContext('triage-visible', {
      key: createTriageBulkTargetIdempotencyKey('project-scoped-bulk', target.entryId),
      fingerprint: createTriageInputFingerprint({
        target,
        operation: bulkInputs[0].operation,
      }),
    })
    expect(auditContext).toMatchObject({
      correlationId: 'correlation-bulk-1',
      source: {
        method: 'POST',
        route: '/api/teams/support/triage-entries/bulk-actions',
      },
      requestFingerprint: createRequestFingerprint({
        method: 'POST',
        path: '/api/teams/support/triage-entries/bulk-actions',
        body: bulkInputs[0],
      }),
    })
  })

  test('carries the bulk configuration revision into target orchestration', async () => {
    const requests: TriageRouterBulkActionRequest[] = []
    const { router } = createDependencies(createEntry(), undefined, undefined, {
      validateBulkAction: async () => 7,
      applyBulkAction: async (request) => {
        requests.push(request)
        return { results: [] }
      },
    })

    const response = await router.request('/api/teams/support/triage-entries/bulk-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'bulk-config-fence',
      },
      body: JSON.stringify({
        targets: [{ entryId: 'triage-1', expectedRevision: 1 }],
        operation: { action: 'decline', reason: 'Handled elsewhere.' },
      }),
    })

    expect(response.status).toBe(200)
    expect(requests[0]?.configurationRevision).toBe(7)
  })

  test('rejects a prepared manual handoff outside the principal Project scope', async () => {
    const visible = createEntry('full', 'triage-visible', 'project-visible')
    const principal: TriagePrincipal = createProjectScopedTriagePrincipal()
    const { manualInputs, router } = createDependencies(
      visible,
      principal,
      [visible],
      {
        prepareManualHandoff: async (_context, _teamId, input) => ({
          ...input,
          projectId: 'project-hidden',
        }),
      },
    )

    const response = await router.request(
      '/api/teams/support/triage-entries/manual-handoffs',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'project-scoped-manual',
        },
        body: JSON.stringify({
          sourceId: 'manual-1',
          title: 'Internal escalation',
          body: '',
          requesterDisplayName: 'Operator',
          projectId: 'project-visible',
          routingReason: 'Operator handoff.',
          retentionExpiresAt: '2027-08-09T00:00:00.000Z',
        }),
      },
    )

    expect(response.status).toBe(404)
    expect(manualInputs).toHaveLength(0)
  })

  test('keeps manual response-loss replay fingerprints stable across derived deadline changes', async () => {
    const entry = createEntry()
    let preparationCount = 0
    const { manualIdempotencies, manualInputs, router } = createDependencies(
      entry,
      undefined,
      [entry],
      {
        prepareManualHandoff: async (_context, _teamId, input) => {
          preparationCount += 1
          return {
            ...input,
            ownerUserId: 'configured-owner@example.com',
            slaPolicyId: 'manual-sla',
            slaDueAt: preparationCount === 1
              ? '2026-08-09T01:00:00.000Z'
              : '2026-08-09T01:00:01.000Z',
            retentionExpiresAt: preparationCount === 1
              ? '2026-09-08T00:00:00.000Z'
              : '2026-09-08T00:00:01.000Z',
          }
        },
      },
    )
    const request = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'manual-response-loss',
      },
      body: JSON.stringify({
        sourceId: 'manual-response-loss-1',
        title: 'Internal escalation',
        body: '',
        requesterDisplayName: 'Operator',
        routingReason: 'Operator handoff.',
        retentionExpiresAt: '2027-08-09T00:00:00.000Z',
      }),
    }

    const first = await router.request(
      '/api/teams/support/triage-entries/manual-handoffs',
      request,
    )
    const retry = await router.request(
      '/api/teams/support/triage-entries/manual-handoffs',
      request,
    )

    expect(first.status).toBe(201)
    expect(retry.status).toBe(201)
    expect(manualInputs.map(({ slaDueAt }) => slaDueAt)).toEqual([
      '2026-08-09T01:00:00.000Z',
      '2026-08-09T01:00:01.000Z',
    ])
    expect(manualIdempotencies).toHaveLength(2)
    expect(manualIdempotencies[1]).toEqual(manualIdempotencies[0])
  })

  test('fails closed when the committed manual handoff moves outside Project scope', async () => {
    const hidden = createEntry('full', 'triage-hidden', 'project-hidden')
    const principal: TriagePrincipal = createProjectScopedTriagePrincipal()
    const { manualInputs, router } = createDependencies(
      hidden,
      principal,
      [hidden],
      {
        prepareManualHandoff: async (_context, _teamId, input) => ({
          ...input,
          projectId: 'project-visible',
        }),
      },
    )

    const response = await router.request(
      '/api/teams/support/triage-entries/manual-handoffs',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'manual-project-race',
        },
        body: JSON.stringify({
          sourceId: 'manual-project-race-1',
          title: 'Internal escalation',
          body: '',
          requesterDisplayName: 'Operator',
          projectId: 'project-visible',
          routingReason: 'Operator handoff.',
          retentionExpiresAt: '2027-08-09T00:00:00.000Z',
        }),
      },
    )

    expect(response.status).toBe(404)
    expect(manualInputs).toHaveLength(1)
  })
})
