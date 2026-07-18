import { describe, expect, test } from 'bun:test'
import type { ExternalWorkItemLink } from '@mukuroji/contracts'
import {
  InMemoryDeveloperPlatformClient,
  LocalAesGcmSecretProtector,
} from './developer-platform'
import {
  BUILT_IN_CONNECTOR_CATALOG,
  ConnectorRegistry,
  createConnectorOriginMarker,
  type ConnectorAdapter,
  type ConnectorOutboundMutation,
} from './connectors'
import {
  ConnectorRuntimeError,
  deserializeConnectorCredential,
  serializeConnectorCredential,
} from './connector-oauth'
import {
  ConnectorSyncEngine,
  InMemoryConnectorSyncPersistence,
  type ConnectorSyncHealthReporter,
  type ConnectorSyncPersistence,
  type ConnectorWorkItemGateway,
  type ConnectorWorkItemSnapshot,
} from './connector-sync-runtime'

const NOW = new Date('2026-07-18T00:00:00.000Z')
const ORIGIN_SIGNING_SECRET = 'connector-origin-signing-secret-at-least-thirty-two-bytes'
const PREVIOUS_ORIGIN_SIGNING_SECRET =
  'previous-connector-origin-signing-secret-at-least-thirty-two-bytes'

function createAdapter(
  overrides: Partial<ConnectorAdapter> = {},
): ConnectorAdapter {
  return {
    definition: BUILT_IN_CONNECTOR_CATALOG[0]!,
    async connect() {
      return {
        accessToken: 'access-token',
        externalAccountId: 'account-1',
        scopes: ['repo'],
      }
    },
    async refresh(credential) {
      return credential
    },
    async disconnect() {},
    async pull() {
      return { items: [] }
    },
    async push(_credential, mutation) {
      return {
        externalId: mutation.externalId,
        resourceType: mutation.resourceType,
        externalUrl: `https://provider.test/issues/${mutation.externalId}`,
        externalVersion: '11',
        title: mutation.title,
        description: mutation.description,
        status: mutation.status,
        metadata: {},
        originMarker: mutation.originMarker,
      }
    },
    ...overrides,
  }
}

async function createRuntimeFixture(
  adapter = createAdapter(),
  previousOriginSigningSecrets: readonly string[] = [],
) {
  let currentTime = NOW
  const platform = new InMemoryDeveloperPlatformClient(
    new LocalAesGcmSecretProtector(new Uint8Array(32).fill(9)),
    () => currentTime,
  )
  const installation = await platform.installConnector({
    workspaceId: 'workspace-1',
    installedByUserId: 'installer-1',
    input: {
      category: adapter.definition.category,
      provider: adapter.definition.id,
      name: `Engineering ${adapter.definition.name}`,
      scopes: ['repo'],
      externalAccountId: 'account-1',
      credential: serializeConnectorCredential({
        accessToken: 'access-token',
        externalAccountId: 'account-1',
        scopes: ['repo'],
      }),
    },
  })
  const link = await platform.createExternalWorkItemLink({
    workspaceId: 'workspace-1',
    input: {
      teamId: 'team-1',
      workItemId: 'work-item-1',
      installationId: installation.id,
      resourceType: 'issue',
      externalId: '29',
      externalUrl: 'https://provider.test/issues/29',
      displayKey: '#29',
      syncDirection: 'bidirectional',
    },
  })
  let workItem: ConnectorWorkItemSnapshot = {
    id: 'work-item-1',
    teamId: 'team-1',
    revision: 4,
    title: 'Local title',
    description: 'Local description',
    status: 'open',
  }
  const authorizations: Array<{
    workspaceId: string
    actorUserId: string
    teamId: string
    workItemId: string
    write: boolean
  }> = []
  const appliedOperations = new Map<string, ConnectorWorkItemSnapshot>()
  const workItems: ConnectorWorkItemGateway = {
    async authorize(workspaceId, actorUserId, teamId, workItemId, write) {
      authorizations.push({
        workspaceId,
        actorUserId,
        teamId,
        workItemId,
        write,
      })
    },
    async get() {
      return structuredClone(workItem)
    },
    async applyExternal(input) {
      const replay = appliedOperations.get(input.operationId)
      if (replay) {
        return { kind: 'applied', workItem: structuredClone(replay) }
      }
      if (workItem.revision !== input.expectedRevision) {
        return { kind: 'conflict', workItem: structuredClone(workItem) }
      }
      workItem = {
        ...workItem,
        ...input.patch,
        revision: workItem.revision + 1,
      }
      appliedOperations.set(input.operationId, structuredClone(workItem))
      return { kind: 'applied', workItem: structuredClone(workItem) }
    },
  }
  const healthEvents: string[] = []
  const health: ConnectorSyncHealthReporter = {
    async authorizationRequired(_workspaceId, target) {
      healthEvents.push(`authorization:${target.id}`)
    },
    async degraded(_workspaceId, target) {
      healthEvents.push(`degraded:${target.id}`)
    },
  }
  const persistence = new InMemoryConnectorSyncPersistence()
  const registry = new ConnectorRegistry([adapter])
  const engine = new ConnectorSyncEngine({
    platform,
    registry,
    workItems,
    persistence,
    health,
    originSigningSecret: ORIGIN_SIGNING_SECRET,
    previousOriginSigningSecrets,
    clock: () => currentTime,
  })
  return {
    platform,
    installation,
    link,
    engine,
    persistence,
    registry,
    workItems,
    health,
    authorizations,
    healthEvents,
    setCurrentTime: (value: Date) => {
      currentTime = value
    },
    getWorkItem: () => structuredClone(workItem),
    setWorkItem: (next: ConnectorWorkItemSnapshot) => {
      workItem = structuredClone(next)
    },
  }
}

function externalRecord(version = '10') {
  return {
    externalId: '29',
    resourceType: 'issue' as const,
    externalUrl: 'https://provider.test/issues/29',
    externalVersion: version,
    title: 'External title',
    description: 'External description',
    status: 'closed',
    metadata: {},
  }
}

describe('ConnectorSyncEngine', () => {
  test('applies inbound events with installer RBAC and skips an exact replay', async () => {
    const fixture = await createRuntimeFixture()
    const input = {
      workspaceId: 'workspace-1',
      link: fixture.link,
      eventId: 'event-10',
      record: externalRecord(),
    }
    const result = await fixture.engine.processInbound(input)
    expect(result).toEqual({
      kind: 'synced',
      linkId: fixture.link.id,
      workItemRevision: 5,
      externalVersion: '10',
    })
    expect(fixture.getWorkItem()).toMatchObject({
      revision: 5,
      title: 'External title',
      description: 'External description',
      status: 'closed',
    })
    expect(fixture.authorizations).toEqual([{
      workspaceId: 'workspace-1',
      actorUserId: 'installer-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      write: true,
    }])
    expect(await fixture.persistence.getLinkState(
      'workspace-1',
      fixture.link.id,
    )).toMatchObject({
      workItemRevision: 5,
      lastExternalVersion: '10',
      lastExternalEventId: 'event-10',
      storageRevision: 1,
    })
    expect(await fixture.engine.processInbound(input)).toEqual({
      kind: 'skipped',
      linkId: fixture.link.id,
      reason: 'duplicate',
    })
  })

  test('suppresses echo events signed with a previous origin key during rotation', async () => {
    const fixture = await createRuntimeFixture(
      createAdapter(),
      [PREVIOUS_ORIGIN_SIGNING_SECRET],
    )
    const record = {
      ...externalRecord(),
      originMarker: createConnectorOriginMarker(
        fixture.installation.id,
        fixture.link.id,
        4,
        'operation-before-key-rotation',
        PREVIOUS_ORIGIN_SIGNING_SECRET,
      ),
    }
    await expect(fixture.engine.processInbound({
      workspaceId: 'workspace-1',
      link: fixture.link,
      eventId: 'event-before-key-rotation',
      record,
    })).resolves.toEqual({
      kind: 'skipped',
      linkId: fixture.link.id,
      reason: 'self-origin',
    })
    expect(fixture.getWorkItem().revision).toBe(4)
  })

  test('does not heal a user-requested pending resync from an old duplicate event', async () => {
    const fixture = await createRuntimeFixture()
    const input = {
      workspaceId: 'workspace-1',
      link: fixture.link,
      eventId: 'event-before-user-update',
      record: externalRecord(),
    }
    await fixture.engine.processInbound(input)
    fixture.setCurrentTime(new Date('2026-07-18T00:01:00.000Z'))
    const pending = await fixture.platform.updateExternalWorkItemLink({
      workspaceId: 'workspace-1',
      teamId: fixture.link.teamId,
      workItemId: fixture.link.workItemId,
      linkId: fixture.link.id,
      updatedByUserId: 'user-1',
      input: { syncDirection: 'inbound' },
    })
    expect(pending).toMatchObject({
      syncDirection: 'inbound',
      syncStatus: 'pending',
      updatedAt: '2026-07-18T00:01:00.000Z',
    })
    const restoredStatuses: Array<ExternalWorkItemLink['syncStatus']> = []
    const setLinkStatus = fixture.persistence.setLinkStatus.bind(fixture.persistence)
    fixture.persistence.setLinkStatus = async (
      workspaceId: string,
      linkId: string,
      status: ExternalWorkItemLink['syncStatus'],
    ) => {
      restoredStatuses.push(status)
      return setLinkStatus(workspaceId, linkId, status)
    }

    await expect(fixture.engine.processInbound(input)).resolves.toEqual({
      kind: 'skipped',
      linkId: fixture.link.id,
      reason: 'duplicate',
    })
    expect(restoredStatuses).toEqual([])
    await expect(fixture.platform.listExternalWorkItemLinks({
      workspaceId: 'workspace-1',
    })).resolves.toEqual([
      expect.objectContaining({ syncStatus: 'pending' }),
    ])
  })

  test('acknowledges a pending direction generation from a current provider poll', async () => {
    const fixture = await createRuntimeFixture(createAdapter({
      async pull() {
        return { items: [externalRecord()] }
      },
    }))
    await fixture.engine.processInbound({
      workspaceId: 'workspace-1',
      link: fixture.link,
      eventId: 'event-before-direction-change',
      record: externalRecord(),
    })
    fixture.setCurrentTime(new Date('2026-07-18T00:01:00.000Z'))
    const pending = await fixture.platform.updateExternalWorkItemLink({
      workspaceId: 'workspace-1',
      teamId: fixture.link.teamId,
      workItemId: fixture.link.workItemId,
      linkId: fixture.link.id,
      updatedByUserId: 'user-1',
      input: { syncDirection: 'inbound' },
    })
    const acknowledgements: string[] = []
    const acknowledge = fixture.persistence.acknowledgePendingLink.bind(
      fixture.persistence,
    )
    fixture.persistence.acknowledgePendingLink = async (
      workspaceId,
      linkId,
      expectedUpdatedAt,
      syncedAt,
    ) => {
      acknowledgements.push(expectedUpdatedAt)
      return acknowledge(workspaceId, linkId, expectedUpdatedAt, syncedAt)
    }

    const result = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'issue',
    })
    expect(result.results).toEqual([{
      kind: 'skipped',
      linkId: fixture.link.id,
      reason: 'stale',
    }])
    expect(acknowledgements).toEqual([pending.updatedAt])
    expect(fixture.persistence.getLinkStatus(
      'workspace-1',
      fixture.link.id,
    )).toBe('synced')
  })

  test('does not acknowledge a pending link after its poll generation changes', async () => {
    const fixture = await createRuntimeFixture()
    await fixture.engine.processInbound({
      workspaceId: 'workspace-1',
      link: fixture.link,
      eventId: 'event-before-generation-change',
      record: externalRecord(),
    })
    fixture.setCurrentTime(new Date('2026-07-18T00:01:00.000Z'))
    const staleGeneration = await fixture.platform.updateExternalWorkItemLink({
      workspaceId: 'workspace-1',
      teamId: fixture.link.teamId,
      workItemId: fixture.link.workItemId,
      linkId: fixture.link.id,
      updatedByUserId: 'user-1',
      input: { syncDirection: 'inbound' },
    })
    fixture.setCurrentTime(new Date('2026-07-18T00:02:00.000Z'))
    await fixture.platform.updateExternalWorkItemLink({
      workspaceId: 'workspace-1',
      teamId: fixture.link.teamId,
      workItemId: fixture.link.workItemId,
      linkId: fixture.link.id,
      updatedByUserId: 'user-1',
      input: { syncDirection: 'bidirectional' },
    })
    let acknowledgementCalls = 0
    fixture.persistence.acknowledgePendingLink = async () => {
      acknowledgementCalls += 1
      return true
    }

    await fixture.engine.processInbound({
      workspaceId: 'workspace-1',
      link: staleGeneration,
      eventId: 'event-before-generation-change',
      record: externalRecord(),
      pollGeneration: staleGeneration.updatedAt,
    })
    expect(acknowledgementCalls).toBe(0)
  })

  test('resolves GitLab sync adapters from the built-in connector catalog', async () => {
    const gitLab = BUILT_IN_CONNECTOR_CATALOG.find(
      (definition) => definition.id === 'gitlab',
    )
    if (!gitLab) throw new Error('GitLab connector definition is required.')
    const fixture = await createRuntimeFixture(createAdapter({
      definition: gitLab,
    }))

    await expect(fixture.engine.processOutbound({
      workspaceId: 'workspace-1',
      link: fixture.link,
      operationId: 'gitlab-outbound',
    })).resolves.toMatchObject({
      kind: 'synced',
      linkId: fixture.link.id,
    })
    expect(fixture.installation.provider).toBe('gitlab')
  })

  test('pushes outbound changes with a stable loop guard and commits sync state', async () => {
    let mutation: ConnectorOutboundMutation | undefined
    const fixture = await createRuntimeFixture(createAdapter({
      async push(_credential, input) {
        mutation = input
        return {
          ...externalRecord('11'),
          title: input.title,
          description: input.description,
          status: input.status,
          originMarker: input.originMarker,
        }
      },
    }))
    const result = await fixture.engine.processOutbound({
      workspaceId: 'workspace-1',
      link: fixture.link,
      operationId: 'work-item-update-4',
    })
    expect(result).toEqual({
      kind: 'synced',
      linkId: fixture.link.id,
      workItemRevision: 4,
      externalVersion: '11',
    })
    expect(mutation).toMatchObject({
      externalId: '29',
      resourceType: 'issue',
      workItemRevision: 4,
      title: 'Local title',
    })
    expect(mutation!.originMarker).toBe(
      createConnectorOriginMarker(
        fixture.installation.id,
        fixture.link.id,
        4,
        'work-item-update-4',
        ORIGIN_SIGNING_SECRET,
      ),
    )
    expect(await fixture.persistence.getLinkState(
      'workspace-1',
      fixture.link.id,
    )).toMatchObject({
      workItemRevision: 4,
      lastExternalVersion: '11',
    })
  })

  test('uses the winning credential when another worker owns the refresh claim', async () => {
    let pushedAccessToken: string | undefined
    let refreshCalls = 0
    const fixture = await createRuntimeFixture(createAdapter({
      async refresh(credential) {
        refreshCalls += 1
        return {
          ...credential,
          accessToken: 'access-refresh-loser',
          refreshToken: 'refresh-loser',
          expiresAt: '2026-07-18T01:00:00.000Z',
        }
      },
      async push(credential, input) {
        pushedAccessToken = credential.accessToken
        return {
          ...externalRecord('12'),
          title: input.title,
          description: input.description,
          status: input.status,
          originMarker: input.originMarker,
        }
      },
    }))
    await fixture.platform.recoverConnector({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      credential: serializeConnectorCredential({
        accessToken: 'access-expiring',
        refreshToken: 'refresh-before-race',
        externalAccountId: 'account-1',
        scopes: ['repo'],
        expiresAt: '2026-07-18T00:01:00.000Z',
      }),
    })
    const claim = fixture.platform.claimConnectorCredentialRefresh.bind(
      fixture.platform,
    )
    const recover = fixture.platform.recoverConnector.bind(fixture.platform)
    let concurrentWrites = 0
    fixture.platform.claimConnectorCredentialRefresh = async (request) => {
      if (concurrentWrites === 0) {
        concurrentWrites += 1
        const winnerClaimId = 'inline-refresh-winning-claim'
        await claim({ ...request, claimId: winnerClaimId })
        const previous = deserializeConnectorCredential(request.expectedCredential)
        await recover({
          workspaceId: request.workspaceId,
          installationId: request.installationId,
          credential: serializeConnectorCredential({
            ...previous,
            accessToken: 'access-refresh-winner',
            refreshToken: 'refresh-winner',
            expiresAt: '2026-07-18T01:00:00.000Z',
          }),
          expectedCredential: request.expectedCredential,
          refreshClaimId: winnerClaimId,
          reason: 'refresh',
        })
        return 'credential-changed'
      }
      return claim(request)
    }

    await expect(fixture.engine.processOutbound({
      workspaceId: 'workspace-1',
      link: fixture.link,
      operationId: 'refresh-race-outbound',
    })).resolves.toMatchObject({ kind: 'synced' })
    expect(concurrentWrites).toBe(1)
    expect(refreshCalls).toBe(0)
    expect(pushedAccessToken).toBe('access-refresh-winner')
    expect(deserializeConnectorCredential(
      await fixture.platform.readConnectorCredential({
        workspaceId: 'workspace-1',
        installationId: fixture.installation.id,
      }),
    )).toMatchObject({
      accessToken: 'access-refresh-winner',
      refreshToken: 'refresh-winner',
    })
  })

  test('skips open-conflict links for inbound, outbound, and polling work', async () => {
    let pulls = 0
    let pushes = 0
    const fixture = await createRuntimeFixture(createAdapter({
      async pull() {
        pulls += 1
        return { items: [externalRecord()] }
      },
      async push(_credential, mutation) {
        pushes += 1
        return {
          ...externalRecord(),
          title: mutation.title,
          originMarker: mutation.originMarker,
        }
      },
    }))
    const listLinks =
      fixture.platform.listExternalWorkItemLinks.bind(fixture.platform)
    fixture.platform.listExternalWorkItemLinks = async (request) =>
      (await listLinks(request)).map((link) => (
        link.id === fixture.link.id
          ? { ...link, syncStatus: 'conflict' as const }
          : link
      ))

    await expect(fixture.engine.processInbound({
      workspaceId: 'workspace-1',
      link: fixture.link,
      eventId: 'event-open-conflict',
      record: externalRecord(),
    })).resolves.toEqual({
      kind: 'skipped',
      linkId: fixture.link.id,
      reason: 'conflict',
    })
    await expect(fixture.engine.processOutbound({
      workspaceId: 'workspace-1',
      link: fixture.link,
      operationId: 'outbound-open-conflict',
    })).resolves.toEqual({
      kind: 'skipped',
      linkId: fixture.link.id,
      reason: 'conflict',
    })
    await expect(fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'issue',
    })).resolves.toEqual({ results: [] })
    expect(pulls).toBe(0)
    expect(pushes).toBe(0)
    expect(fixture.authorizations).toHaveLength(0)
    expect(fixture.getWorkItem()).toMatchObject({
      revision: 4,
      title: 'Local title',
    })
  })

  test('turns local revision drift into a deterministic user-visible conflict', async () => {
    const fixture = await createRuntimeFixture()
    await fixture.engine.processOutbound({
      workspaceId: 'workspace-1',
      link: fixture.link,
      operationId: 'seed-state',
    })
    fixture.setWorkItem({
      ...fixture.getWorkItem(),
      revision: 5,
      title: 'Locally changed',
    })

    const result = await fixture.engine.processInbound({
      workspaceId: 'workspace-1',
      link: fixture.link,
      eventId: 'event-12',
      record: externalRecord('12'),
    })
    expect(result.kind).toBe('conflict')
    if (result.kind !== 'conflict') throw new Error('Expected conflict')
    expect(result.conflict).toMatchObject({
      externalLinkId: fixture.link.id,
      workItemId: 'work-item-1',
      localRevision: 5,
      externalRevision: '12',
      status: 'open',
      fields: expect.arrayContaining([
        {
          field: 'title',
          localValue: 'Locally changed',
          externalValue: 'External title',
        },
      ]),
    })
    expect(result.conflict.id).toStartWith('sync-conflict-')
    expect(fixture.persistence.getLinkStatus(
      'workspace-1',
      fixture.link.id,
    )).toBe('conflict')

    const replay = await fixture.engine.processInbound({
      workspaceId: 'workspace-1',
      link: fixture.link,
      eventId: 'event-12',
      record: externalRecord('12'),
    })
    expect(replay).toEqual(result)
    expect((await fixture.engine.listConflicts('workspace-1', {
      status: 'open',
      limit: 10,
    })).items).toHaveLength(1)
  })

  test('recovers a Work Item commit followed by a sync-state commit crash', async () => {
    const fixture = await createRuntimeFixture()
    let failFirstCommit = true
    const persistence: ConnectorSyncPersistence = {
      getLinkState: (workspaceId, linkId) =>
        fixture.persistence.getLinkState(workspaceId, linkId),
      async commitLinkState(input) {
        if (failFirstCommit) {
          failFirstCommit = false
          return false
        }
        return fixture.persistence.commitLinkState(input)
      },
      setLinkStatus: (workspaceId, linkId, status) =>
        fixture.persistence.setLinkStatus(workspaceId, linkId, status),
      acknowledgePendingLink: (
        workspaceId,
        linkId,
        expectedUpdatedAt,
        syncedAt,
      ) => fixture.persistence.acknowledgePendingLink(
        workspaceId,
        linkId,
        expectedUpdatedAt,
        syncedAt,
      ),
      createConflict: (record) => fixture.persistence.createConflict(record),
      listConflicts: (workspaceId, input) =>
        fixture.persistence.listConflicts(workspaceId, input),
      getConflict: (workspaceId, conflictId) =>
        fixture.persistence.getConflict(workspaceId, conflictId),
      claimConflictResolution: (workspaceId, conflictId, input) =>
        fixture.persistence.claimConflictResolution(workspaceId, conflictId, input),
      releaseConflictResolution: (workspaceId, conflictId, operationId) =>
        fixture.persistence.releaseConflictResolution(
          workspaceId,
          conflictId,
          operationId,
        ),
      completeConflict: (workspaceId, conflictId, input) =>
        fixture.persistence.completeConflict(workspaceId, conflictId, input),
    }
    const engine = new ConnectorSyncEngine({
      platform: fixture.platform,
      registry: fixture.registry,
      workItems: fixture.workItems,
      persistence,
      health: fixture.health,
      originSigningSecret: ORIGIN_SIGNING_SECRET,
      clock: () => NOW,
    })
    const input = {
      workspaceId: 'workspace-1',
      link: fixture.link,
      eventId: 'event-crash-recovery',
      record: externalRecord('10'),
    }
    await expect(engine.processInbound(input)).rejects.toMatchObject({
      code: 'ConnectorSyncStateConflict',
      retryable: true,
    })
    expect(fixture.getWorkItem().revision).toBe(5)

    expect(await engine.processInbound(input)).toEqual({
      kind: 'synced',
      linkId: fixture.link.id,
      workItemRevision: 5,
      externalVersion: '10',
    })
    expect(fixture.getWorkItem().revision).toBe(5)
    expect(await fixture.persistence.getLinkState(
      'workspace-1',
      fixture.link.id,
    )).toMatchObject({
      workItemRevision: 5,
      lastExternalEventId: 'event-crash-recovery',
    })
  })

  test('reports authorization and transient provider failures without leaking credentials', async () => {
    const authorizationFailure = await createRuntimeFixture(createAdapter({
      async push() {
        throw new ConnectorRuntimeError(
          'ConnectorAuthorizationRequired',
          'Authorization required.',
          { authorizationRequired: true, providerStatus: 401 },
        )
      },
    }))
    await expect(authorizationFailure.engine.processOutbound({
      workspaceId: 'workspace-1',
      link: authorizationFailure.link,
      operationId: 'auth-failure',
    })).rejects.toMatchObject({ code: 'ConnectorAuthorizationRequired' })
    expect(authorizationFailure.healthEvents).toEqual([
      `authorization:${authorizationFailure.installation.id}`,
    ])

    const transientFailure = await createRuntimeFixture(createAdapter({
      async push() {
        throw new ConnectorRuntimeError(
          'ConnectorProviderUnavailable',
          'Provider unavailable.',
          { retryable: true, providerStatus: 503 },
        )
      },
    }))
    await expect(transientFailure.engine.processOutbound({
      workspaceId: 'workspace-1',
      link: transientFailure.link,
      operationId: 'transient-failure',
    })).rejects.toMatchObject({ retryable: true })
    expect(transientFailure.healthEvents).toEqual([
      `degraded:${transientFailure.installation.id}`,
    ])
  })

  test('polls bounded provider pages and syncs only already-linked resources', async () => {
    let pulls = 0
    const fixture = await createRuntimeFixture(createAdapter({
      async pull(_credential, _resourceType, cursor) {
        pulls += 1
        if (!cursor) {
          return {
            items: [
              externalRecord('10'),
              {
                ...externalRecord('10'),
                externalId: 'unlinked',
              },
            ],
            nextCursor: 'page-2',
          }
        }
        return {
          items: [{ ...externalRecord('11'), title: 'Page two title' }],
          nextCursor: 'page-3',
        }
      },
    }))
    const result = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'issue',
      maximumPages: 1,
    })
    expect(pulls).toBe(1)
    expect(result.results).toHaveLength(1)
    expect(result.nextCursor).toBe('page-2')
  })

  test('resolves use-external with CAS and marks the conflict resolved', async () => {
    const fixture = await createRuntimeFixture()
    const conflict = await createConflictFixture(fixture)
    const resolved = await fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'resolver-1' },
      conflict.id,
      { resolution: 'use-external' },
    )
    expect(resolved).toMatchObject({
      id: conflict.id,
      status: 'resolved',
      resolvedByUserId: 'resolver-1',
      resolvedAt: NOW.toISOString(),
    })
    expect(fixture.getWorkItem()).toMatchObject({
      revision: 6,
      title: 'External title',
      status: 'closed',
    })
    expect(fixture.authorizations.at(-1)).toMatchObject({
      actorUserId: 'resolver-1',
      write: true,
    })
  })

  test('resolves use-local by pushing and merge by applying then pushing', async () => {
    const pushed: ConnectorOutboundMutation[] = []
    const fixture = await createRuntimeFixture(createAdapter({
      async push(_credential, mutation) {
        pushed.push(structuredClone(mutation))
        return {
          ...externalRecord(String(10 + pushed.length)),
          title: mutation.title,
          description: mutation.description,
          status: mutation.status,
          originMarker: mutation.originMarker,
        }
      },
    }))
    const conflict = await createConflictFixture(fixture)
    const resolved = await fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'resolver-1' },
      conflict.id,
      { resolution: 'use-local' },
    )
    expect(resolved.status).toBe('resolved')
    expect(pushed.at(-1)).toMatchObject({
      title: 'Locally changed',
      workItemRevision: 5,
    })

    let secondPushes = 0
    const secondFixture = await createRuntimeFixture(createAdapter({
      async push(_credential, mutation) {
        secondPushes += 1
        pushed.push(structuredClone(mutation))
        return {
          ...externalRecord(String(10 + secondPushes)),
          title: mutation.title,
          description: mutation.description,
          status: mutation.status,
          originMarker: mutation.originMarker,
        }
      },
    }))
    const secondConflict = await createConflictFixture(secondFixture)
    const merged = await secondFixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'resolver-2' },
      secondConflict.id,
      {
        resolution: 'merge',
        mergedValues: {
          title: 'Merged title',
          description: 'Merged description',
          status: 'open',
        },
      },
    )
    expect(merged.status).toBe('resolved')
    expect(secondFixture.getWorkItem()).toMatchObject({
      revision: 6,
      title: 'Merged title',
    })
    expect(pushed.at(-1)).toMatchObject({
      title: 'Merged title',
      workItemRevision: 6,
    })
  })

  test('replays an idempotent merge after local apply succeeds and provider push fails', async () => {
    let failNextPush = false
    let externalVersion = 10
    const fixture = await createRuntimeFixture(createAdapter({
      async push(_credential, mutation) {
        if (failNextPush) {
          failNextPush = false
          throw new ConnectorRuntimeError(
            'ConnectorProviderUnavailable',
            'Provider temporarily unavailable.',
            { retryable: true, providerStatus: 503 },
          )
        }
        externalVersion += 1
        return {
          ...externalRecord(String(externalVersion)),
          title: mutation.title,
          description: mutation.description,
          status: mutation.status,
          originMarker: mutation.originMarker,
        }
      },
    }))
    const conflict = await createConflictFixture(fixture)
    failNextPush = true
    const resolution = {
      resolution: 'merge' as const,
      mergedValues: {
        title: 'Crash-safe merged title',
        description: 'Merged once',
        status: 'open',
      },
    }
    await expect(fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'resolver-1' },
      conflict.id,
      resolution,
    )).rejects.toMatchObject({
      code: 'ConnectorProviderUnavailable',
      retryable: true,
    })
    expect(fixture.getWorkItem()).toMatchObject({
      revision: 6,
      title: 'Crash-safe merged title',
    })

    const resolved = await fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'resolver-1' },
      conflict.id,
      resolution,
    )
    expect(resolved.status).toBe('resolved')
    expect(fixture.getWorkItem().revision).toBe(6)
  })

  test('resolves ignore by pausing the link without provider or Work Item writes', async () => {
    let pushes = 0
    const fixture = await createRuntimeFixture(createAdapter({
      async push(_credential, mutation) {
        pushes += 1
        return {
          ...externalRecord('11'),
          title: mutation.title,
          originMarker: mutation.originMarker,
        }
      },
    }))
    const conflict = await createConflictFixture(fixture)
    const pushesBeforeResolution = pushes
    const revisionBeforeResolution = fixture.getWorkItem().revision
    const ignored = await fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'resolver-1' },
      conflict.id,
      { resolution: 'ignore' },
    )
    expect(ignored.status).toBe('ignored')
    expect(pushes).toBe(pushesBeforeResolution)
    expect(fixture.getWorkItem().revision).toBe(revisionBeforeResolution)
    expect(fixture.persistence.getLinkStatus(
      'workspace-1',
      fixture.link.id,
    )).toBe('paused')
  })

  test('releases a resolution claim when validation fails before provider writes', async () => {
    const fixture = await createRuntimeFixture()
    const conflict = await createConflictFixture(fixture)
    const conflictSnapshot = fixture.getWorkItem()
    fixture.setWorkItem({
      ...conflictSnapshot,
      revision: conflictSnapshot.revision + 1,
      title: 'Changed after conflict',
    })

    await expect(fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'resolver-1' },
      conflict.id,
      { resolution: 'use-local' },
    )).rejects.toMatchObject({ code: 'ConnectorSyncConflictChanged' })

    fixture.setWorkItem(conflictSnapshot)
    await expect(fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'resolver-2' },
      conflict.id,
      { resolution: 'use-local' },
    )).resolves.toMatchObject({
      status: 'resolved',
      resolvedByUserId: 'resolver-2',
    })
  })
})

async function createConflictFixture(
  fixture: Awaited<ReturnType<typeof createRuntimeFixture>>,
) {
  await fixture.engine.processOutbound({
    workspaceId: 'workspace-1',
    link: fixture.link,
    operationId: 'seed-state',
  })
  fixture.setWorkItem({
    ...fixture.getWorkItem(),
    revision: 5,
    title: 'Locally changed',
  })
  const result = await fixture.engine.processInbound({
    workspaceId: 'workspace-1',
    link: fixture.link,
    eventId: 'event-conflict',
    record: externalRecord('12'),
  })
  if (result.kind !== 'conflict') throw new Error('Expected conflict')
  return result.conflict
}
