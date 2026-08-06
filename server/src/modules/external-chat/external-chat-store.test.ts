import { expect, test } from 'bun:test'
import {
  EXTERNAL_CHAT_SCHEMA_VERSION,
  type ExternalChatInboundEvent,
  type ExternalChatMessageBinding,
  type ExternalChatSyncOutcome,
  type ExternalChatWorkItemLink,
} from '@mukuroji/contracts'
import {
  createExternalChatFingerprint,
  createExternalChatSourceDigest,
  InMemoryExternalChatStore,
  type CreateExternalChatLinkInput,
  type ExternalChatSourceIdentity,
} from './external-chat'

const now = '2026-08-06T04:00:00.000Z'
const later = '2026-08-06T04:01:00.000Z'
const retryAt = '2026-08-06T04:02:00.000Z'

test('link creation is tenant-scoped, source-unique, and payload-bound idempotent', async () => {
  const store = new InMemoryExternalChatStore()
  const input = createLinkInput('workspace-1', 'link-1', 'work-item-1', 'idempotency-a')
  const created = await store.createLink(input)
  expect(created.kind).toBe('created')
  if (created.kind !== 'created') throw new Error('Expected a created link.')
  expect(created.record.sourceDigest).toBe(createExternalChatSourceDigest(sourceIdentity()))

  const replayed = await store.createLink(input)
  expect(replayed.kind).toBe('replayed')

  const idempotencyConflict = await store.createLink({
    ...input,
    requestFingerprint: createExternalChatFingerprint({ changed: true }),
  })
  expect(idempotencyConflict.kind).toBe('idempotency-conflict')

  const sourceConflict = await store.createLink(
    createLinkInput('workspace-1', 'link-2', 'work-item-2', 'idempotency-b'),
  )
  expect(sourceConflict.kind).toBe('source-conflict')
  if (sourceConflict.kind !== 'source-conflict') throw new Error('Expected a source conflict.')
  expect(sourceConflict.record.link.id).toBe('link-1')

  const otherTenant = await store.createLink(
    createLinkInput('workspace-2', 'link-2', 'work-item-2', 'idempotency-b'),
  )
  expect(otherTenant.kind).toBe('created')
  expect(await store.getLink('workspace-2', 'link-1')).toBeUndefined()
})

test('a restrictive parent fence closes the source-resolution to link-commit race', async () => {
  const store = new InMemoryExternalChatStore()
  const resolvedLink = createLinkInput(
    'workspace-1',
    'link-raced',
    'work-item-raced',
    'idempotency-raced',
  )

  const fenced = await store.fenceParentLifecycle({
    workspaceId: resolvedLink.workspaceId,
    provider: resolvedLink.source.provider,
    installationId: resolvedLink.link.installationId,
    externalWorkspaceId: resolvedLink.source.externalWorkspaceId,
    conversationExternalId: resolvedLink.source.conversationExternalId,
    authorizationRevision: resolvedLink.authorizationRevision,
    restrictive: true,
    eventId: 'parent-event-after-resolution',
    operationId: 'parent-operation-after-resolution',
    occurredAt: later,
  })
  expect(fenced.kind).toBe('applied')

  const rejected = await store.createLink(resolvedLink)
  expect(rejected).toEqual({ kind: 'parent-restricted' })
  expect(await store.getLink(resolvedLink.workspaceId, resolvedLink.link.id)).toBeUndefined()

  const reauthorized = await store.createLink({
    ...resolvedLink,
    authorizationRevision: resolvedLink.authorizationRevision + 1,
  })
  expect(reauthorized.kind).toBe('created')
})

test('parent lifecycle fences replay exactly and reject stale generations', async () => {
  const store = new InMemoryExternalChatStore()
  const fence = {
    workspaceId: 'workspace-1',
    provider: 'slack',
    installationId: 'installation-1',
    externalWorkspaceId: 'external-workspace-1',
    conversationExternalId: 'conversation-1',
    authorizationRevision: 2,
    restrictive: true,
    eventId: 'parent-event-current',
    operationId: 'parent-operation-current',
    occurredAt: later,
  } satisfies Parameters<InMemoryExternalChatStore['fenceParentLifecycle']>[0]
  const applied = await store.fenceParentLifecycle(fence)
  expect(applied.kind).toBe('applied')
  if (applied.kind !== 'applied') throw new Error('Expected an applied parent lifecycle fence.')

  const replayed = await store.fenceParentLifecycle({
    workspaceId: fence.workspaceId,
    provider: fence.provider,
    installationId: fence.installationId,
    externalWorkspaceId: fence.externalWorkspaceId,
    conversationExternalId: fence.conversationExternalId,
    restrictive: fence.restrictive,
    eventId: fence.eventId,
    operationId: fence.operationId,
    occurredAt: fence.occurredAt,
  })
  expect(replayed).toEqual({ kind: 'replayed', fence: applied.fence })

  const stale = await store.fenceParentLifecycle({
    ...fence,
    authorizationRevision: fence.authorizationRevision - 1,
    eventId: 'parent-event-stale',
    operationId: 'parent-operation-stale',
    occurredAt: retryAt,
  })
  expect(stale.kind).toBe('stale')
  if (stale.kind !== 'stale') throw new Error('Expected a stale parent lifecycle fence.')
  expect(stale.fence).toEqual(applied.fence)
})

test('link updates use CAS and unlink releases only the active source claim', async () => {
  const store = new InMemoryExternalChatStore()
  const input = createLinkInput('workspace-1', 'link-1', 'work-item-1', 'idempotency-a')
  await store.createLink(input)
  const replacement: ExternalChatWorkItemLink = {
    ...input.link,
    syncDirection: 'inbound',
    revision: 2,
    updatedAt: later,
  }
  expect((await store.updateLink({
    workspaceId: 'workspace-1',
    link: replacement,
    expectedRevision: 9,
  })).kind).toBe('conflict')
  expect((await store.updateLink({
    workspaceId: 'workspace-1',
    link: replacement,
    expectedRevision: 1,
  })).kind).toBe('updated')
  expect((await store.unlinkLink({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    expectedRevision: 1,
    unlinkedAt: later,
  })).kind).toBe('conflict')
  const unlinked = await store.unlinkLink({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    expectedRevision: 2,
    unlinkedAt: later,
  })
  expect(unlinked.kind).toBe('unlinked')
  expect(await store.getLinkBySource('workspace-1', sourceIdentity())).toBeUndefined()

  const relinked = await store.createLink(
    createLinkInput('workspace-1', 'link-2', 'work-item-2', 'idempotency-b'),
  )
  expect(relinked.kind).toBe('created')
})

test('inbound receipts reject payload conflicts and recover deferred work only when due', async () => {
  const store = new InMemoryExternalChatStore()
  const event = createInboundEvent('event-1')
  const fingerprint = createExternalChatFingerprint(event)
  const claimed = await store.claimInboundEvent({
    workspaceId: 'workspace-1',
    installationId: event.installationId,
    provider: event.provider,
    eventId: event.eventId,
    fingerprint,
    operationId: 'operation-1',
    claimedAt: now,
    leaseExpiresAt: later,
  })
  expect(claimed.kind).toBe('claimed')
  expect((await store.claimInboundEvent({
    workspaceId: 'workspace-1',
    installationId: event.installationId,
    provider: event.provider,
    eventId: event.eventId,
    fingerprint,
    operationId: 'operation-1',
    claimedAt: '2026-08-06T04:00:15.000Z',
    leaseExpiresAt: retryAt,
  })).kind).toBe('busy')
  expect((await store.claimInboundEvent({
    workspaceId: 'workspace-1',
    installationId: event.installationId,
    provider: event.provider,
    eventId: event.eventId,
    fingerprint,
    operationId: 'operation-2',
    claimedAt: '2026-08-06T04:00:30.000Z',
    leaseExpiresAt: retryAt,
  })).kind).toBe('busy')
  expect((await store.claimInboundEvent({
    workspaceId: 'workspace-1',
    installationId: event.installationId,
    provider: event.provider,
    eventId: event.eventId,
    fingerprint: createExternalChatFingerprint({ conflict: true }),
    operationId: 'operation-1',
    claimedAt: later,
    leaseExpiresAt: retryAt,
  })).kind).toBe('conflict')

  const deferred = deferredOutcome('operation-1', event.eventId)
  expect(await store.completeInboundEvent({
    workspaceId: 'workspace-1',
    installationId: event.installationId,
    provider: event.provider,
    eventId: event.eventId,
    operationId: 'operation-1',
    expectedAttempt: 1,
    outcome: { ...deferred, operationId: 'another-operation' },
    completedAt: later,
  })).toBeFalse()
  expect(await store.completeInboundEvent({
    workspaceId: 'workspace-1',
    installationId: event.installationId,
    provider: event.provider,
    eventId: event.eventId,
    operationId: 'operation-1',
    expectedAttempt: 1,
    outcome: { ...deferred, eventId: 'another-event' },
    completedAt: later,
  })).toBeFalse()
  expect(await store.completeInboundEvent({
    workspaceId: 'workspace-1',
    installationId: event.installationId,
    provider: event.provider,
    eventId: event.eventId,
    operationId: 'operation-1',
    expectedAttempt: 1,
    outcome: {
      kind: 'deferred',
      operationId: 'operation-1',
      reason: 'out-of-order',
      retryAt,
      occurredAt: later,
    },
    completedAt: later,
  })).toBeFalse()
  expect(await store.completeInboundEvent({
    workspaceId: 'workspace-1',
    installationId: event.installationId,
    provider: event.provider,
    eventId: event.eventId,
    operationId: 'operation-1',
    expectedAttempt: 1,
    outcome: deferred,
    completedAt: later,
  })).toBeTrue()
  expect(await store.completeInboundEvent({
    workspaceId: 'workspace-1',
    installationId: event.installationId,
    provider: event.provider,
    eventId: event.eventId,
    operationId: 'operation-1',
    expectedAttempt: 1,
    outcome: appliedOutcome('operation-1', 'inbound'),
    completedAt: retryAt,
  })).toBeFalse()
  expect(await store.completeInboundEvent({
    workspaceId: 'workspace-1',
    installationId: event.installationId,
    provider: event.provider,
    eventId: event.eventId,
    operationId: 'operation-1',
    expectedAttempt: 1,
    outcome: {
      ...deferred,
      operationId: 'another-operation',
    },
    completedAt: retryAt,
  })).toBeFalse()
  expect(await store.completeInboundEvent({
    workspaceId: 'workspace-1',
    installationId: event.installationId,
    provider: event.provider,
    eventId: event.eventId,
    operationId: 'operation-1',
    expectedAttempt: 1,
    outcome: {
      ...deferred,
      eventId: 'another-event',
    },
    completedAt: retryAt,
  })).toBeFalse()
  expect(await store.completeInboundEvent({
    workspaceId: 'workspace-1',
    installationId: event.installationId,
    provider: event.provider,
    eventId: event.eventId,
    operationId: 'operation-1',
    expectedAttempt: 1,
    outcome: deferred,
    completedAt: later,
  })).toBeTrue()
  expect((await store.claimInboundEvent({
    workspaceId: 'workspace-1',
    installationId: event.installationId,
    provider: event.provider,
    eventId: event.eventId,
    fingerprint,
    operationId: 'operation-1',
    claimedAt: '2026-08-06T04:01:30.000Z',
    leaseExpiresAt: '2026-08-06T04:02:30.000Z',
  })).kind).toBe('duplicate')
  const resumed = await store.claimInboundEvent({
    workspaceId: 'workspace-1',
    installationId: event.installationId,
    provider: event.provider,
    eventId: event.eventId,
    fingerprint,
    operationId: 'operation-1',
    claimedAt: retryAt,
    leaseExpiresAt: '2026-08-06T04:03:00.000Z',
  })
  expect(resumed.kind).toBe('resumed')
  expect(await store.completeInboundEvent({
    workspaceId: 'workspace-1',
    installationId: event.installationId,
    provider: event.provider,
    eventId: event.eventId,
    operationId: 'operation-1',
    expectedAttempt: 1,
    outcome: appliedOutcome('operation-1', 'inbound'),
    completedAt: '2026-08-06T04:02:30.000Z',
  })).toBeFalse()
  expect(await store.completeInboundEvent({
    workspaceId: 'workspace-1',
    installationId: event.installationId,
    provider: event.provider,
    eventId: event.eventId,
    operationId: 'operation-1',
    expectedAttempt: 2,
    outcome: appliedOutcome('operation-1', 'inbound'),
    completedAt: '2026-08-06T04:02:30.000Z',
  })).toBeTrue()
})

test('outbound receipts make provider mutations exactly-once and authenticate echo lookup', async () => {
  const store = new InMemoryExternalChatStore()
  const fingerprint = createExternalChatFingerprint({ type: 'comment.created', version: 1 })
  expect((await store.claimOutboundOperation({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    operationId: 'outbound-1',
    fingerprint,
    claimedAt: now,
    leaseExpiresAt: later,
  })).kind).toBe('claimed')
  expect((await store.claimOutboundOperation({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    operationId: 'outbound-1',
    fingerprint: createExternalChatFingerprint({ type: 'comment.created', version: 2 }),
    claimedAt: now,
    leaseExpiresAt: later,
  })).kind).toBe('conflict')
  const deferred: ExternalChatSyncOutcome = {
    kind: 'deferred',
    operationId: 'outbound-1',
    reason: 'rate-limited',
    retryAt,
    occurredAt: later,
  }
  expect(await store.completeOutboundOperation({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    operationId: 'outbound-1',
    expectedAttempt: 1,
    outcome: { ...deferred, operationId: 'another-operation' },
    completedAt: later,
  })).toBeFalse()
  expect(await store.completeOutboundOperation({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    operationId: 'outbound-1',
    expectedAttempt: 1,
    outcome: { ...deferred, eventId: 'provider-event-not-allowed' },
    completedAt: later,
  })).toBeFalse()
  expect(await store.completeOutboundOperation({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    operationId: 'outbound-1',
    expectedAttempt: 1,
    outcome: deferred,
    completedAt: later,
  })).toBeTrue()
  expect(await store.completeOutboundOperation({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    operationId: 'outbound-1',
    expectedAttempt: 1,
    outcome: appliedOutcome('outbound-1', 'outbound'),
    completedAt: retryAt,
  })).toBeFalse()
  expect(await store.completeOutboundOperation({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    operationId: 'outbound-1',
    expectedAttempt: 1,
    outcome: {
      ...deferred,
      operationId: 'another-operation',
    },
    completedAt: retryAt,
  })).toBeFalse()
  expect(await store.completeOutboundOperation({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    operationId: 'outbound-1',
    expectedAttempt: 1,
    outcome: {
      ...deferred,
      eventId: 'provider-event-not-allowed',
    },
    completedAt: retryAt,
  })).toBeFalse()
  expect(await store.completeOutboundOperation({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    operationId: 'outbound-1',
    expectedAttempt: 1,
    outcome: deferred,
    completedAt: later,
  })).toBeTrue()
  expect(await store.hasCompletedOutboundOperation(
    'workspace-1',
    'link-1',
    'outbound-1',
  )).toBeTrue()
  const duplicate = await store.claimOutboundOperation({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    operationId: 'outbound-1',
    fingerprint,
    claimedAt: later,
    leaseExpiresAt: retryAt,
  })
  expect(duplicate.kind).toBe('duplicate')
  const resumed = await store.claimOutboundOperation({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    operationId: 'outbound-1',
    fingerprint,
    claimedAt: retryAt,
    leaseExpiresAt: '2026-08-06T04:03:00.000Z',
  })
  expect(resumed).toMatchObject({ kind: 'resumed', receipt: { attempt: 2 } })
  const applied = appliedOutcome('outbound-1', 'outbound')
  expect(await store.completeOutboundOperation({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    operationId: 'outbound-1',
    expectedAttempt: 1,
    outcome: applied,
    completedAt: '2026-08-06T04:02:30.000Z',
  })).toBeFalse()
  expect(await store.completeOutboundOperation({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    operationId: 'outbound-1',
    expectedAttempt: 2,
    outcome: applied,
    completedAt: '2026-08-06T04:02:30.000Z',
  })).toBeTrue()
})

test('thread lifecycle leases order completion and reopening while fencing duplicate merges', async () => {
  const store = new InMemoryExternalChatStore()
  await store.createLink(
    createLinkInput('workspace-1', 'link-1', 'duplicate-item', 'idempotency-a'),
  )
  const claimed = await store.claimThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-complete-1',
    claimedAt: now,
    leaseExpiresAt: later,
  })
  expect(claimed).toMatchObject({
    kind: 'claimed',
    record: {
      ownerLinkRevision: 1,
      state: { completed: false, revision: 0 },
      lease: { attempt: 1, status: 'processing' },
    },
  })
  expect((await store.claimThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-complete-1',
    claimedAt: '2026-08-06T04:00:30.000Z',
    leaseExpiresAt: retryAt,
  })).kind).toBe('busy')

  const completedState = {
    completed: true,
    lastExternalVersion: 'external-version-2',
    lastInternalWorkItemRevision: 10,
    revision: 1,
    updatedAt: later,
  }
  const completionOutcome = appliedOutcome('lifecycle-complete-1', 'inbound')
  expect(await store.completeThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-complete-1',
    expectedAttempt: 1,
    nextState: completedState,
    outcome: completionOutcome,
    completedAt: later,
  })).toBeTrue()
  expect(await store.completeThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-complete-1',
    expectedAttempt: 1,
    nextState: completedState,
    outcome: completionOutcome,
    completedAt: later,
  })).toBeTrue()
  const completedReplay = await store.claimThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-complete-1',
    claimedAt: retryAt,
    leaseExpiresAt: '2026-08-06T04:03:00.000Z',
  })
  expect(completedReplay).toMatchObject({
    kind: 'completed',
    record: {
      state: completedState,
      lease: { completedOutcome: completionOutcome },
    },
  })

  expect((await store.claimThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-reopen-1',
    claimedAt: retryAt,
    leaseExpiresAt: '2026-08-06T04:03:00.000Z',
  })).kind).toBe('busy')
  expect(await store.acknowledgeThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    operationId: 'lifecycle-complete-1',
    expectedAttempt: 1,
  })).toBeTrue()
  expect(await store.acknowledgeThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    operationId: 'lifecycle-complete-1',
    expectedAttempt: 1,
  })).toBeTrue()
  const reopenClaim = await store.claimThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-reopen-1',
    claimedAt: retryAt,
    leaseExpiresAt: '2026-08-06T04:03:00.000Z',
  })
  expect(reopenClaim).toMatchObject({
    kind: 'claimed',
    record: {
      state: completedState,
      lease: { attempt: 2, status: 'processing' },
    },
  })
  expect((await store.mergeLinks({
    workspaceId: 'workspace-1',
    canonicalTeamId: 'team-1',
    canonicalWorkItemId: 'canonical-item',
    duplicateTeamId: 'team-1',
    duplicateWorkItemId: 'duplicate-item',
    links: [{ linkId: 'link-1', expectedRevision: 1 }],
    mergedAt: '2026-08-06T04:02:30.000Z',
  })).kind).toBe('conflict')

  const reopenedAt = '2026-08-06T04:02:30.000Z'
  const reopenedState = {
    completed: false,
    lastExternalVersion: 'external-version-3',
    lastInternalWorkItemRevision: 11,
    revision: 2,
    updatedAt: reopenedAt,
  }
  expect(await store.completeThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-reopen-1',
    expectedAttempt: 1,
    nextState: reopenedState,
    outcome: appliedOutcome('lifecycle-reopen-1', 'inbound'),
    completedAt: reopenedAt,
  })).toBeFalse()
  expect(await store.completeThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-reopen-1',
    expectedAttempt: 2,
    nextState: reopenedState,
    outcome: {
      ...appliedOutcome('lifecycle-reopen-1', 'inbound'),
      occurredAt: reopenedAt,
    },
    completedAt: reopenedAt,
  })).toBeTrue()
  expect((await store.mergeLinks({
    workspaceId: 'workspace-1',
    canonicalTeamId: 'team-1',
    canonicalWorkItemId: 'canonical-item',
    duplicateTeamId: 'team-1',
    duplicateWorkItemId: 'duplicate-item',
    links: [{ linkId: 'link-1', expectedRevision: 1 }],
    mergedAt: '2026-08-06T04:03:00.000Z',
  })).kind).toBe('conflict')
  expect(await store.acknowledgeThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    operationId: 'lifecycle-reopen-1',
    expectedAttempt: 2,
  })).toBeTrue()
  expect((await store.mergeLinks({
    workspaceId: 'workspace-1',
    canonicalTeamId: 'team-1',
    canonicalWorkItemId: 'canonical-item',
    duplicateTeamId: 'team-1',
    duplicateWorkItemId: 'duplicate-item',
    links: [{ linkId: 'link-1', expectedRevision: 1 }],
    mergedAt: '2026-08-06T04:03:00.000Z',
  })).kind).toBe('merged')
  expect(await store.getThreadLifecycle('workspace-1', 'link-1', 'slack')).toMatchObject({
    ownerLinkRevision: 2,
    state: reopenedState,
  })
})

test('thread lifecycle validates link scope, revisions, and optional ordering versions', async () => {
  const store = new InMemoryExternalChatStore()
  await store.createLink(createLinkInput('workspace-1', 'link-1', 'item-1', 'idempotency-a'))
  await expect(store.claimThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'microsoft-teams',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-1',
    claimedAt: now,
    leaseExpiresAt: later,
  })).rejects.toMatchObject({ code: 'ExternalChatValidationFailed' })
  await expect(store.claimThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 2,
    operationId: 'lifecycle-1',
    claimedAt: now,
    leaseExpiresAt: later,
  })).rejects.toMatchObject({ code: 'ExternalChatRevisionConflict' })
  await store.claimThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-1',
    claimedAt: now,
    leaseExpiresAt: later,
  })
  await expect(store.completeThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-1',
    expectedAttempt: 1,
    nextState: {
      completed: false,
      lastInternalWorkItemRevision: 0,
      revision: 1,
      updatedAt: later,
    },
    outcome: appliedOutcome('lifecycle-1', 'inbound'),
    completedAt: later,
  })).rejects.toMatchObject({ code: 'ExternalChatValidationFailed' })
})

test('acknowledging a deferred lifecycle result allows the same operation to resume', async () => {
  const store = new InMemoryExternalChatStore()
  await store.createLink(createLinkInput('workspace-1', 'link-1', 'item-1', 'idempotency-a'))
  await store.claimThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-deferred-1',
    claimedAt: now,
    leaseExpiresAt: later,
  })
  const deferred: ExternalChatSyncOutcome = {
    kind: 'deferred',
    operationId: 'lifecycle-deferred-1',
    eventId: 'event-1',
    reason: 'out-of-order',
    retryAt,
    occurredAt: later,
  }
  expect(await store.completeThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-deferred-1',
    expectedAttempt: 1,
    nextState: {
      completed: false,
      revision: 1,
      updatedAt: later,
    },
    outcome: deferred,
    completedAt: later,
  })).toBeTrue()
  expect(await store.acknowledgeThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    operationId: 'lifecycle-deferred-1',
    expectedAttempt: 1,
  })).toBeTrue()
  expect(await store.claimThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-deferred-1',
    claimedAt: retryAt,
    leaseExpiresAt: '2026-08-06T04:03:00.000Z',
  })).toMatchObject({
    kind: 'resumed',
    record: {
      state: { completed: false, revision: 1 },
      lease: { attempt: 2, status: 'processing' },
    },
  })
})

test('link updates and unlinking honor active and unacknowledged lifecycle fences', async () => {
  const store = new InMemoryExternalChatStore()
  const input = createLinkInput('workspace-1', 'link-1', 'item-1', 'idempotency-a')
  await store.createLink(input)
  await store.claimThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-1',
    claimedAt: now,
    leaseExpiresAt: later,
  })
  const projected: ExternalChatWorkItemLink = {
    ...input.link,
    syncStatus: 'synced',
    revision: 2,
    updatedAt: later,
  }
  expect((await store.updateLink({
    workspaceId: 'workspace-1',
    link: projected,
    expectedRevision: 1,
    lifecycleOperationId: 'lifecycle-1',
  })).kind).toBe('conflict')
  expect(await store.completeThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-1',
    expectedAttempt: 1,
    nextState: {
      completed: true,
      lastExternalVersion: 'version-2',
      revision: 1,
      updatedAt: later,
    },
    outcome: appliedOutcome('lifecycle-1', 'inbound'),
    completedAt: later,
  })).toBeTrue()
  expect((await store.updateLink({
    workspaceId: 'workspace-1',
    link: projected,
    expectedRevision: 1,
  })).kind).toBe('conflict')
  expect((await store.updateLink({
    workspaceId: 'workspace-1',
    link: projected,
    expectedRevision: 1,
    lifecycleOperationId: 'lifecycle-1',
  })).kind).toBe('updated')
  expect(await store.getThreadLifecycle('workspace-1', 'link-1', 'slack')).toMatchObject({
    ownerLinkRevision: 2,
    lease: { status: 'completed' },
  })
  expect(await store.acknowledgeThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    operationId: 'lifecycle-1',
    expectedAttempt: 1,
  })).toBeTrue()

  const userUpdated: ExternalChatWorkItemLink = {
    ...projected,
    syncDirection: 'inbound',
    revision: 3,
    updatedAt: retryAt,
  }
  expect((await store.updateLink({
    workspaceId: 'workspace-1',
    link: userUpdated,
    expectedRevision: 2,
  })).kind).toBe('updated')
  await store.claimThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 3,
    operationId: 'lifecycle-2',
    claimedAt: retryAt,
    leaseExpiresAt: '2026-08-06T04:03:00.000Z',
  })
  expect((await store.unlinkLink({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    expectedRevision: 3,
    unlinkedAt: '2026-08-06T04:02:30.000Z',
  })).kind).toBe('conflict')
  const finishedAt = '2026-08-06T04:02:30.000Z'
  expect(await store.completeThreadLifecycle({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 3,
    operationId: 'lifecycle-2',
    expectedAttempt: 2,
    nextState: {
      completed: false,
      lastExternalVersion: 'version-3',
      revision: 2,
      updatedAt: finishedAt,
    },
    outcome: {
      ...appliedOutcome('lifecycle-2', 'inbound'),
      occurredAt: finishedAt,
    },
    completedAt: finishedAt,
  })).toBeTrue()
  expect((await store.unlinkLink({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    expectedRevision: 3,
    lifecycleOperationId: 'lifecycle-2',
    unlinkedAt: finishedAt,
  })).kind).toBe('unlinked')
})

test('parent lookup, receipt checkpoints, and restrictive deferred purge stay scoped', async () => {
  const store = new InMemoryExternalChatStore()
  const first = createLinkInput('workspace-1', 'parent-link-1', 'work-item-1', 'parent-idem-1')
  await store.createLink(first)
  const secondIdentity: ExternalChatSourceIdentity = {
    ...first.source,
    conversationExternalId: 'conversation-2',
    threadExternalId: 'thread-2',
  }
  const second = createLinkInput('workspace-1', 'parent-link-2', 'work-item-2', 'parent-idem-2')
  second.source = secondIdentity
  second.link = {
    ...second.link,
    conversation: {
      ...second.link.conversation,
      externalId: secondIdentity.conversationExternalId,
    },
    source: {
      ...second.link.source,
      conversationExternalId: secondIdentity.conversationExternalId,
      threadExternalId: secondIdentity.threadExternalId,
    },
  }
  await store.createLink(second)
  const otherInstallationIdentity: ExternalChatSourceIdentity = {
    ...first.source,
    conversationExternalId: 'conversation-other-installation',
    threadExternalId: 'thread-other-installation',
  }
  const otherInstallation = createLinkInput(
    'workspace-1',
    'parent-link-other-installation',
    'work-item-other-installation',
    'parent-idem-other-installation',
  )
  otherInstallation.source = otherInstallationIdentity
  otherInstallation.link = {
    ...otherInstallation.link,
    installationId: 'installation-2',
    conversation: {
      ...otherInstallation.link.conversation,
      externalId: otherInstallationIdentity.conversationExternalId,
    },
    source: {
      ...otherInstallation.link.source,
      conversationExternalId: otherInstallationIdentity.conversationExternalId,
      threadExternalId: otherInstallationIdentity.threadExternalId,
    },
  }
  await store.createLink(otherInstallation)

  const firstPage = await store.listParentLinks({
    workspaceId: 'workspace-1',
    provider: 'slack',
    installationId: 'installation-1',
    externalWorkspaceId: 'external-workspace-1',
    maximumSourceAuthorizationRevision: 1,
    limit: 1,
  })
  expect(firstPage.links).toHaveLength(1)
  expect(firstPage.nextCursor).toBeDefined()
  const secondPage = await store.listParentLinks({
    workspaceId: 'workspace-1',
    provider: 'slack',
    installationId: 'installation-1',
    externalWorkspaceId: 'external-workspace-1',
    maximumSourceAuthorizationRevision: 1,
    ...(firstPage.nextCursor === undefined ? {} : { cursor: firstPage.nextCursor }),
    limit: 10,
  })
  expect([...firstPage.links, ...secondPage.links].map((record) => record.link.id).sort())
    .toEqual(['parent-link-1', 'parent-link-2'])
  expect((await store.listParentLinks({
    workspaceId: 'workspace-1',
    provider: 'slack',
    installationId: 'installation-1',
    externalWorkspaceId: 'external-workspace-1',
    conversationExternalId: 'conversation-2',
    maximumSourceAuthorizationRevision: 1,
    limit: 10,
  })).links.map((record) => record.link.id)).toEqual(['parent-link-2'])

  const receiptEvent = createInboundEvent('parent-fanout-receipt')
  const receiptFingerprint = createExternalChatFingerprint(receiptEvent)
  expect((await store.claimInboundEvent({
    workspaceId: 'workspace-1',
    installationId: receiptEvent.installationId,
    provider: receiptEvent.provider,
    eventId: receiptEvent.eventId,
    fingerprint: receiptFingerprint,
    operationId: 'parent-fanout-operation',
    claimedAt: now,
    leaseExpiresAt: later,
  })).kind).toBe('claimed')
  expect(await store.checkpointInboundEvent({
    workspaceId: 'workspace-1',
    installationId: receiptEvent.installationId,
    provider: receiptEvent.provider,
    eventId: receiptEvent.eventId,
    operationId: 'parent-fanout-operation',
    expectedAttempt: 1,
    nextCursor: 'opaque-parent-cursor',
    checkpointedAt: '2026-08-06T04:00:30.000Z',
    leaseExpiresAt: retryAt,
  })).toBeTrue()
  const receiptDeferred = deferredOutcome('parent-fanout-operation', receiptEvent.eventId)
  expect(await store.completeInboundEvent({
    workspaceId: 'workspace-1',
    installationId: receiptEvent.installationId,
    provider: receiptEvent.provider,
    eventId: receiptEvent.eventId,
    operationId: 'parent-fanout-operation',
    expectedAttempt: 1,
    outcome: receiptDeferred,
    completedAt: later,
  })).toBeTrue()
  const resumed = await store.claimInboundEvent({
    workspaceId: 'workspace-1',
    installationId: receiptEvent.installationId,
    provider: receiptEvent.provider,
    eventId: receiptEvent.eventId,
    fingerprint: receiptFingerprint,
    operationId: 'parent-fanout-operation',
    claimedAt: retryAt,
    leaseExpiresAt: '2026-08-06T04:03:00.000Z',
  })
  expect(resumed).toMatchObject({
    kind: 'resumed',
    receipt: { parentLifecycleCursor: 'opaque-parent-cursor' },
  })

  const retainedEvent = createInboundEvent('retained-current-event')
  const purgedEvent = createInboundEvent('purged-sensitive-event')
  for (const event of [retainedEvent, purgedEvent]) {
    await store.deferEvent({
      workspaceId: 'workspace-1',
      linkId: first.link.id,
      event,
      fingerprint: createExternalChatFingerprint(event),
      reason: 'out-of-order',
      attempt: 1,
      retryAt,
      createdAt: now,
      updatedAt: now,
    })
  }
  expect(await store.purgeDeferredEventsForLink(
    'workspace-1',
    first.link.id,
    retainedEvent.eventId,
  )).toBe(1)
  expect((await store.listDueDeferredEvents(
    'workspace-1',
    first.link.id,
    retryAt,
    10,
  )).map((event) => event.event.eventId)).toEqual([retainedEvent.eventId])
  expect((await store.unlinkLink({
    workspaceId: 'workspace-1',
    linkId: second.link.id,
    expectedRevision: 1,
    unlinkedAt: later,
  })).kind).toBe('unlinked')
  expect((await store.listParentLinks({
    workspaceId: 'workspace-1',
    provider: 'slack',
    installationId: 'installation-1',
    externalWorkspaceId: 'external-workspace-1',
    maximumSourceAuthorizationRevision: 1,
    limit: 10,
  })).links.map((record) => record.link.id)).toEqual(['parent-link-1'])
})

test('message bindings enforce one-to-one identities and optimistic replacement', async () => {
  const store = new InMemoryExternalChatStore()
  await store.createLink(
    createLinkInput('workspace-1', 'link-1', 'work-item-1', 'binding-owner'),
  )
  const expectedOwner = {
    expectedTeamId: 'team-1',
    expectedWorkItemId: 'work-item-1',
    expectedLinkRevision: 1,
  }
  const first = createBinding('external-1', 'comment-1', ['file-1'])
  const stored = await store.putMessageBinding({
    workspaceId: 'workspace-1',
    binding: first,
    ...expectedOwner,
  })
  expect(stored.kind).toBe('stored')
  if (stored.kind !== 'stored') throw new Error('Expected a stored binding.')
  expect((await store.putMessageBinding({
    workspaceId: 'workspace-1',
    binding: { ...first, internalCommentId: 'comment-2' },
    ...expectedOwner,
  })).kind).toBe('identity-conflict')
  expect((await store.putMessageBinding({
    workspaceId: 'workspace-1',
    binding: { ...first, externalVersion: '2', updatedAt: later },
    expectedStorageRevision: 9,
    ...expectedOwner,
  })).kind).toBe('revision-conflict')
  const replaced = await store.putMessageBinding({
    workspaceId: 'workspace-1',
    binding: { ...first, externalVersion: '2', updatedAt: later },
    expectedStorageRevision: stored.record.storageRevision,
    ...expectedOwner,
  })
  expect(replaced.kind).toBe('stored')
  expect((await store.getMessageBindingByInternalId(
    'workspace-1',
    'link-1',
    'comment-1',
  ))?.binding.externalVersion).toBe('2')
})

test('duplicate merge retargets links while retaining bindings, files, and canonical redirect', async () => {
  const store = new InMemoryExternalChatStore()
  const input = createLinkInput('workspace-1', 'link-1', 'duplicate-item', 'idempotency-a')
  await store.createLink(input)
  const secondInputBase = createLinkInput(
    'workspace-1',
    'link-2',
    'duplicate-item',
    'idempotency-b',
  )
  const secondSource: ExternalChatSourceIdentity = {
    ...secondInputBase.source,
    threadExternalId: 'thread-2',
  }
  await store.createLink({
    ...secondInputBase,
    source: secondSource,
    link: {
      ...secondInputBase.link,
      source: {
        ...secondInputBase.link.source,
        threadExternalId: secondSource.threadExternalId,
        rootMessageExternalId: 'root-message-2',
        sourcePermalink: 'https://chat.example.test/thread-2',
      },
    },
  })
  await store.putMessageBinding({
    workspaceId: 'workspace-1',
    binding: createBinding('external-1', 'comment-1', ['file-2', 'file-1']),
    expectedTeamId: 'team-1',
    expectedWorkItemId: 'duplicate-item',
    expectedLinkRevision: 1,
  })
  const merged = await store.mergeLinks({
    workspaceId: 'workspace-1',
    canonicalTeamId: 'team-1',
    canonicalWorkItemId: 'canonical-item',
    duplicateTeamId: 'team-1',
    duplicateWorkItemId: 'duplicate-item',
    links: [
      { linkId: 'link-1', expectedRevision: 1 },
      { linkId: 'link-2', expectedRevision: 1 },
    ],
    mergedAt: later,
  })
  expect(merged.kind).toBe('merged')
  if (merged.kind !== 'merged') throw new Error('Expected a completed merge.')
  expect(merged.movedLinks[0]?.workItemId).toBe('canonical-item')
  expect(merged.movedLinks).toHaveLength(2)
  expect(merged.movedFileIds).toEqual(['file-1', 'file-2'])
  expect(merged.movedMessageBindingCount).toBe(1)
  expect((await store.getCanonicalRedirect(
    'workspace-1',
    'team-1',
    'duplicate-item',
  ))?.canonicalWorkItemId).toBe('canonical-item')
  for (const movedLinkId of ['link-1', 'link-2']) {
    expect((await store.getCanonicalRedirect(
      'workspace-1',
      'team-1',
      'duplicate-item',
      movedLinkId,
    ))?.linkId).toBe(movedLinkId)
  }
})

/**
 * Creates one deterministic unique source identity.
 *
 * @returns Provider-neutral Slack thread identity.
 */
function sourceIdentity(): ExternalChatSourceIdentity {
  return {
    provider: 'slack',
    externalWorkspaceId: 'external-workspace-1',
    conversationExternalId: 'conversation-1',
    threadExternalId: 'thread-1',
  }
}

/**
 * Creates one complete link input for store tests.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param linkId - Stable link identifier.
 * @param workItemId - Linked Work Item identifier.
 * @param idempotencyKeyHash - Synthetic idempotency digest.
 * @returns Complete link creation input.
 */
function createLinkInput(
  workspaceId: string,
  linkId: string,
  workItemId: string,
  idempotencyKeyHash: string,
): CreateExternalChatLinkInput {
  const identity = sourceIdentity()
  const link: ExternalChatWorkItemLink = {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    id: linkId,
    teamId: 'team-1',
    workItemId,
    installationId: 'installation-1',
    provider: identity.provider,
    workspace: {
      provider: identity.provider,
      externalId: identity.externalWorkspaceId,
      displayName: 'Synthetic workspace',
    },
    conversation: {
      externalId: identity.conversationExternalId,
      externalWorkspaceId: identity.externalWorkspaceId,
      kind: 'channel',
      displayName: 'Synthetic channel',
    },
    source: {
      externalWorkspaceId: identity.externalWorkspaceId,
      conversationExternalId: identity.conversationExternalId,
      threadExternalId: identity.threadExternalId,
      rootMessageExternalId: 'root-message-1',
      sourcePermalink: 'https://chat.example.test/thread-1',
    },
    syncDirection: 'bidirectional',
    syncStatus: 'pending',
    sourceAvailability: 'available',
    sourceState: 'active',
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  return {
    workspaceId,
    link,
    source: identity,
    authorizationRevision: 1,
    idempotencyKeyHash,
    requestFingerprint: createExternalChatFingerprint({ linkId, workItemId }),
  }
}

/**
 * Creates a normalized inbound message event for receipt tests.
 *
 * @param eventId - Stable provider event identifier.
 * @returns Provider-neutral event.
 */
function createInboundEvent(eventId: string): ExternalChatInboundEvent {
  return {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    type: 'message.created',
    eventId,
    correlationId: `correlation-${eventId}`,
    installationId: 'installation-1',
    provider: 'slack',
    externalWorkspaceId: 'external-workspace-1',
    conversationExternalId: 'conversation-1',
    threadExternalId: 'thread-1',
    occurredAt: now,
    message: {
      externalId: 'external-1',
      externalVersion: '1',
      conversationExternalId: 'conversation-1',
      threadExternalId: 'thread-1',
      permalink: 'https://chat.example.test/message-1',
      availability: 'available',
      state: 'active',
      bodyMarkdown: 'Synthetic reply',
      quotedRanges: [],
      attachments: [],
      postedAt: now,
      updatedAt: now,
    },
  }
}

/**
 * Creates a deferred synchronization outcome.
 *
 * @param operationId - Stable operation identifier.
 * @param eventId - Provider event identifier.
 * @returns Retryable deferred outcome.
 */
function deferredOutcome(operationId: string, eventId: string): ExternalChatSyncOutcome {
  return {
    kind: 'deferred',
    operationId,
    eventId,
    reason: 'out-of-order',
    retryAt,
    occurredAt: later,
  }
}

/**
 * Creates a successful synchronization outcome.
 *
 * @param operationId - Stable operation identifier.
 * @param direction - Applied synchronization direction.
 * @returns Applied outcome.
 */
function appliedOutcome(
  operationId: string,
  direction: 'inbound' | 'outbound',
): ExternalChatSyncOutcome {
  return {
    kind: 'applied',
    operationId,
    ...(direction === 'inbound' ? { eventId: 'event-1' } : {}),
    direction,
    occurredAt: later,
  }
}

/**
 * Creates a complete message-to-comment binding.
 *
 * @param externalMessageId - Provider message identifier.
 * @param internalCommentId - Internal comment identifier.
 * @param importedFileIds - Link-owned scanned file identifiers.
 * @returns Provider-neutral binding.
 */
function createBinding(
  externalMessageId: string,
  internalCommentId: string,
  importedFileIds: string[],
): ExternalChatMessageBinding {
  return {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    linkId: 'link-1',
    externalMessageId,
    internalCommentId,
    origin: 'external',
    externalVersion: '1',
    internalCommentVersion: 1,
    importedFileIds,
    createdAt: now,
    updatedAt: now,
  }
}
