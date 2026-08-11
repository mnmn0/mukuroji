import { afterEach, describe, expect, test } from 'bun:test'
import {
  LEGACY_PLANNING_SCHEMA_VERSION,
  type PlanningUpdate,
  type PlanningUpdateTarget,
  type PlanningUpdateTargetSummary,
} from '@mukuroji/contracts'
import {
  addPlanningUpdateReaction,
  archivePlanningEntity,
  configurePlanningUpdateCadence,
  createPlanningUpdateComment,
  createPlanningDependency,
  createPlanningEntity,
  createWorkItemScheduleDependency,
  deletePlanningDependency,
  deletePlanningWorkItemLink,
  deleteWorkItemScheduleDependency,
  duplicatePlanningEntity,
  exportPlanningUpdates,
  getPlanningUpdateWatch,
  getPlanningSnapshot,
  listPlanningUpdateComments,
  listPlanningUpdateReactions,
  listPlanningUpdates,
  movePlanningEntity,
  PlanningApiError,
  publishPlanningUpdate,
  putPlanningWorkItemLink,
  resolvePlanningErrorMessageKey,
  rolloverPlanningCycle,
  removePlanningUpdateReaction,
  subscribePlanningUpdateWatch,
  unsubscribePlanningUpdateWatch,
  updatePlanningEntity,
  updateWorkItemScheduleDependency,
} from '../src/planning/api'
import {
  planningSnapshotFixture,
  planningUpdateHistoryFixture,
} from '../src/planning/fixtures'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'correlation-planning',
  idempotencyKey: 'idempotency-planning',
}
const projectUpdateTarget = {
  projectId: 'refero',
  teamId: 'core-team',
  type: 'project',
} satisfies PlanningUpdateTarget
const initiativeUpdateTarget = {
  entityId: 'initiative-onboarding',
  type: 'initiative',
} satisfies PlanningUpdateTarget

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Planning API', () => {
  test('loads a Workspace planning snapshot with authorization', async () => {
    const requests = installFetchRecorder(planningSnapshotFixture)

    await expect(getPlanningSnapshot('access-token')).resolves.toEqual(planningSnapshotFixture)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('/api/planning')
    expect(requests[0]?.init.headers).toMatchObject({ Authorization: 'Bearer access-token' })
  })

  test('defaults update targets during a rolling v2 deployment', async () => {
    const rollingSnapshot = {
      criticalPath: planningSnapshotFixture.criticalPath,
      dependencies: planningSnapshotFixture.dependencies,
      entities: planningSnapshotFixture.entities,
      revision: planningSnapshotFixture.revision,
      schemaVersion: planningSnapshotFixture.schemaVersion,
      updatedAt: planningSnapshotFixture.updatedAt,
      workItemDependencies: planningSnapshotFixture.workItemDependencies,
      workItemDependencySummary: planningSnapshotFixture.workItemDependencySummary,
      workItemLinks: planningSnapshotFixture.workItemLinks,
      workItems: planningSnapshotFixture.workItems,
    }
    installFetchRecorder(rollingSnapshot)

    await expect(getPlanningSnapshot('access-token')).resolves.toMatchObject({
      schemaVersion: 2,
      updateTargets: [],
    })
  })

  test('upgrades a dependency-free v1 snapshot during a rolling deployment', async () => {
    const legacySnapshot = {
      criticalPath: planningSnapshotFixture.criticalPath,
      dependencies: planningSnapshotFixture.dependencies,
      entities: planningSnapshotFixture.entities,
      revision: planningSnapshotFixture.revision,
      schemaVersion: LEGACY_PLANNING_SCHEMA_VERSION,
      updatedAt: planningSnapshotFixture.updatedAt,
      workItemLinks: planningSnapshotFixture.workItemLinks,
      workItems: planningSnapshotFixture.workItems,
    }
    installFetchRecorder(legacySnapshot)

    await expect(getPlanningSnapshot('access-token')).resolves.toMatchObject({
      schemaVersion: 2,
      workItemDependencies: [],
      workItemDependencySummary: {
        affectedMilestoneIds: [],
        affectedProjectIds: [],
        affectedProjects: [],
        conflicts: [],
        unresolvedBlockerCount: 0,
      },
    })
  })

  test('adds Team-qualified Projects to a v1 dependency summary', async () => {
    const legacySnapshot = {
      ...planningSnapshotFixture,
      schemaVersion: LEGACY_PLANNING_SCHEMA_VERSION,
      workItemDependencySummary: {
        affectedMilestoneIds:
          planningSnapshotFixture.workItemDependencySummary.affectedMilestoneIds,
        affectedProjectIds:
          planningSnapshotFixture.workItemDependencySummary.affectedProjectIds,
        conflicts: planningSnapshotFixture.workItemDependencySummary.conflicts,
        criticalPath: planningSnapshotFixture.workItemDependencySummary.criticalPath,
        unresolvedBlockerCount:
          planningSnapshotFixture.workItemDependencySummary.unresolvedBlockerCount,
      },
    }
    installFetchRecorder(legacySnapshot)

    await expect(getPlanningSnapshot('access-token')).resolves.toMatchObject({
      schemaVersion: 2,
      workItemDependencySummary: {
        affectedProjects: [{ projectId: 'refero', teamId: 'core-team' }],
      },
    })
  })

  test('keeps ambiguous v1 Project IDs out of Team-qualified navigation', async () => {
    const coreWorkItem = planningSnapshotFixture.workItems[0]
    const ambiguousWorkItem = {
      ...coreWorkItem,
      id: 'design-refero-item',
      teamId: 'design-team',
    }
    const uniqueWorkItem = {
      ...coreWorkItem,
      id: 'operations-release-item',
      projectId: 'operations-release',
      teamId: 'operations-team',
    }
    const affectedProjectIds = ['refero', 'operations-release', 'not-visible']
    const legacySnapshot = {
      ...planningSnapshotFixture,
      schemaVersion: LEGACY_PLANNING_SCHEMA_VERSION,
      workItemDependencySummary: {
        affectedMilestoneIds:
          planningSnapshotFixture.workItemDependencySummary.affectedMilestoneIds,
        affectedProjectIds,
        conflicts: planningSnapshotFixture.workItemDependencySummary.conflicts,
        criticalPath: planningSnapshotFixture.workItemDependencySummary.criticalPath,
        unresolvedBlockerCount:
          planningSnapshotFixture.workItemDependencySummary.unresolvedBlockerCount,
      },
      workItems: [
        ...planningSnapshotFixture.workItems,
        ambiguousWorkItem,
        uniqueWorkItem,
      ],
    }
    installFetchRecorder(legacySnapshot)

    await expect(getPlanningSnapshot('access-token')).resolves.toMatchObject({
      schemaVersion: 2,
      workItemDependencySummary: {
        affectedProjectIds,
        affectedProjects: [{ projectId: 'operations-release', teamId: 'operations-team' }],
      },
    })
  })

  test('uses stable mutation headers for entity lifecycle endpoints', async () => {
    const requests = installFetchRecorder(planningSnapshotFixture)
    const entityInput = {
      id: 'goal/new',
      type: 'goal' as const,
      title: 'New goal',
      ownerMemberKey: 'owner@example.com',
      status: 'planned' as const,
      health: 'unknown' as const,
      risk: 'low' as const,
      progressMode: 'automatic' as const,
      baseline: { startDate: '2026-08-01', endDate: '2026-09-01' },
      forecast: { startDate: '2026-08-01', endDate: '2026-09-01' },
      expectedRevision: 12,
    }

    await expect(createPlanningEntity('access-token', entityInput, mutationContext))
      .resolves.toEqual(planningSnapshotFixture)
    await updatePlanningEntity('access-token', 'goal/new', {
      expectedRevision: 12,
      patch: { title: 'Updated goal' },
    }, mutationContext)
    await archivePlanningEntity('access-token', 'goal/new', {
      expectedRevision: 12,
    }, mutationContext)
    await duplicatePlanningEntity('access-token', 'goal/new', {
      expectedRevision: 12,
      targetId: 'goal/copy',
    }, mutationContext)
    await movePlanningEntity('access-token', 'goal/new', {
      expectedRevision: 12,
      parentId: 'portfolio/product',
    }, mutationContext)

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['POST', '/api/planning/entities'],
      ['PATCH', '/api/planning/entities/goal%2Fnew'],
      ['POST', '/api/planning/entities/goal%2Fnew/archive'],
      ['POST', '/api/planning/entities/goal%2Fnew/duplicate'],
      ['POST', '/api/planning/entities/goal%2Fnew/move'],
    ])
    for (const request of requests) {
      expect(request.init.headers).toMatchObject({
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idempotency-planning',
        'X-Correlation-Id': 'correlation-planning',
      })
    }
  })

  test('mutates dependencies, Work Item links, and cycle rollover through encoded paths', async () => {
    const requests = installFetchRecorder((url) =>
      url.endsWith('/rollover') ? createMutationResponse() : planningSnapshotFixture,
    )

    await createPlanningDependency('access-token', {
      id: 'dependency/1',
      predecessorId: 'phase/1',
      successorId: 'milestone/1',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 12,
    }, mutationContext)
    await deletePlanningDependency('access-token', 'dependency/1', {
      expectedRevision: 12,
    }, mutationContext)
    await putPlanningWorkItemLink('access-token', 'core/team', 'work/item', {
      teamId: 'core/team',
      workItemId: 'work/item',
      projectId: 'refero',
      cycleId: 'cycle-14',
      milestoneId: 'milestone-beta',
      goalIds: ['goal-activation'],
      expectedRevision: 12,
    }, mutationContext)
    await deletePlanningWorkItemLink('access-token', 'core/team', 'work/item', {
      expectedRevision: 12,
    }, mutationContext)
    await expect(rolloverPlanningCycle('access-token', 'cycle/14', {
      targetCycleId: 'cycle-15',
      expectedRevision: 12,
    }, mutationContext)).resolves.toEqual(createMutationResponse())

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['POST', '/api/planning/dependencies'],
      ['DELETE', '/api/planning/dependencies/dependency%2F1'],
      ['PUT', '/api/planning/work-item-links/core%2Fteam/work%2Fitem'],
      ['DELETE', '/api/planning/work-item-links/core%2Fteam/work%2Fitem'],
      ['POST', '/api/planning/cycles/cycle%2F14/rollover'],
    ])
    expect(JSON.parse(String(requests[4]?.init.body))).toEqual({
      targetCycleId: 'cycle-15',
      expectedRevision: 12,
    })
  })

  test('creates, updates, and deletes canonical cross-Team Work Item dependencies', async () => {
    const requests = installFetchRecorder(planningSnapshotFixture)

    await createWorkItemScheduleDependency('access-token', {
      expectedRevision: 12,
      id: 'edge/1',
      predecessor: { teamId: 'team/a', workItemId: 'item/a' },
      successor: { teamId: 'team/b', workItemId: 'item/b' },
      type: 'start-to-finish',
      lagDays: -2,
      constraint: { anchor: 'finish', date: '2026-08-01', kind: 'not-after' },
    }, mutationContext)
    await updateWorkItemScheduleDependency('access-token', 'edge/1', {
      expectedRevision: 13,
      patch: { constraint: null, lagDays: 3 },
    }, mutationContext)
    await deleteWorkItemScheduleDependency('access-token', 'edge/1', {
      expectedRevision: 14,
    }, mutationContext)

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['POST', '/api/planning/work-item-dependencies'],
      ['PATCH', '/api/planning/work-item-dependencies/edge%2F1'],
      ['DELETE', '/api/planning/work-item-dependencies/edge%2F1'],
    ])
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      constraint: { anchor: 'finish', date: '2026-08-01', kind: 'not-after' },
      expectedRevision: 12,
      id: 'edge/1',
      lagDays: -2,
      predecessor: { teamId: 'team/a', workItemId: 'item/a' },
      successor: { teamId: 'team/b', workItemId: 'item/b' },
      type: 'start-to-finish',
    })
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      expectedRevision: 13,
      patch: { constraint: null, lagDays: 3 },
    })
  })

  test('configures cadence, publishes an update, and lists validated immutable history', async () => {
    const update = getPlanningUpdateFixture()
    const updateTarget = getPlanningUpdateTargetSummary('project')
    const cadenceInput = {
      cadence: updateTarget.cadence ?? null,
      expectedRevision: planningSnapshotFixture.revision,
      target: projectUpdateTarget,
    }
    const publishInput = {
      decisionSummary: update.decisionSummary,
      evidence: update.evidence,
      expectedRevision: planningSnapshotFixture.revision,
      health: update.health,
      helpNeeded: update.helpNeeded,
      id: 'update-initiative-3',
      nextAction: update.nextAction,
      risk: update.risk,
      riskSummary: update.riskSummary,
      summary: update.summary,
      target: initiativeUpdateTarget,
    }
    const cadenceResponse = {
      planning: planningSnapshotFixture,
      updateTarget,
    }
    const publishResponse = {
      planning: planningSnapshotFixture,
      update,
    }
    const historyResponse = {
      nextCursor: 'history/cursor',
      updates: planningUpdateHistoryFixture,
    }
    const requests = installFetchRecorder((url, init) => {
      if (url.endsWith('/cadence')) return cadenceResponse
      if (init.method === 'POST') return publishResponse
      return historyResponse
    })

    await expect(configurePlanningUpdateCadence(
      'access-token',
      cadenceInput,
      mutationContext,
    )).resolves.toEqual(cadenceResponse)
    await expect(publishPlanningUpdate(
      'access-token',
      publishInput,
      mutationContext,
    )).resolves.toEqual(publishResponse)
    await expect(listPlanningUpdates('access-token', {
      cursor: 'cursor/next',
      limit: 25,
      target: initiativeUpdateTarget,
    })).resolves.toEqual(historyResponse)

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['PUT', '/api/planning/updates/cadence'],
      ['POST', '/api/planning/updates'],
      [
        'GET',
        '/api/planning/updates?targetType=initiative&entityId=initiative-onboarding&limit=25&cursor=cursor%2Fnext',
      ],
    ])
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual(cadenceInput)
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual(publishInput)
    for (const request of requests.slice(0, 2)) {
      expect(request.init.headers).toMatchObject({
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idempotency-planning',
        'X-Correlation-Id': 'correlation-planning',
      })
    }
  })

  test('gets, subscribes, and unsubscribes a Team-qualified Project update watch', async () => {
    const watchResponse = {
      watch: {
        automatic: false,
        explicit: true,
        reasons: ['explicit'],
        subscribed: true,
        watcherCount: 3,
      },
    }
    const requests = installFetchRecorder(watchResponse)

    await expect(getPlanningUpdateWatch(
      'access-token',
      projectUpdateTarget,
    )).resolves.toEqual(watchResponse.watch)
    await expect(subscribePlanningUpdateWatch(
      'access-token',
      projectUpdateTarget,
      mutationContext,
    )).resolves.toEqual(watchResponse.watch)
    await expect(unsubscribePlanningUpdateWatch(
      'access-token',
      projectUpdateTarget,
      mutationContext,
    )).resolves.toEqual(watchResponse.watch)

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      [
        'GET',
        '/api/planning/update-watch?targetType=project&teamId=core-team&projectId=refero',
      ],
      [
        'PUT',
        '/api/planning/update-watch?targetType=project&teamId=core-team&projectId=refero',
      ],
      [
        'DELETE',
        '/api/planning/update-watch?targetType=project&teamId=core-team&projectId=refero',
      ],
    ])
    for (const request of requests.slice(1)) {
      expect(request.init.headers).toMatchObject({
        Authorization: 'Bearer access-token',
        'Idempotency-Key': 'idempotency-planning',
        'X-Correlation-Id': 'correlation-planning',
      })
    }
  })

  test('exports Team-qualified Project update history with a server filename', async () => {
    const exportBody = {
      exportedAt: '2026-07-16T03:00:00.000Z',
      schemaVersion: 1,
      target: projectUpdateTarget,
      updates: [],
    }
    const requests = installFetchRecorder(exportBody, {
      'Content-Disposition': 'attachment; filename="planning-updates-core-team-refero.json"',
      'Content-Type': 'application/json',
    })

    const artifact = await exportPlanningUpdates('access-token', projectUpdateTarget)

    expect(artifact.filename).toBe('planning-updates-core-team-refero.json')
    expect(await artifact.blob.text()).toBe(JSON.stringify(exportBody))
    expect(requests).toEqual([{
      init: {
        headers: { Authorization: 'Bearer access-token' },
        method: 'GET',
      },
      url: '/api/planning/updates/export?targetType=project&teamId=core-team&projectId=refero',
    }])
  })

  test('lists and mutates immutable update comments and reactions by target-local version', async () => {
    const comment = {
      authorMemberKey: 'reviewer@example.com',
      body: 'Please confirm the analytics review date.',
      createdAt: '2026-07-15T10:00:00.000Z',
      id: 'comment-1',
      target: initiativeUpdateTarget,
      updateVersion: 2,
    }
    const reaction = {
      createdAt: '2026-07-15T10:05:00.000Z',
      emoji: '👍',
      memberKey: 'reviewer@example.com',
      target: initiativeUpdateTarget,
      updateVersion: 2,
    }
    const requests = installFetchRecorder((url, init) => {
      if (url.includes('/comments')) {
        return init.method === 'POST' ? { comment } : { comments: [comment] }
      }
      return init.method === 'PUT' ? { reaction } : { reactions: [reaction] }
    })

    await expect(listPlanningUpdateComments('access-token', {
      cursor: 'comment/cursor',
      limit: 50,
      target: initiativeUpdateTarget,
      updateVersion: 2,
    })).resolves.toEqual({ comments: [comment], nextCursor: undefined })
    await expect(createPlanningUpdateComment('access-token', {
      body: comment.body,
      id: comment.id,
      target: initiativeUpdateTarget,
      updateVersion: 2,
    }, mutationContext)).resolves.toEqual({ comment })
    await expect(listPlanningUpdateReactions('access-token', {
      limit: 100,
      target: initiativeUpdateTarget,
      updateVersion: 2,
    })).resolves.toEqual({ nextCursor: undefined, reactions: [reaction] })
    await expect(addPlanningUpdateReaction('access-token', {
      emoji: reaction.emoji,
      target: initiativeUpdateTarget,
      updateVersion: 2,
    }, mutationContext)).resolves.toEqual({ reaction })

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      [
        'GET',
        '/api/planning/updates/2/comments?targetType=initiative&entityId=initiative-onboarding&limit=50&cursor=comment%2Fcursor',
      ],
      [
        'POST',
        '/api/planning/updates/2/comments?targetType=initiative&entityId=initiative-onboarding',
      ],
      [
        'GET',
        '/api/planning/updates/2/reactions?targetType=initiative&entityId=initiative-onboarding&limit=100',
      ],
      [
        'PUT',
        '/api/planning/updates/2/reactions?targetType=initiative&entityId=initiative-onboarding',
      ],
    ])
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      body: comment.body,
      id: comment.id,
    })
    expect(JSON.parse(String(requests[3]?.init.body))).toEqual({ emoji: reaction.emoji })
    for (const request of [requests[1], requests[3]]) {
      expect(request?.init.headers).toMatchObject({
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idempotency-planning',
        'X-Correlation-Id': 'correlation-planning',
      })
    }

    const deleteRequests = installFetchRecorder(undefined, {}, 204)
    await expect(removePlanningUpdateReaction('access-token', {
      emoji: reaction.emoji,
      target: projectUpdateTarget,
      updateVersion: 2,
    }, mutationContext)).resolves.toBeUndefined()
    expect(deleteRequests[0]).toMatchObject({
      init: {
        method: 'DELETE',
      },
      url: '/api/planning/updates/2/reactions?targetType=project&teamId=core-team&projectId=refero&emoji=%F0%9F%91%8D',
    })
  })

  test('rejects malformed cadence, publish, history, and watch success responses', async () => {
    installFetchRecorder({ planning: planningSnapshotFixture })
    await expect(configurePlanningUpdateCadence('access-token', {
      cadence: null,
      expectedRevision: 12,
      target: projectUpdateTarget,
    }, mutationContext)).rejects.toMatchObject({ code: 'InvalidPlanningUpdateResponse' })

    installFetchRecorder({ planning: planningSnapshotFixture, update: { version: 1 } })
    await expect(publishPlanningUpdate('access-token', {
      decisionSummary: '',
      evidence: [],
      expectedRevision: 12,
      health: 'on-track',
      helpNeeded: '',
      id: 'update-malformed',
      nextAction: 'Continue.',
      risk: 'low',
      riskSummary: '',
      summary: 'Malformed response test.',
      target: initiativeUpdateTarget,
    }, mutationContext)).rejects.toMatchObject({ code: 'InvalidPlanningUpdateResponse' })

    installFetchRecorder({ updates: [{ version: 1 }] })
    await expect(listPlanningUpdates('access-token', {
      target: initiativeUpdateTarget,
    })).rejects.toMatchObject({ code: 'InvalidPlanningUpdateResponse' })

    installFetchRecorder({
      updates: [{
        ...planningUpdateHistoryFixture[0],
        evidence: [{ type: 'decision', decisionId: 'decision-without-permalink' }],
      }],
    })
    await expect(listPlanningUpdates('access-token', {
      target: initiativeUpdateTarget,
    })).rejects.toMatchObject({ code: 'InvalidPlanningUpdateResponse' })

    installFetchRecorder({
      watch: {
        automatic: false,
        explicit: true,
        reasons: [],
        subscribed: true,
        watcherCount: -1,
      },
    })
    await expect(getPlanningUpdateWatch(
      'access-token',
      initiativeUpdateTarget,
    )).rejects.toMatchObject({ code: 'InvalidPlanningUpdateResponse' })

    installFetchRecorder({ comments: [{ updateVersion: 2 }] })
    await expect(listPlanningUpdateComments('access-token', {
      target: initiativeUpdateTarget,
      updateVersion: 2,
    })).rejects.toMatchObject({ code: 'InvalidPlanningUpdateResponse' })

    installFetchRecorder({ reaction: { emoji: '👍' } })
    await expect(addPlanningUpdateReaction('access-token', {
      emoji: '👍',
      target: initiativeUpdateTarget,
      updateVersion: 2,
    }, mutationContext)).rejects.toMatchObject({ code: 'InvalidPlanningUpdateResponse' })
  })

  test('rejects a malformed successful dependency mutation response at the API boundary', async () => {
    installFetchRecorder({ revision: 13 })

    await expect(deleteWorkItemScheduleDependency('access-token', 'edge', {
      expectedRevision: 12,
    }, mutationContext)).rejects.toMatchObject({ code: 'InvalidPlanningSnapshot' })
  })

  test('rejects malformed nested dependency summary data at the API boundary', async () => {
    installFetchRecorder({
      ...planningSnapshotFixture,
      workItemDependencySummary: {
        ...planningSnapshotFixture.workItemDependencySummary,
        criticalPath: { workItems: [] },
      },
    })

    await expect(getPlanningSnapshot('access-token')).rejects.toMatchObject({
      code: 'InvalidPlanningSnapshot',
    })
  })

  test('preserves stable conflict codes and readable fallback messages', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 'PlanningRevisionConflict',
      message: 'Planning graph changed.',
    }), { status: 409 })) as typeof fetch

    const error = await archivePlanningEntity('token', 'goal', {
      expectedRevision: 1,
    }, mutationContext).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(PlanningApiError)
    expect(error).toMatchObject({
      code: 'PlanningRevisionConflict',
      message: 'Planning graph changed.',
      status: 409,
    })
    expect(resolvePlanningErrorMessageKey(error)).toBe('planning.conflict')
    expect(resolvePlanningErrorMessageKey(
      new PlanningApiError(403, 'raw authorization detail', 'PlanningAuthorizationChanged'),
      'mutation',
    )).toBe('planning.conflict')
    expect(resolvePlanningErrorMessageKey(
      new PlanningApiError(409, 'Entity already exists.', 'PlanningEntityExists'),
      'mutation',
    )).toBe('planning.mutationError')
    expect(resolvePlanningErrorMessageKey(new Error('raw API detail'))).toBe('planning.error')
    expect(resolvePlanningErrorMessageKey(new Error('raw API detail'), 'mutation'))
      .toBe('planning.mutationError')
  })

  test('keeps the HTTP status and fallback when an error message is malformed', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 'PlanningUnavailable',
      message: { internal: 'do not display' },
    }), { status: 503 })) as typeof fetch

    const error = await getPlanningSnapshot('token').catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(PlanningApiError)
    expect(error).toMatchObject({
      code: undefined,
      message: 'Unable to complete the planning request.',
      status: 503,
    })
  })
})

function createMutationResponse() {
  return {
    planning: planningSnapshotFixture,
    movedWorkItemIds: [],
    retainedWorkItemIds: [],
  }
}

/** Returns the newest immutable update fixture or fails with a focused message. */
function getPlanningUpdateFixture(): PlanningUpdate {
  const update = planningUpdateHistoryFixture[0]
  if (!update) throw new Error('Planning update history fixture is empty.')
  return update
}

/** Returns a fixture summary for one target discriminator. */
function getPlanningUpdateTargetSummary(
  type: PlanningUpdateTarget['type'],
): PlanningUpdateTargetSummary {
  const summary = planningSnapshotFixture.updateTargets.find(
    (candidate) => candidate.target.type === type,
  )
  if (!summary) throw new Error(`Planning ${type} update target fixture is missing.`)
  return summary
}

/** Installs a JSON fetch recorder with optional per-request response selection. */
function installFetchRecorder(
  responseBody: unknown | ((url: string, init: RequestInit) => unknown),
  responseHeaders: HeadersInit = { 'Content-Type': 'application/json' },
  responseStatus = 200,
) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init,
    })
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const resolvedBody = typeof responseBody === 'function'
      ? responseBody(url, init)
      : responseBody
    return new Response(responseStatus === 204 ? null : JSON.stringify(resolvedBody), {
      headers: responseHeaders,
      status: responseStatus,
    })
  }) as typeof fetch
  return requests
}
