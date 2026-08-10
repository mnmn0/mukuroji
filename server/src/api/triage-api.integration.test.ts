import { afterEach, describe, expect, test } from 'bun:test'
import {
  REQUEST_FORM_SCHEMA_VERSION,
  REQUEST_SUBMISSION_SCHEMA_VERSION,
  TRIAGE_CONFIGURATION_SCHEMA_VERSION,
  TRIAGE_ENTRY_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  createDefaultUnscheduledWorkItemSchedule,
  type EnterpriseCustomRoleId,
  type RequestSubmission,
  type TriageConfiguration,
  type TriageEntry,
} from '@mukuroji/contracts'
import { createApiTestHarness } from './test-support/api-test-harness'
import type { TriageCompositionClient } from '../app/composition/app-dependencies'
import {
  RequestIntakeError,
  type RequestIntakeClient,
} from '../modules/request-intake'
import type {
  CreateTeamIssueRequestBody,
  TeamIssueResponseItem,
} from '../modules/work-items'
import { createTriageCapabilities, TriageError } from '../modules/triage/domain/triage-entry'
import { InMemoryEnterpriseIdentityClient } from '../modules/enterprise-identity/enterprise-identity'

const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  createFakeWorkItemConfigurationClient,
  createTeamIssuesFake,
  createTestWorkItemConfiguration,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()

/** Stable instant used by API integration fixtures. */
const NOW = '2026-08-09T00:00:00.000Z'

/** Creates a complete pending entry owned by the harness Team.
 *
 * @param overrides - Entry fields replaced for a test scenario.
 * @returns A canonical pending Triage Entry.
 */
function createEntry(overrides: Partial<TriageEntry> = {}): TriageEntry {
  const permission = {
    visibility: 'full',
    canReply: true,
    guestVisible: false,
    checkedAt: NOW,
  } satisfies TriageEntry['permission']
  return {
    schemaVersion: TRIAGE_ENTRY_SCHEMA_VERSION,
    id: 'triage-api-1',
    workspaceId: 'user#demo@example.com',
    source: {
      kind: 'chat',
      sourceId: 'source-api-1',
      provider: 'slack',
      containerId: 'channel-1',
      messageId: 'message-1',
    },
    sourcePreview: {
      title: 'Customer cannot finish onboarding',
      body: 'The final step keeps failing.',
      channelLabel: '#customer-support',
      permalink: 'https://chat.example.test/messages/1',
      attachmentCount: 1,
      commentCount: 2,
      watcherCount: 1,
      sanitized: true,
      truncated: false,
    },
    requester: {
      displayName: 'Customer One',
      email: 'customer@example.test',
      externalId: 'customer-1',
      guest: true,
    },
    receivedAt: NOW,
    lastActivityAt: NOW,
    state: 'pending',
    routing: {
      reason: 'Matched the onboarding routing rule.',
      candidates: [{
        teamId: 'core-team',
        projectId: 'refero',
        reason: 'The message mentions onboarding.',
        ruleId: 'onboarding',
        permitted: true,
      }],
    },
    teamId: 'core-team',
    projectId: 'refero',
    ownerUserId: 'demo@example.com',
    permission,
    retention: { expiresAt: '2027-08-09T00:00:00.000Z' },
    capabilities: createTriageCapabilities({ state: 'pending', permission }),
    events: [{
      id: 'event-created-1',
      type: 'created',
      actorId: 'system:intake',
      summary: 'Chat message entered Team triage.',
      createdAt: NOW,
    }],
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/** Creates the Team settings returned by the Triage client fake.
 *
 * @returns Stable empty routing settings for the harness Team.
 */
function createConfiguration(
  overrides: Partial<TriageConfiguration> = {},
): TriageConfiguration {
  return {
    allowedBulkActions: ['assign', 'decline', 'snooze'],
    schemaVersion: TRIAGE_CONFIGURATION_SCHEMA_VERSION,
    workspaceId: 'user#demo@example.com',
    teamId: 'core-team',
    rules: [],
    rotations: [],
    slaPolicies: [],
    retentionDays: 365,
    revision: 0,
    updatedAt: NOW,
    ...overrides,
  }
}

/** Creates a complete Triage composition fake around one entry.
 *
 * @param entry - Entry returned by read and mutation operations.
 * @param configuration - Team settings returned by strong configuration reads.
 * @param entries - Entries returned by the queue read.
 * @returns A complete composition client suitable for the API dependency graph.
 */
function createTriageClient(
  entry: TriageEntry,
  configuration = createConfiguration(),
  entries: readonly TriageEntry[] = [entry],
): TriageCompositionClient {
  return {
    listEntries: async () => ({
      allowedBulkActions: configuration.allowedBulkActions,
      entries: [...entries],
    }),
    getEntry: async (_workspaceId, _teamId, entryId) =>
      entries.find((candidate) => candidate.id === entryId) ?? entry,
    getEntryForMutation: async (_workspaceId, _teamId, entryId) =>
      entries.find((candidate) => candidate.id === entryId) ?? entry,
    applyAction: async () => ({ entry, replayed: false }),
    getActionReceipt: async () => undefined,
    applyBulkAction: async () => ({ results: [] }),
    getConfiguration: async () => configuration,
    getConfigurationUpdateReceipt: async () => undefined,
    updateConfiguration: async () => createConfiguration(),
    createManualHandoff: async () => ({ entry, replayed: false }),
    listWorkItemSources: async () => ({ entries: [entry] }),
  }
}

/**
 * Creates a complete Request Intake test port around focused overrides.
 *
 * @param overrides - Request operations exercised by the focused Triage test.
 * @returns A complete port whose unrelated operations fail immediately.
 */
function createRequestIntakeClient(
  overrides: Readonly<Partial<RequestIntakeClient>>,
): RequestIntakeClient {
  const unsupported = async () => {
    throw new Error('Unexpected Request Intake client call in Triage API test.')
  }
  return {
    listForms: unsupported,
    getForm: unsupported,
    createForm: unsupported,
    updateForm: unsupported,
    publishForm: unsupported,
    resolveLink: unsupported,
    getPublicForm: unsupported,
    createAttachmentUpload: unsupported,
    submit: unsupported,
    listSubmissions: unsupported,
    getSubmission: unsupported,
    applyAction: unsupported,
    completeConversion: unsupported,
    getRequesterThread: unsupported,
    replyToThread: unsupported,
    ingestEmail: unsupported,
    createAttachmentAccess: unsupported,
    ...overrides,
  }
}

/**
 * Creates a Form submission whose Work Item mapping exercises every mapped field.
 *
 * @returns A canonical Request submission used by Form-source acceptance tests.
 */
function createMappedFormSubmission(): RequestSubmission {
  const definition: RequestSubmission['formSnapshot']['snapshot']['definition'] = {
    defaultLocale: 'en',
    supportedLocales: ['en'],
    title: { en: 'Support request' },
    sections: [{
      id: 'details',
      title: { en: 'Details' },
      fields: [
        {
          id: 'title',
          type: 'short-text' as const,
          label: { en: 'Title' },
          validation: { required: true },
        },
        {
          id: 'description',
          type: 'long-text' as const,
          label: { en: 'Description' },
          validation: { required: true },
        },
        {
          id: 'channel',
          type: 'short-text' as const,
          label: { en: 'Channel' },
        },
        {
          id: 'estimate',
          type: 'number' as const,
          label: { en: 'Estimate' },
        },
      ],
    }],
    confirmation: { message: { en: 'Received.' } },
  }
  const routing: RequestSubmission['formSnapshot']['snapshot']['routing'] = {
    defaultTarget: {
      teamId: 'core-team',
      projectId: 'refero',
      workflowStatusId: 'todo',
      assigneeUserId: 'demo@example.com',
      priority: 'high' as const,
      dueDateOffsetDays: 3,
    },
    rules: [],
    mapping: {
      titleFieldId: 'title',
      descriptionFieldIds: ['description'],
      customFieldMappings: {
        channel: 'request-channel',
        estimate: 'estimate',
      },
    },
  }
  return {
    schemaVersion: REQUEST_SUBMISSION_SCHEMA_VERSION,
    id: 'request-mapped-1',
    receiptId: 'receipt-mapped-1',
    formId: 'form-mapped-1',
    formVersion: 1,
    formSnapshot: {
      schemaVersion: REQUEST_FORM_SCHEMA_VERSION,
      formId: 'form-mapped-1',
      version: 1,
      snapshot: { definition, routing },
      createdBy: 'demo@example.com',
      createdAt: NOW,
    },
    status: 'received',
    source: 'web',
    revision: 1,
    locale: 'en',
    answers: {
      title: 'Mapped outage title',
      description: 'Mapped outage description',
      channel: 'customer-success',
      estimate: 8,
    },
    attachments: [],
    routingTarget: routing.defaultTarget,
    workItemMapping: routing.mapping,
    duplicateCandidateIds: [],
    messages: [],
    events: [{
      id: 'request-submitted-1',
      type: 'submitted',
      actorId: 'requester',
      summary: 'Request was submitted.',
      createdAt: NOW,
    }],
    createdAt: NOW,
    updatedAt: NOW,
    capabilities: {
      canAssign: true,
      canRequestMoreInfo: true,
      canReject: true,
      canMarkDuplicate: true,
      canConvert: true,
    },
  }
}

/** Creates a Work Item response that proves its originating Triage Entry.
 *
 * @param id - Deterministic Work Item identifier selected by the API.
 * @param sourceTriageEntryId - Source entry committed with the Work Item.
 * @returns A canonical Work Item response fixture.
 */
function createAcceptedWorkItem(
  id: string,
  sourceTriageEntryId: string,
): TeamIssueResponseItem {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id,
    teamId: 'core-team',
    assignedProjectId: 'refero',
    title: 'Customer cannot finish onboarding',
    description: 'The final step keeps failing.',
    assigneeUserId: 'demo@example.com',
    creatorMemberKey: 'demo@example.com',
    sourceTriageEntryId,
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '',
    schedule: createDefaultUnscheduledWorkItemSchedule(),
    priority: 'medium',
    createdAt: NOW,
    updatedAt: NOW,
    source: 'dynamodb',
  }
}

/** Creates common authenticated request headers.
 *
 * @param idempotencyKey - Optional replay key for mutation routes.
 * @returns Headers accepted by the API harness authentication fake.
 */
function createHeaders(idempotencyKey?: string): Record<string, string> {
  return {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  }
}

/** Creates an applied Team-scoped Enterprise role for the authenticated test member.
 *
 * @param permission - Team permission granted by the custom role.
 * @param projectMemberProjectId - Optional Project receiving an additional member role.
 * @returns An Enterprise Identity client containing the applied directory mapping.
 */
async function createEnterpriseTriageIdentity(
  permission: 'teams.read' | 'teams.write',
  projectMemberProjectId?: string,
): Promise<InMemoryEnterpriseIdentityClient> {
  const workspaceId = 'user#demo@example.com'
  const identity = new InMemoryEnterpriseIdentityClient()
  const suffix = permission === 'teams.read' ? 'reader' : 'writer'
  await identity.putIdentityProvider({
    workspaceId,
    providerId: `idp-triage-${suffix}`,
    kind: 'oidc',
    displayName: 'Triage directory',
    cognitoProviderName: 'EnterpriseOidc',
    status: 'active',
    revision: 1,
    issuer: 'https://idp.example.com',
    clientId: 'enterprise-client',
    authorizationEndpoint: 'https://idp.example.com/authorize',
    tokenEndpoint: 'https://idp.example.com/token',
    jwksUri: 'https://idp.example.com/jwks',
    scopes: ['openid', 'email'],
    createdAt: NOW,
    updatedAt: NOW,
    lastTestedAt: NOW,
  })
  await identity.putCustomRole({
    workspaceId,
    roleId: `custom:triage-${suffix}`,
    name: `Triage ${suffix}`,
    permissions: permission === 'teams.read'
      ? ['teams.read']
      : ['teams.read', 'teams.write'],
    guestAssignable: false,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  })
  const user = await identity.upsertScimUser({
    workspaceId,
    identityProviderId: `idp-triage-${suffix}`,
    externalId: `triage-${suffix}-user`,
    userName: 'demo@example.com',
    emails: ['demo@example.com'],
    active: true,
    linkedMemberKey: 'demo@example.com',
    idempotencyKey: `triage-${suffix}-user`,
  })
  const group = await identity.upsertScimGroup({
    workspaceId,
    identityProviderId: `idp-triage-${suffix}`,
    externalId: `triage-${suffix}s`,
    displayName: `Triage ${suffix}s`,
    active: true,
    memberUserIds: [user.userId],
    idempotencyKey: `triage-${suffix}-group`,
  })
  const desiredUser = (await identity.getSnapshot(workspaceId)).scimUsers.find((candidate) =>
    candidate.userId === user.userId
  )
  if (!desiredUser) throw new Error('Expected the Enterprise Triage user to exist.')
  await identity.markScimUserApplied(workspaceId, desiredUser.userId, desiredUser.version)
  await identity.markScimGroupApplied(workspaceId, group.groupId, group.version)
  await identity.putGroupMapping({
    workspaceId,
    mappingId: `triage-${suffix}-mapping`,
    identityProviderId: `idp-triage-${suffix}`,
    directoryGroupId: group.groupId,
    roleId: `custom:triage-${suffix}`,
    scope: { workspaceId, kind: 'team', targetId: 'core-team' },
    enabled: true,
    priority: 0,
    revision: 1,
    updatedAt: NOW,
  })
  if (projectMemberProjectId) {
    const projectWriterRoleId: EnterpriseCustomRoleId =
      `custom:triage-${suffix}-project-writer`
    await identity.putCustomRole({
      workspaceId,
      roleId: projectWriterRoleId,
      name: `Triage ${suffix} Project writer`,
      permissions: ['teams.read', 'teams.write'],
      guestAssignable: false,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await identity.putGroupMapping({
      workspaceId,
      mappingId: `triage-${suffix}-project-member-mapping`,
      identityProviderId: `idp-triage-${suffix}`,
      directoryGroupId: group.groupId,
      roleId: projectWriterRoleId,
      scope: {
        workspaceId,
        kind: 'project',
        targetId: projectMemberProjectId,
      },
      enabled: true,
      priority: 1,
      revision: 1,
      updatedAt: NOW,
    })
  }
  return identity
}

afterEach(() => {
  resetTestApp()
})

describe('Team Triage API composition', () => {
  test('denies unauthenticated and guest principals before reading the queue', async () => {
    const entry = createEntry()
    const unauthenticated = await app.request('/api/teams/core-team/triage-entries')

    expect(unauthenticated.status).toBe(401)
    expect(await unauthenticated.json()).toEqual({
      code: 'TriageAuthenticationRequired',
      message: 'Bearer token is required.',
    })

    configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'guest' })
    setTestAppDependencies({ triage: createTriageClient(entry) })
    const guest = await app.request('/api/teams/core-team/triage-entries', {
      headers: createHeaders(),
    })

    expect(guest.status).toBe(403)
    expect(await guest.json()).toEqual({
      code: 'WorkspaceRoleDenied',
      message: 'Guest members cannot access the Team Triage queue.',
    })
  })

  test('mounts list, detail, and read-only settings while denying viewer writes', async () => {
    const entry = createEntry()
    const calls = configureFakeProjectClients(true, {
      role: 'viewer',
      workspaceRole: 'member',
    })
    setTestAppDependencies({ triage: createTriageClient(entry) })

    const [list, detail, action, settings, settingsUpdate] = await Promise.all([
      app.request('/api/teams/core-team/triage-entries?state=pending&limit=25', {
        headers: createHeaders(),
      }),
      app.request('/api/teams/core-team/triage-entries/triage-api-1', {
        headers: createHeaders(),
      }),
      app.request('/api/teams/core-team/triage-entries/triage-api-1/actions', {
        method: 'POST',
        headers: createHeaders('viewer-decline'),
        body: JSON.stringify({
          action: 'decline',
          expectedRevision: 1,
          reason: 'Out of scope.',
        }),
      }),
      app.request('/api/teams/core-team/triage-settings', {
        headers: createHeaders(),
      }),
      app.request('/api/teams/core-team/triage-settings', {
        method: 'PUT',
        headers: createHeaders(),
        body: JSON.stringify({
          allowedBulkActions: ['assign', 'decline', 'snooze'],
          expectedRevision: 0,
          rules: [],
          rotations: [],
          slaPolicies: [],
          retentionDays: 365,
        }),
      }),
    ])

    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({
      allowedBulkActions: [],
      entries: [{
        id: 'triage-api-1',
        capabilities: {
          canAssign: false,
          canAcceptCreate: false,
          canAcceptLink: false,
          canMarkDuplicate: false,
          canDecline: false,
          canSnooze: false,
          canRequestInformation: false,
          canReply: false,
          canViewInternalContext: true,
        },
      }],
    })
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({
      id: 'triage-api-1',
      teamId: 'core-team',
      capabilities: { canAssign: false, canDecline: false, canReply: false },
    })
    expect(action.status).toBe(403)
    expect(settings.status).toBe(200)
    expect(settingsUpdate.status).toBe(403)
    expect(calls.accessChecks.length).toBeGreaterThan(0)
  })

  test('allows a member to mutate but reserves settings for a Team manager', async () => {
    const entry = createEntry()
    configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
    setTestAppDependencies({ triage: createTriageClient(entry) })

    const memberAction = await app.request(
      '/api/teams/core-team/triage-entries/triage-api-1/actions',
      {
        method: 'POST',
        headers: createHeaders('member-decline'),
        body: JSON.stringify({
          action: 'decline',
          expectedRevision: 1,
          reason: 'Handled elsewhere.',
        }),
      },
    )
    const memberSettingsUpdate = await app.request('/api/teams/core-team/triage-settings', {
      method: 'PUT',
      headers: createHeaders(),
      body: JSON.stringify({
        allowedBulkActions: ['assign', 'decline', 'snooze'],
        expectedRevision: 0,
        rules: [],
        rotations: [],
        slaPolicies: [],
        retentionDays: 365,
      }),
    })

    expect(memberAction.status).toBe(200)
    expect(await memberAction.json()).toMatchObject({
      entry: { capabilities: { canAssign: true, canDecline: true, canReply: true } },
    })
    expect(memberSettingsUpdate.status).toBe(403)

    configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
    setTestAppDependencies({ triage: createTriageClient(entry) })
    const managerSettings = await app.request('/api/teams/core-team/triage-settings', {
      method: 'PUT',
      headers: createHeaders('manager-settings-update'),
      body: JSON.stringify({
        allowedBulkActions: ['assign', 'decline', 'snooze'],
        expectedRevision: 0,
        rules: [],
        rotations: [],
        slaPolicies: [],
        retentionDays: 365,
      }),
    })
    const managerEntry = await app.request('/api/teams/core-team/triage-entries/triage-api-1', {
      headers: createHeaders(),
    })

    const managerSettingsBody: unknown = await managerSettings.json()
    expect({ body: managerSettingsBody, status: managerSettings.status }).toMatchObject({
      status: 200,
    })
    expect(managerSettingsBody).toEqual(createConfiguration())
    expect(managerEntry.status).toBe(200)
    expect(await managerEntry.json()).toMatchObject({
      capabilities: { canAssign: true, canDecline: true, canReply: true },
    })
  })

  test('keeps Workspace administrators read-only while preserving system administrator writes', async () => {
    const entry = createEntry()
    configureFakeProjectClients(true, {
      role: 'viewer',
      workspaceRole: 'admin',
    })
    setTestAppDependencies({ triage: createTriageClient(entry) })

    const workspaceAdmin = await app.request(
      '/api/teams/core-team/triage-entries/triage-api-1',
      { headers: createHeaders() },
    )
    expect(workspaceAdmin.status).toBe(200)
    expect(await workspaceAdmin.json()).toMatchObject({
      capabilities: { canAssign: false, canDecline: false, canReply: false },
    })

    configureFakeProjectClients(false, {
      role: 'viewer',
      systemAdminMemberKeys: ['demo@example.com'],
      workspaceRole: 'member',
    })
    setTestAppDependencies({ triage: createTriageClient(entry) })
    const systemAdmin = await app.request(
      '/api/teams/core-team/triage-entries/triage-api-1',
      { headers: createHeaders() },
    )

    expect(systemAdmin.status).toBe(200)
    expect(await systemAdmin.json()).toMatchObject({
      capabilities: { canAssign: true, canDecline: true, canReply: true },
    })
  })

  test('projects Team-scoped Enterprise read and write permissions without widening them', async () => {
    await withTestEnvironment({
      COGNITO_CLIENT_ID: 'mukuroji-main-client',
      COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
      COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
      COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
    }, async () => {
      const entry = createEntry()
      const enterpriseHeaders = {
        Authorization: `Bearer ${createAccessToken([], {
          client_id: 'mukuroji-main-client',
          token_use: 'access',
        })}`,
      }
      configureFakeProjectClients(false, {
        workspaceRole: 'member',
        teamProjects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
      })
      setTestAppDependencies({
        enterpriseIdentity: await createEnterpriseTriageIdentity('teams.read'),
        triage: createTriageClient(entry),
      })
      const reader = await app.request(
        '/api/teams/core-team/triage-entries/triage-api-1',
        { headers: enterpriseHeaders },
      )
      expect(reader.status).toBe(200)
      expect(await reader.json()).toMatchObject({
        capabilities: { canAssign: false, canDecline: false, canReply: false },
      })

      const projectAEntry = createEntry({
        id: 'triage-project-a',
        projectId: 'project-a',
      })
      const projectBEntry = createEntry({
        id: 'triage-project-b',
        projectId: 'project-b',
      })
      const unassignedEntry = createEntry({
        id: 'triage-unassigned',
        projectId: undefined,
      })
      configureFakeProjectClients(false, {
        workspaceRole: 'member',
        teamProjects: [
          { id: 'project-a', name: 'Project A', tone: 'blue' },
          { id: 'project-b', name: 'Project B', tone: 'purple' },
        ],
      })
      setTestAppDependencies({
        enterpriseIdentity: await createEnterpriseTriageIdentity('teams.read', 'project-a'),
        triage: createTriageClient(
          projectAEntry,
          createConfiguration(),
          [projectAEntry, projectBEntry, unassignedEntry],
        ),
      })
      const mixedAccess = await app.request(
        '/api/teams/core-team/triage-entries',
        { headers: enterpriseHeaders },
      )
      expect(mixedAccess.status).toBe(200)
      expect(await mixedAccess.json()).toMatchObject({
        entries: [
          { id: 'triage-project-a', capabilities: { canAssign: true } },
          { id: 'triage-project-b', capabilities: { canAssign: false } },
          { id: 'triage-unassigned', capabilities: { canAssign: false } },
        ],
      })
      const writableAction = await app.request(
        '/api/teams/core-team/triage-entries/triage-project-a/actions',
        {
          method: 'POST',
          headers: {
            ...enterpriseHeaders,
            'Content-Type': 'application/json',
            'Idempotency-Key': 'mixed-project-a-assign',
          },
          body: JSON.stringify({
            action: 'assign',
            expectedRevision: 1,
            ownerUserId: null,
          }),
        },
      )
      const readOnlyAction = await app.request(
        '/api/teams/core-team/triage-entries/triage-project-b/actions',
        {
          method: 'POST',
          headers: {
            ...enterpriseHeaders,
            'Content-Type': 'application/json',
            'Idempotency-Key': 'mixed-project-b-assign',
          },
          body: JSON.stringify({
            action: 'assign',
            expectedRevision: 1,
            ownerUserId: null,
          }),
        },
      )
      expect(writableAction.status).toBe(200)
      expect(readOnlyAction.status).toBe(404)

      configureFakeProjectClients(false, {
        workspaceRole: 'member',
        teamProjects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
      })
      setTestAppDependencies({
        enterpriseIdentity: await createEnterpriseTriageIdentity('teams.write'),
        triage: createTriageClient(entry),
      })
      const writer = await app.request(
        '/api/teams/core-team/triage-entries/triage-api-1',
        { headers: enterpriseHeaders },
      )
      expect(writer.status).toBe(200)
      expect(await writer.json()).toMatchObject({
        capabilities: { canAssign: true, canDecline: true, canReply: true },
      })
    })
  })

  test('rejects a bulk operation disabled by the current Team configuration', async () => {
    const entry = createEntry()
    let configurationReadCount = 0
    let bulkMutationCount = 0
    const triage = {
      ...createTriageClient(entry, createConfiguration({
        allowedBulkActions: ['assign'],
      })),
      getConfiguration: async () => {
        configurationReadCount += 1
        return createConfiguration({ allowedBulkActions: ['assign'] })
      },
      applyAction: async () => {
        bulkMutationCount += 1
        return { entry, replayed: false }
      },
    } satisfies TriageCompositionClient
    configureFakeProjectClients(true, {
      role: 'member',
      workspaceRole: 'member',
      projectAccesses: [{ projectId: 'refero', role: 'member' }],
    })
    setTestAppDependencies({ triage })

    const disabled = await app.request('/api/teams/core-team/triage-entries/bulk-actions', {
      method: 'POST',
      headers: createHeaders('disabled-bulk-decline'),
      body: JSON.stringify({
        targets: [{ entryId: entry.id, expectedRevision: entry.revision }],
        operation: { action: 'decline', reason: 'Not actionable.' },
      }),
    })
    const allowed = await app.request('/api/teams/core-team/triage-entries/bulk-actions', {
      method: 'POST',
      headers: createHeaders('allowed-bulk-assign'),
      body: JSON.stringify({
        targets: [{ entryId: entry.id, expectedRevision: entry.revision }],
        operation: { action: 'assign', ownerUserId: null },
      }),
    })
    expect(disabled.status).toBe(409)
    expect(await disabled.json()).toEqual({
      code: 'TriageBulkActionDisabled',
      message: 'This bulk action is disabled by the current Team Triage configuration.',
    })
    expect(allowed.status).toBe(200)
    expect(configurationReadCount).toBe(2)
    expect(bulkMutationCount).toBe(1)
  })

  test('hides Project B entries from a principal scoped only to Project A', async () => {
    const projectBEntry = createEntry({ projectId: 'project-b' })
    let mutationCount = 0
    const triage = {
      ...createTriageClient(projectBEntry),
      applyAction: async () => {
        mutationCount += 1
        return { entry: projectBEntry, replayed: false }
      },
    } satisfies TriageCompositionClient
    configureFakeProjectClients(true, {
      workspaceRole: 'member',
      projectAccesses: [{ projectId: 'project-a', role: 'member' }],
      teamProjects: [
        { id: 'project-a', name: 'Project A', tone: 'blue' },
        { id: 'project-b', name: 'Project B', tone: 'purple' },
      ],
    })
    setTestAppDependencies({ triage })

    const list = await app.request('/api/teams/core-team/triage-entries', {
      headers: createHeaders(),
    })
    const detail = await app.request(
      '/api/teams/core-team/triage-entries/triage-api-1',
      { headers: createHeaders() },
    )
    const action = await app.request(
      '/api/teams/core-team/triage-entries/triage-api-1/actions',
      {
        method: 'POST',
        headers: createHeaders('project-scope-decline'),
        body: JSON.stringify({
          action: 'decline',
          expectedRevision: 1,
          reason: 'Out of scope.',
        }),
      },
    )

    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({
      allowedBulkActions: ['assign', 'decline', 'snooze'],
      entries: [],
    })
    expect(detail.status).toBe(404)
    expect(await detail.json()).toEqual({
      code: 'TriageEntryNotFound',
      message: 'Triage entry not found.',
    })
    expect(action.status).toBe(404)
    expect(await action.json()).toEqual({
      code: 'TriageEntryNotFound',
      message: 'Triage entry not found.',
    })
    expect(mutationCount).toBe(0)
  })

  test('accept-create commits one source-linked Work Item and replays after response loss', async () => {
    const pendingEntry = createEntry()
    let acceptedEntry: TriageEntry | undefined
    let createdWorkItem: TeamIssueResponseItem | undefined
    let createCount = 0
    const triage = {
      ...createTriageClient(pendingEntry),
      getEntryForMutation: async () => pendingEntry,
      getActionReceipt: async () => acceptedEntry
        ? { entry: acceptedEntry, replayed: true }
        : undefined,
      listWorkItemSources: async () => ({ entries: acceptedEntry ? [acceptedEntry] : [] }),
    } satisfies TriageCompositionClient

    configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
    setTestAppDependencies({
      triage,
      teamIssues: createTeamIssuesFake({
        async getTeamIssueDetail() {
          if (!createdWorkItem) {
            throw new Error('The source trace was read before Work Item creation.')
          }
          return { issue: createdWorkItem, comments: [], activity: [] }
        },
        async createTeamIssue(
          _workspaceId,
          teamId,
          input,
          _actorUserId,
          _auditContext,
          _requestConversion,
          triageAcceptance,
        ) {
          expect(triageAcceptance?.entryId).toBe(pendingEntry.id)
          expect(triageAcceptance?.transactItems.length).toBeGreaterThanOrEqual(3)
          if (typeof input.idempotentIssueId !== 'string' || !triageAcceptance) {
            throw new Error('Triage acceptance did not supply a deterministic Work Item write.')
          }
          createCount += 1
          createdWorkItem = createAcceptedWorkItem(
            input.idempotentIssueId,
            triageAcceptance.entryId,
          )
          const permission = pendingEntry.permission
          acceptedEntry = {
            ...pendingEntry,
            state: 'accepted',
            canonicalWorkItem: {
              teamId,
              workItemId: input.idempotentIssueId,
              projectId: 'refero',
            },
            capabilities: createTriageCapabilities({ state: 'accepted', permission }),
            revision: 2,
            updatedAt: triageAcceptance.occurredAt,
          }
          return { issue: createdWorkItem }
        },
      }),
    })

    const path = '/api/teams/core-team/triage-entries/triage-api-1/actions'
    const request = {
      method: 'POST',
      headers: createHeaders('accept-create-response-loss'),
      body: JSON.stringify({
        action: 'accept',
        mode: 'create',
        expectedRevision: 1,
        projectId: 'refero',
      }),
    }
    const first = await app.request(path, request)
    const firstBody: unknown = await first.json()
    expect({ body: firstBody, status: first.status }).toMatchObject({ status: 200 })
    expect(firstBody).toMatchObject({
      replayed: false,
      entry: {
        id: 'triage-api-1',
        state: 'accepted',
        canonicalWorkItem: {
          teamId: 'core-team',
          projectId: 'refero',
        },
      },
    })

    const retry = await app.request(path, request)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({
      replayed: true,
      entry: { id: 'triage-api-1', state: 'accepted' },
    })
    expect(createCount).toBe(1)
    expect(createdWorkItem?.id).toMatch(/^triage-[a-f0-9]{48}$/u)
    expect(createdWorkItem?.sourceTriageEntryId).toBe('triage-api-1')

    const sourceTrace = await app.request(
      `/api/teams/core-team/work-items/${createdWorkItem?.id ?? 'missing'}/triage-sources`,
      { headers: createHeaders() },
    )
    const sourceTraceBody: unknown = await sourceTrace.json()
    expect({
      body: sourceTraceBody,
      createdWorkItemId: createdWorkItem?.id,
      status: sourceTrace.status,
    }).toMatchObject({ status: 200 })
    expect(sourceTraceBody).toMatchObject({
      entries: [{
        id: 'triage-api-1',
        canonicalWorkItem: { workItemId: createdWorkItem?.id },
      }],
    })
  })

  test('accept-create preserves every Work Item field mapped by its Form submission', async () => {
    const submission = createMappedFormSubmission()
    const pendingEntry = createEntry({
      id: 'triage-form-mapped-1',
      source: {
        kind: 'form',
        sourceId: submission.id,
        formId: submission.formId,
        submissionId: submission.id,
      },
      sourcePreview: {
        title: 'Fallback title that must not win',
        body: 'Fallback description that must not win.',
        attachmentCount: 0,
        commentCount: 0,
        watcherCount: 0,
        sanitized: true,
        truncated: false,
      },
    })
    let createdInput: CreateTeamIssueRequestBody | undefined
    configureFakeProjectClients(true, {
      role: 'member',
      workspaceRole: 'member',
      projectAccesses: [{ projectId: 'refero', role: 'member' }],
    })
    const teamConfiguration = {
      ...createTestWorkItemConfiguration('team', 'core-team'),
      customFields: [
        {
          id: 'request-channel',
          name: 'Request channel',
          type: 'text' as const,
          sortOrder: 10,
          required: false,
        },
        {
          id: 'estimate',
          name: 'Estimate',
          type: 'number' as const,
          sortOrder: 20,
          required: false,
        },
      ],
    }
    setTestAppDependencies({
      requestIntake: createRequestIntakeClient({
        getSubmission: async () => submission,
      }),
      triage: createTriageClient(pendingEntry),
      workItemConfigurations: createFakeWorkItemConfigurationClient({
        getTeamConfiguration: async () => ({ configuration: teamConfiguration }),
      }),
      teamIssues: createTeamIssuesFake({
        async createTeamIssue(
          _workspaceId,
          _teamId,
          input,
          _actorUserId,
          _auditContext,
          _requestConversion,
          triageAcceptance,
        ) {
          createdInput = input
          if (!triageAcceptance || typeof input.idempotentIssueId !== 'string') {
            throw new Error('Form acceptance omitted its atomic Triage contribution.')
          }
          return {
            issue: createAcceptedWorkItem(
              input.idempotentIssueId,
              triageAcceptance.entryId,
            ),
          }
        },
      }),
    })

    const response = await app.request(
      '/api/teams/core-team/triage-entries/triage-form-mapped-1/actions',
      {
        method: 'POST',
        headers: createHeaders('accept-mapped-form'),
        body: JSON.stringify({
          action: 'accept',
          mode: 'create',
          expectedRevision: 1,
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(createdInput).toMatchObject({
      title: 'Mapped outage title',
      description: 'Mapped outage description',
      assignedProjectId: 'refero',
      workflowStatusId: 'todo',
      statusCategory: 'unstarted',
      customFieldValues: {
        'request-channel': 'customer-success',
        estimate: 8,
      },
      schedule: { mode: 'due-date', dueDate: '2026-08-12' },
      priority: 'high',
    })
  })

  test.each([
    {
      name: 'link',
      action: {
        action: 'accept',
        mode: 'link',
        expectedRevision: 1,
        workItemId: 'private-work-item',
      },
    },
    {
      name: 'duplicate',
      action: {
        action: 'duplicate',
        expectedRevision: 1,
        canonicalWorkItemId: 'private-work-item',
      },
    },
  ])('enforces the live Work Item Project permission for $name', async ({ action }) => {
    const entry = createEntry()
    let triageMutationCount = 0
    const triage = {
      ...createTriageClient(entry),
      applyAction: async () => {
        triageMutationCount += 1
        return { entry, replayed: false }
      },
    } satisfies TriageCompositionClient
    const calls = configureFakeProjectClients(true, {
      workspaceRole: 'member',
      projectAccesses: [{ projectId: 'refero', role: 'member' }],
      teamProjects: [
        { id: 'refero', name: 'Refero', tone: 'blue' },
        { id: 'private-project', name: 'Private', tone: 'purple' },
      ],
      detailAssignedProjectId: 'private-project',
    })
    setTestAppDependencies({ triage })

    const response = await app.request(
      '/api/teams/core-team/triage-entries/triage-api-1/actions',
      {
        method: 'POST',
        headers: createHeaders(`private-${action.action}`),
        body: JSON.stringify(action),
      },
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ message: 'Project access is denied.' })
    expect(calls.issueDetails).toEqual([
      expect.objectContaining({
        issueId: 'private-work-item',
        readOptions: expect.objectContaining({ consistentIssueRead: true }),
      }),
    ])
    expect(triageMutationCount).toBe(0)
  })

  test('returns stable conflict and invalid-input envelopes from mounted action routes', async () => {
    const entry = createEntry()
    const triage = {
      ...createTriageClient(entry),
      applyAction: async () => {
        throw new TriageError(
          409,
          'TriageRevisionConflict',
          'The triage entry changed.',
        )
      },
    } satisfies TriageCompositionClient
    configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
    setTestAppDependencies({ triage })

    const conflict = await app.request(
      '/api/teams/core-team/triage-entries/triage-api-1/actions',
      {
        method: 'POST',
        headers: createHeaders('stale-revision'),
        body: JSON.stringify({
          action: 'decline',
          expectedRevision: 1,
          reason: 'No longer relevant.',
        }),
      },
    )
    const invalid = await app.request(
      '/api/teams/core-team/triage-entries/triage-api-1/actions',
      {
        method: 'POST',
        headers: createHeaders(),
        body: JSON.stringify({
          action: 'decline',
          expectedRevision: 1,
          reason: 'No longer relevant.',
        }),
      },
    )

    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({
      code: 'TriageRevisionConflict',
      message: 'The triage entry changed.',
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({
      code: 'InvalidTriageInput',
      message: 'Idempotency-Key is required.',
    })
  })

  test.each([
    {
      name: 'not found',
      error: new RequestIntakeError(
        404,
        'RequestSubmissionNotFound',
        'Request submission not found.',
      ),
    },
    {
      name: 'revision conflict',
      error: new RequestIntakeError(
        409,
        'RequestRevisionConflict',
        'Request resource revision changed.',
      ),
    },
  ])('returns the stable Request $name envelope for Form information requests', async ({
    error,
  }) => {
    const submission = createMappedFormSubmission()
    const entry = createEntry({
      id: 'triage-form-information-1',
      source: {
        kind: 'form',
        sourceId: submission.id,
        formId: submission.formId,
        submissionId: submission.id,
      },
    })
    configureFakeProjectClients(true, {
      role: 'member',
      workspaceRole: 'member',
      projectAccesses: [{ projectId: 'refero', role: 'member' }],
    })
    setTestAppDependencies({
      triage: createTriageClient(entry),
      requestIntake: createRequestIntakeClient({
        getSubmission: async () => {
          if (error.status === 404) throw error
          return submission
        },
        applyAction: async () => {
          throw error
        },
      }),
    })

    const response = await app.request(
      '/api/teams/core-team/triage-entries/triage-form-information-1/actions',
      {
        method: 'POST',
        headers: createHeaders(`request-information-${error.status}`),
        body: JSON.stringify({
          action: 'request-information',
          expectedRevision: 1,
          message: 'Please provide the affected account ID.',
        }),
      },
    )

    expect(response.status).toBe(error.status)
    expect(await response.json()).toEqual({
      code: error.code,
      message: error.message,
    })
  })
})
