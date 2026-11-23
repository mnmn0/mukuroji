import { afterEach, describe, expect, test } from 'bun:test'
import {
  createDefaultDueDateWorkItemSchedule,
  type ProjectRaidEntry,
  type ProjectRaidScheduleChange,
  type WorkItemSchedule,
  type WorkItemScheduleChangePreview,
} from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { SWRConfig, unstable_serialize, type Cache } from 'swr'
import {
  isScheduleChangeInPlace,
  ProjectChangeRequestWorkItemMovedError,
} from '../src/projects/model/projectChangeRequestDecision'
import { useDecideProjectChangeRequest } from '../src/projects/mutations/useDecideProjectChangeRequest'
import { projectRaidLogKey } from '../src/projects/queries/useProjectRaidLog'

/** One Work Item of the fake server. */
type FakeWorkItem = {
  /** Project the Work Item belongs to. */
  assignedProjectId: string
  /** Current schedule. */
  schedule: WorkItemSchedule
  /** Current revision. */
  revision: number
}

/**
 * Builds a deadline schedule.
 *
 * @param dueDate - Deadline.
 * @returns The schedule.
 */
function due(dueDate: string): WorkItemSchedule {
  return createDefaultDueDateWorkItemSchedule(dueDate)
}

/**
 * Reads the deadline of a fake Work Item.
 *
 * @param item - Work Item.
 * @returns Its deadline, or an empty string.
 */
function dueDateOf(item: FakeWorkItem | undefined) {
  return item?.schedule.mode === 'due-date' ? item.schedule.dueDate : ''
}

/**
 * Builds an open change request with the given date changes.
 *
 * @param scheduleChanges - Requested changes.
 * @returns The entry.
 */
function changeRequest(scheduleChanges: ProjectRaidScheduleChange[]): ProjectRaidEntry {
  return {
    id: 'cr-1',
    kind: 'change-request',
    title: '日程の変更',
    impact: 3,
    status: 'open',
    relatedWorkItemIds: scheduleChanges.map((change) => change.workItemId),
    scheduleChanges,
    revision: 1,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
  }
}

/** Calls seen by the fake server. */
type FakeCalls = {
  /** Confirmed schedule changes, as `id:date`. */
  confirms: string[]
  /** Captured baselines. */
  captures: number
  /** Decision requests with their Idempotency-Key. */
  decisions: Array<{ key: string; body: unknown }>
}

/**
 * Installs a fake API for the decision flow. A move of `b` conflicts while `a` still starts
 * after the target, standing in for a finish-to-start dependency a → b.
 *
 * @param items - Work Items by ID.
 * @param decisionStatuses - Status codes answered to successive decision requests.
 * @returns The calls seen.
 */
function installFakeApi(items: Record<string, FakeWorkItem>, decisionStatuses: number[]): FakeCalls {
  const calls: FakeCalls = { confirms: [], captures: 0, decisions: [] }
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const issue = /\/issues\/([^/]+)(\/schedule\/(preview|confirm))?$/.exec(url.pathname)
    if (issue) {
      const id = issue[1] ?? ''
      const item = items[id]
      if (!item) return new Response('{}', { status: 404 })
      if (issue[3] === undefined) {
        return Response.json({ issue: { id, teamId: 'core-team', ...item } })
      }
      const operation = isRecord(body) && isRecord(body.operation) ? body.operation : {}
      const target = typeof operation.targetDate === 'string' ? operation.targetDate : ''
      const blocked = id === 'b' && dueDateOf(items.a) >= target
      if (issue[3] === 'preview') {
        const preview: WorkItemScheduleChangePreview = {
          affectedMilestoneIds: [],
          affectedProjects: [{ projectId: 'refero', teamId: 'core-team' }],
          conflicts: blocked
            ? [{ code: 'dependency-violation', dependencyId: 'a-b', workItem: { teamId: 'core-team', workItemId: id } }]
            : [],
          evaluatedRevisions: [{ expectedRevision: item.revision, teamId: 'core-team', workItemId: id }],
          expectedRevision: item.revision,
          impacts: [{
            after: due(target),
            before: item.schedule,
            dateDeltaDays: 1,
            expectedRevision: item.revision,
            kind: 'direct',
            teamId: 'core-team',
            workItemId: id,
          }],
          planningRevision: 1,
          relationGraphRevision: 1,
          requiresConfirmation: true,
          warnings: [],
        }
        return Response.json(preview)
      }
      calls.confirms.push(`${id}:${target}`)
      item.schedule = due(target)
      item.revision += 1
      return Response.json({ workItems: [{
        id,
        teamId: 'core-team',
        revision: item.revision,
        schedule: item.schedule,
        dueDate: target,
        assignedProjectId: item.assignedProjectId,
      }] })
    }
    if (url.pathname.endsWith('/schedule-baseline')) {
      calls.captures += 1
      return Response.json({
        teamId: 'core-team',
        projectId: 'refero',
        baseline: null,
        activeBaselineId: `baseline-${calls.captures}`,
        savedBaselines: [],
      })
    }
    if (url.pathname.endsWith('/decision')) {
      calls.decisions.push({ key: new Headers(init?.headers).get('Idempotency-Key') ?? '', body })
      const status = decisionStatuses.shift() ?? 200
      return status === 200
        ? Response.json({
            teamId: 'core-team',
            projectId: 'refero',
            entry: {
              id: 'cr-1',
              kind: 'change-request',
              title: '日程の変更',
              impact: 3,
              status: 'closed',
              decision: { outcome: 'approved', decidedAt: '2026-11-20T00:00:00.000Z', decidedByMemberId: 'sato@example.com' },
              revision: 2,
              createdAt: '2026-11-19T00:00:00.000Z',
              updatedAt: '2026-11-20T00:00:00.000Z',
              closedAt: '2026-11-20T00:00:00.000Z',
            },
          })
        : new Response('{}', { status })
    }
    return Response.json({})
  }
  return calls
}

/**
 * Renders the hook once and returns its decision function.
 *
 * @param cache - SWR cache the hook writes to, or a fresh one.
 * @returns The decision function.
 */
function captureDecide(cache: Cache = new Map()) {
  let decide: ReturnType<typeof useDecideProjectChangeRequest> | undefined
  /**
   * Captures the decision function.
   *
   * @returns Nothing visible.
   */
  function Probe() {
    decide = useDecideProjectChangeRequest({ accessToken: 'token', teamId: 'core-team', projectId: 'refero' })
    return null
  }
  renderToStaticMarkup(<SWRConfig value={{ provider: () => cache }}><Probe /></SWRConfig>)
  if (!decide) throw new Error('Expected the decision function.')
  return decide
}

/**
 * Tells whether a value is a plain object.
 *
 * @param value - Value to check.
 * @returns Whether it is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

describe('approving a change request', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('applies dependent date changes in rounds until every requested date holds', async () => {
    const items = {
      a: { assignedProjectId: 'refero', schedule: due('2026-12-10'), revision: 1 },
      b: { assignedProjectId: 'refero', schedule: due('2026-12-11'), revision: 1 },
    }
    const calls = installFakeApi(items, [])
    const entry = changeRequest([
      { workItemId: 'b', operation: { type: 'move', targetDate: '2026-12-05' } },
      { workItemId: 'a', operation: { type: 'move', targetDate: '2026-11-25' } },
    ])

    await captureDecide()(entry, 'approved', { replaceBaseline: false, baselineName: '' })

    expect(calls.confirms).toEqual(['a:2026-11-25', 'b:2026-12-05'])
    expect(calls.decisions).toHaveLength(1)
  })

  test('refuses to change the dates of a Work Item that moved to another Project', async () => {
    const calls = installFakeApi({
      a: { assignedProjectId: 'other', schedule: due('2026-12-10'), revision: 1 },
    }, [])
    const entry = changeRequest([{ workItemId: 'a', operation: { type: 'move', targetDate: '2026-11-25' } }])

    await expect(captureDecide()(entry, 'approved', { replaceBaseline: true, baselineName: 'x' }))
      .rejects.toBeInstanceOf(ProjectChangeRequestWorkItemMovedError)
    expect(calls.confirms).toEqual([])
    expect(calls.captures).toBe(0)
    expect(calls.decisions).toEqual([])
  })

  test('sends a decision with an unknown outcome again before capturing another baseline', async () => {
    const calls = installFakeApi({
      a: { assignedProjectId: 'refero', schedule: due('2026-12-10'), revision: 1 },
    }, [503, 200])
    const entry = changeRequest([{ workItemId: 'a', operation: { type: 'move', targetDate: '2026-11-25' } }])
    const decide = captureDecide()

    await expect(decide(entry, 'approved', { replaceBaseline: true, baselineName: '変更要求' })).rejects.toThrow()
    await decide(entry, 'approved', { replaceBaseline: true, baselineName: '変更要求' })

    expect(calls.captures).toBe(1)
    expect(calls.decisions).toHaveLength(2)
    expect(calls.decisions[1]).toEqual(calls.decisions[0])
    expect(calls.decisions[0]?.body).toMatchObject({ baselineId: 'baseline-1' })
  })

  test('keeps the unknown outcome of one request while another request is decided', async () => {
    const calls = installFakeApi({}, [503, 200, 200])
    const first = changeRequest([])
    const second: ProjectRaidEntry = { ...changeRequest([]), id: 'cr-2' }
    const decide = captureDecide()

    await expect(decide(first, 'rejected', { replaceBaseline: false, baselineName: '' })).rejects.toThrow()
    await decide(second, 'rejected', { replaceBaseline: false, baselineName: '' })
    await decide(first, 'rejected', { replaceBaseline: false, baselineName: '' })

    expect(calls.decisions).toHaveLength(3)
    expect(calls.decisions[1]?.key).not.toBe(calls.decisions[0]?.key)
    expect(calls.decisions[2]?.key).toBe(calls.decisions[0]?.key)
  })

  test('shows the closed request even when the log cannot be reloaded', async () => {
    installFakeApi({}, [])
    const entry = changeRequest([])
    const cache: Cache = new Map()
    const logKey = unstable_serialize(projectRaidLogKey('token', 'core-team', 'refero'))
    cache.set(logKey, { data: { teamId: 'core-team', projectId: 'refero', entries: [entry], viewer: { canEdit: true } } })

    await captureDecide(cache)(entry, 'rejected', { replaceBaseline: false, baselineName: '' })

    const cached: unknown = cache.get(logKey)?.data
    const entries = isRecord(cached) && Array.isArray(cached.entries) ? cached.entries : []
    expect(entries).toMatchObject([{ id: 'cr-1', status: 'closed', revision: 2 }])
  })
})

describe('isScheduleChangeInPlace', () => {
  test('matches a move by the start or deadline and a resize by the range end', () => {
    expect(isScheduleChangeInPlace(due('2026-12-01'), { type: 'move', targetDate: '2026-12-01' })).toBe(true)
    expect(isScheduleChangeInPlace(due('2026-12-01'), { type: 'move', targetDate: '2026-12-02' })).toBe(false)
    expect(isScheduleChangeInPlace(due('2026-12-01'), { type: 'resize', endDate: '2026-12-01' })).toBe(false)
  })
})
