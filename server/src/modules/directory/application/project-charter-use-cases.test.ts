import { describe, expect, test } from 'bun:test'
import type { ProjectCharterState } from '@mukuroji/contracts'
import {
  transitionProjectLifecycleUseCase,
  updateProjectCharterUseCase,
  type ProjectCharterStore,
} from './project-charter-use-cases'

const scope = { workspaceId: 'workspace-1', teamId: 'core-team', projectId: 'refero' }

/** Creates an in-memory store that records every write. */
function createFakeStore(initial: Partial<ProjectCharterState> = {}) {
  let state: ProjectCharterState = {
    teamId: scope.teamId,
    projectId: scope.projectId,
    lifecycleState: 'active',
    charter: { tags: [], repositoryUrls: [] },
    revision: 0,
    ...initial,
  }
  const writes: Array<{ kind: string; fences?: string[]; audit: unknown }> = []
  const store: ProjectCharterStore<string, unknown> = {
    async getProjectCharter() {
      return state
    },
    async updateProjectCharter(_workspaceId, _teamId, _projectId, expectedRevision, charter, audit, fences) {
      expect(expectedRevision).toBe(state.revision)
      writes.push({ kind: 'charter', fences, audit })
      state = { ...state, charter, revision: state.revision + 1 }
      return state
    },
    async transitionProjectLifecycle(_workspaceId, _teamId, _projectId, expectedRevision, lifecycleState, audit) {
      expect(expectedRevision).toBe(state.revision)
      writes.push({ kind: 'lifecycle', audit })
      state = { ...state, lifecycleState, revision: state.revision + 1 }
      return state
    },
  }
  return { store, writes }
}

describe('updateProjectCharterUseCase', () => {
  test('resolves people, sends one fence per member, and projects search after the commit', async () => {
    const { store, writes } = createFakeStore()
    const projected: ProjectCharterState[] = []
    const state = await updateProjectCharterUseCase(
      {
        store,
        async resolvePerson(_workspaceId, userId) {
          return { person: { userId, displayName: userId.split('@')[0] ?? userId }, fence: `fence:${userId}` }
        },
        async projectSearchDocument(_workspaceId, committed) {
          projected.push(committed)
        },
      },
      scope,
      {
        expectedRevision: 0,
        charter: { code: 'ops', ownerUserId: 'pm@example.com', sponsorUserId: 'pm@example.com' },
      },
      (update) => ({ audited: update.code }),
    )

    expect(state.charter).toMatchObject({
      code: 'OPS',
      owner: { userId: 'pm@example.com', displayName: 'pm' },
      sponsor: { userId: 'pm@example.com', displayName: 'pm' },
    })
    expect(writes).toEqual([{ kind: 'charter', fences: ['fence:pm@example.com'], audit: { audited: 'OPS' } }])
    expect(projected).toEqual([state])
  })

  test('rejects an invalid body before resolving anyone', async () => {
    const { store, writes } = createFakeStore()
    await expect(updateProjectCharterUseCase(
      {
        store,
        resolvePerson: () => Promise.reject(new Error('must not resolve')),
        projectSearchDocument: async () => undefined,
      },
      scope,
      { expectedRevision: 0, charter: { tags: ['研究、開発'] } },
      () => undefined,
    )).rejects.toMatchObject({ status: 400, code: 'InvalidProjectCharter' })
    expect(writes).toEqual([])
  })
})

describe('transitionProjectLifecycleUseCase', () => {
  test('asks for the proposal-decision permission only when deciding on a proposed Project', async () => {
    const proposed = createFakeStore({ lifecycleState: 'proposed' })
    let decisionChecks = 0
    const ports = {
      store: proposed.store,
      requireProposalDecision: () => {
        decisionChecks += 1
      },
    }
    const approved = await transitionProjectLifecycleUseCase(
      ports,
      scope,
      { expectedRevision: 0, state: 'approved' },
      () => undefined,
    )
    expect(approved.lifecycleState).toBe('approved')
    await transitionProjectLifecycleUseCase(ports, scope, { expectedRevision: 1, state: 'active' }, () => undefined)
    expect(decisionChecks).toBe(1)
  })

  test('rejects a disallowed transition and a stale revision without writing', async () => {
    const { store, writes } = createFakeStore({ lifecycleState: 'closed', revision: 2 })
    const ports = { store, requireProposalDecision: () => undefined }
    await expect(transitionProjectLifecycleUseCase(
      ports,
      scope,
      { expectedRevision: 2, state: 'proposed' },
      () => undefined,
    )).rejects.toMatchObject({ status: 409, code: 'ProjectLifecycleTransitionNotAllowed' })
    await expect(transitionProjectLifecycleUseCase(
      ports,
      scope,
      { expectedRevision: 1, state: 'active' },
      () => undefined,
    )).rejects.toMatchObject({ status: 409, code: 'ProjectCharterRevisionConflict' })
    expect(writes).toEqual([])
  })

  test('propagates a denied proposal decision', async () => {
    const { store, writes } = createFakeStore({ lifecycleState: 'proposed' })
    await expect(transitionProjectLifecycleUseCase(
      {
        store,
        requireProposalDecision: () => {
          throw new Error('denied')
        },
      },
      scope,
      { expectedRevision: 0, state: 'approved' },
      () => undefined,
    )).rejects.toThrow('denied')
    expect(writes).toEqual([])
  })
})
