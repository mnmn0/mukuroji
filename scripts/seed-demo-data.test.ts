import { describe, expect, test } from 'bun:test'
import {
  DemoDataApiError,
  DemoDataUsageError,
  buildDemoDataPlan,
  countWorkingDays,
  mondayOfWeek,
  readLocalApiOrigin,
  seedDemoData,
  todayInWorkspaceTimeZone,
  type DemoDataTransport,
} from './seed-demo-data'

/** One request the fake server received. */
type RecordedCall = {
  /** HTTP method. */
  method: string
  /** Request path. */
  path: string
}

/** Planning state the fake server keeps. */
type FakePlanning = {
  /** Planning graph revision. */
  revision: number
  /** Created entities with their current status. */
  entities: { id: string, status: string }[]
  /** Entities a person archived; the live graph leaves them out. */
  archived: { id: string }[]
  /** Created entity dependencies. */
  dependencies: { id: string }[]
  /** Created Work Item dependencies. */
  workItemDependencies: { id: string }[]
  /** Work Item links, with the Cycle when one was added. */
  workItemLinks: { teamId: string, workItemId: string, cycleId?: string }[]
}

/**
 * Tells whether a value is a plain object.
 *
 * @param value - Value to check.
 * @returns True for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads a string field of a request body.
 *
 * @param body - Request body.
 * @param field - Field name.
 * @returns The string value, or an empty string.
 */
function field(body: unknown, field: string): string {
  const value = isRecord(body) ? body[field] : undefined
  return typeof value === 'string' ? value : ''
}

/**
 * Creates an in-memory server that answers the API calls the seed makes.
 *
 * @param options - Whether the ready-hook Teams exist.
 * @returns The transport and the calls it received.
 */
function createFakeServer(options: { readyHookSeeded: boolean }) {
  const calls: RecordedCall[] = []
  const teams: { id: string, name: string, projects: { id: string, name: string }[] }[] = options.readyHookSeeded
    ? [
        { id: 'core-team', name: 'コアチーム', projects: [{ id: 'product-roadmap', name: 'プロダクトロードマップ' }] },
        { id: 'design-team', name: 'デザインチーム', projects: [{ id: 'brand-refresh', name: 'ブランド刷新' }] },
      ]
    : []
  const issues = new Map<string, { id: string, title: string, assignedProjectId: string, parent: string | null }[]>()
  const planning: FakePlanning = {
    revision: 0,
    entities: [],
    archived: [],
    dependencies: [],
    workItemDependencies: [],
    workItemLinks: [],
  }
  let graphRevision = 0

  /** Returns a copy of the planning snapshot. */
  const snapshot = () => ({ status: 200, body: structuredClone(planning) })

  const transport: DemoDataTransport = async (method, path, body) => {
    calls.push({ method, path })
    const url = new URL(`http://fake${path}`)
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (method === 'GET' && url.pathname === '/api/teams/projects') return { status: 200, body: { teams: structuredClone(teams) } }
    if (method === 'POST' && url.pathname === '/api/teams') {
      const team = { id: field(body, 'nameEn').toLowerCase().replaceAll(' ', '-'), name: field(body, 'nameJa'), projects: [] }
      teams.push(team)
      return { status: 201, body: { team } }
    }
    if (method === 'POST' && parts[1] === 'teams' && parts[3] === 'projects') {
      const project = { id: field(body, 'nameEn').toLowerCase().replaceAll(' ', '-'), name: field(body, 'nameJa') }
      teams.find((team) => team.id === parts[2])?.projects.push(project)
      return { status: 201, body: { project } }
    }
    if (parts[1] === 'teams' && parts[3] === 'issues' && parts.length === 4) {
      const list = issues.get(parts[2]) ?? []
      issues.set(parts[2], list)
      if (method === 'GET') return { status: 200, body: { issues: list.map(({ id, title, assignedProjectId }) => ({ id, title, assignedProjectId })) } }
      const issue = { id: `${parts[2]}-${list.length + 1}`, title: field(body, 'title'), assignedProjectId: field(body, 'assignedProjectId'), parent: null }
      list.push(issue)
      return { status: 201, body: { issue } }
    }
    if (method === 'GET' && parts[3] === 'work-item-hierarchy') {
      const nodes = (issues.get(parts[2]) ?? []).map((issue) => ({ workItemId: issue.id, parentWorkItemId: issue.parent }))
      return { status: 200, body: { graphRevision, nodes } }
    }
    if (method === 'PUT' && parts[5] === 'parent') {
      const issue = issues.get(parts[2])?.find((candidate) => candidate.id === parts[4])
      if (issue) issue.parent = field(body, 'parentWorkItemId')
      graphRevision += 1
      return { status: 200, body: {} }
    }
    if (method === 'GET' && url.pathname === '/api/planning') return snapshot()
    if (method === 'GET' && url.pathname === '/api/planning/archived-entities') {
      return { status: 200, body: { entities: structuredClone(planning.archived) } }
    }
    planning.revision += 1
    if (url.pathname === '/api/planning/entities') {
      planning.entities.push({ id: field(body, 'id'), status: field(body, 'status') })
      return { ...snapshot(), status: 201 }
    }
    if (method === 'PATCH' && parts[2] === 'entities') {
      const entity = planning.entities.find((candidate) => candidate.id === parts[3])
      const patch = isRecord(body) ? body.patch : undefined
      if (entity) entity.status = field(patch, 'status')
      return snapshot()
    }
    if (url.pathname === '/api/planning/dependencies') {
      planning.dependencies.push({ id: field(body, 'id') })
      return { ...snapshot(), status: 201 }
    }
    if (url.pathname === '/api/planning/work-item-dependencies') {
      planning.workItemDependencies.push({ id: field(body, 'id') })
      return { ...snapshot(), status: 201 }
    }
    if (parts[2] === 'work-item-links') {
      planning.workItemLinks.push({ teamId: parts[3], workItemId: parts[4] })
      return snapshot()
    }
    if (parts[2] === 'cycles' && parts[4] === 'work-items') {
      const items = isRecord(body) && Array.isArray(body.workItems) ? body.workItems : []
      for (const item of items) {
        const teamId = field(item, 'teamId')
        const workItemId = field(item, 'workItemId')
        const link = planning.workItemLinks.find((candidate) => candidate.teamId === teamId && candidate.workItemId === workItemId)
        if (link) link.cycleId = parts[3]
        else planning.workItemLinks.push({ teamId, workItemId, cycleId: parts[3] })
      }
      return snapshot()
    }
    return { status: 404, body: { message: `unexpected ${method} ${path}` } }
  }

  return { transport, calls, planning, issues }
}

describe('buildDemoDataPlan', () => {
  const plan = buildDemoDataPlan('2026-11-25')

  test('uses unique keys and resolves every reference', () => {
    const workItemKeys = plan.workItems.map((workItem) => workItem.key)
    const entityIds = plan.planningEntities.map((entity) => entity.id)
    const projectKeys = new Set(plan.projects.map((project) => project.key))
    expect(new Set(workItemKeys).size).toBe(workItemKeys.length)
    expect(new Set(entityIds).size).toBe(entityIds.length)
    for (const workItem of plan.workItems) {
      expect(projectKeys.has(workItem.projectKey)).toBe(true)
      if (workItem.parentKey) {
        const parentIndex = workItemKeys.indexOf(workItem.parentKey)
        expect(parentIndex).toBeGreaterThanOrEqual(0)
        expect(parentIndex).toBeLessThan(workItemKeys.indexOf(workItem.key))
        expect(plan.workItems[parentIndex]?.projectKey).toBe(workItem.projectKey)
      }
      for (const entityKey of [workItem.cycleKey, workItem.milestoneKey, ...workItem.goalKeys]) {
        if (entityKey !== undefined) expect(entityIds).toContain(entityKey)
      }
    }
    for (const entity of plan.planningEntities) {
      if (entity.parentId) expect(entityIds.indexOf(entity.parentId)).toBeLessThan(entityIds.indexOf(entity.id))
    }
  })

  test('creates date ranges on weekdays with the matching duration', () => {
    for (const workItem of plan.workItems) {
      const schedule = workItem.schedule
      if (schedule.mode !== 'date-range') continue
      expect(schedule.startDate <= schedule.endDate).toBe(true)
      expect(schedule.durationDays).toBe(countWorkingDays(schedule.startDate, schedule.endDate))
      expect(new Date(`${schedule.startDate}T00:00:00Z`).getUTCDay()).toBe(1)
    }
  })

  test('schedules every Cycle member inside its Cycle', () => {
    for (const workItem of plan.workItems) {
      if (!workItem.cycleKey || workItem.schedule.mode !== 'date-range') continue
      const cycle = plan.planningEntities.find((entity) => entity.id === workItem.cycleKey)
      expect(cycle).toBeDefined()
      expect(workItem.schedule.startDate >= (cycle?.baseline.startDate ?? '')).toBe(true)
      expect(workItem.schedule.endDate <= (cycle?.baseline.endDate ?? '')).toBe(true)
    }
  })

  test('lays the three Cycles back to back around the base week', () => {
    const cycles = plan.planningEntities.filter((entity) => entity.type === 'cycle')
    expect(cycles.map((cycle) => cycle.status)).toEqual(['completed', 'active', 'planned'])
    expect(cycles[1]?.baseline).toEqual({ startDate: '2026-11-16', endDate: '2026-11-29' })
    for (let index = 1; index < cycles.length; index += 1) {
      const previousEnd = new Date(`${cycles[index - 1]?.baseline.endDate}T00:00:00Z`)
      previousEnd.setUTCDate(previousEnd.getUTCDate() + 1)
      expect(cycles[index]?.baseline.startDate).toBe(previousEnd.toISOString().slice(0, 10))
    }
  })
})

describe('date helpers', () => {
  test('finds the Monday of a week and counts weekdays', () => {
    expect(mondayOfWeek('2026-11-22')).toBe('2026-11-16')
    expect(mondayOfWeek('2026-11-23')).toBe('2026-11-23')
    expect(countWorkingDays('2026-11-16', '2026-11-29')).toBe(10)
  })

  test('reads today in Asia/Tokyo', () => {
    expect(todayInWorkspaceTimeZone(new Date('2026-11-22T16:00:00.000Z'))).toBe('2026-11-23')
  })
})

describe('readLocalApiOrigin', () => {
  test('defaults to the local server and accepts local hosts', () => {
    expect(readLocalApiOrigin(undefined)).toBe('http://localhost:3000')
    expect(readLocalApiOrigin('http://127.0.0.1:5173/')).toBe('http://127.0.0.1:5173')
    expect(readLocalApiOrigin('http://[::1]:3000')).toBe('http://[::1]:3000')
  })

  test('rejects remote, https, credentialed and path URLs', () => {
    for (const value of [
      'https://localhost:3000',
      'http://example.com',
      'http://localhost.example.com',
      'http://user:pass@localhost:3000',
      'http://localhost:3000/api',
      'not a url',
    ]) {
      expect(() => readLocalApiOrigin(value)).toThrow(DemoDataUsageError)
    }
  })
})

describe('seedDemoData', () => {
  test('creates everything once and nothing on a rerun', async () => {
    const plan = buildDemoDataPlan('2026-11-25')
    const server = createFakeServer({ readyHookSeeded: true })
    const first = await seedDemoData(plan, server.transport, () => {})
    expect(first.created).toBeGreaterThan(plan.workItems.length)
    expect(server.planning.entities.find((entity) => entity.id === 'demo-cycle-previous')?.status).toBe('completed')
    expect(server.planning.workItemLinks.filter((link) => link.cycleId !== undefined)).toHaveLength(
      plan.workItems.filter((workItem) => workItem.cycleKey !== undefined).length,
    )

    const firstCallCount = server.calls.length
    const second = await seedDemoData(plan, server.transport, () => {})
    expect(second.created).toBe(0)
    expect(second.kept).toBe(first.created + first.kept)
    expect(server.calls.slice(firstCallCount).every((call) => call.method === 'GET')).toBe(true)
  })

  test('does not put back a parent or Cycle that a person removed', async () => {
    const plan = buildDemoDataPlan('2026-11-25')
    const server = createFakeServer({ readyHookSeeded: true })
    await seedDemoData(plan, server.transport, () => {})
    const linked = server.planning.workItemLinks.find((link) => link.cycleId !== undefined)
    expect(linked).toBeDefined()
    if (linked) delete linked.cycleId
    const firstCallCount = server.calls.length
    server.issues.get('platform-team')?.forEach((issue) => {
      issue.parent = null
    })

    const rerun = await seedDemoData(plan, server.transport, () => {})
    expect(rerun.created).toBe(0)
    expect(server.calls.slice(firstCallCount).every((call) => call.method === 'GET')).toBe(true)
  })

  test('keeps archived entities archived and does not put back a removed Planning dependency', async () => {
    const plan = buildDemoDataPlan('2026-11-25')
    const server = createFakeServer({ readyHookSeeded: true })
    await seedDemoData(plan, server.transport, () => {})
    server.planning.entities = server.planning.entities.filter((entity) => entity.id !== 'demo-cycle-previous')
    server.planning.archived.push({ id: 'demo-cycle-previous' })
    server.planning.dependencies = []
    const firstCallCount = server.calls.length

    const rerun = await seedDemoData(plan, server.transport, () => {})
    expect(rerun.created).toBe(0)
    expect(server.calls.slice(firstCallCount).every((call) => call.method === 'GET')).toBe(true)
  })

  test('creates the Cycles open and closes only the completed one', async () => {
    const plan = buildDemoDataPlan('2026-11-25')
    const server = createFakeServer({ readyHookSeeded: true })
    const created: string[] = []
    const original = server.transport
    const transport: DemoDataTransport = async (method, path, body) => {
      if (path === '/api/planning/entities') created.push(`${field(body, 'id')}:${field(body, 'status')}`)
      return original(method, path, body)
    }
    await seedDemoData(plan, transport, () => {})
    expect(created).toContain('demo-cycle-previous:active')
    expect(server.calls.filter((call) => call.method === 'PATCH')).toEqual([
      { method: 'PATCH', path: '/api/planning/entities/demo-cycle-previous' },
    ])
  })

  test('stops before writing when the ready hook has not seeded the Workspace', async () => {
    const server = createFakeServer({ readyHookSeeded: false })
    await expect(seedDemoData(buildDemoDataPlan('2026-11-25'), server.transport, () => {})).rejects.toThrow(DemoDataApiError)
    expect(server.calls.filter((call) => call.method !== 'GET')).toEqual([])
  })
})
