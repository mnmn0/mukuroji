import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DEFAULT_WORK_ITEM_TYPE,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  type CreateWorkItemInput,
  type CreateWorkItemScheduleDependencyInput,
  type PlanningSnapshot,
  type WorkItemConfiguration,
  type WorkItemParentMutationInput,
} from '@mukuroji/contracts'
import { TeamIssuesApiError } from '../src/issues/api/errors'
import { teamIssueFixtures } from '../src/issues/fixtures'
import { aiPlanningGenerationFixture } from '../src/features/ai-assistance/fixtures'
import {
  adoptAiPlanningStructure,
  AiPlanningStructureAdoptionError,
  createAiPlanningStructureAdoptionSession,
  resolveAllowedChildWorkItemTypes,
  type AiPlanningStructureApi,
  type AiPlanningStructureParent,
} from '../src/features/ai-assistance/mutations/useAiPlanningStructureAdoption'
import { AiWorkItemPlanningAssistantView } from '../src/features/ai-assistance/ui/AiWorkItemPlanningAssistant'
import { isWorkspaceOrProjectWorkItemListKey } from '../src/issues/queries/useWorkItems'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import { createTranslator } from '../src/shared/i18n/i18n'

const t = createTranslator('en')

/** Team configuration whose stories may hold tasks but not other stories. */
const configuration: WorkItemConfiguration = {
  customFields: [],
  revision: 1,
  schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  scopeId: 'team-1',
  scopeType: 'team',
  workflow: {
    id: 'delivery',
    initialStatusId: 'backlog',
    name: 'Delivery',
    statuses: [
      { category: 'backlog', id: 'backlog', name: 'Backlog', sortOrder: 0 },
      { category: 'started', id: 'active', name: 'Active', sortOrder: 1 },
    ],
    transitions: [],
  },
  workItemTypes: [
    { ...DEFAULT_WORK_ITEM_TYPE, allowedChildTypeIds: ['task'], defaultWorkflowId: 'delivery', id: 'story', name: 'Story' },
    { ...DEFAULT_WORK_ITEM_TYPE, allowedChildTypeIds: [], defaultWorkflowId: 'delivery', id: 'task', name: 'Task', sortOrder: 1 },
    { ...DEFAULT_WORK_ITEM_TYPE, allowedChildTypeIds: [], defaultWorkflowId: 'delivery', id: 'old', name: 'Old', sortOrder: 2, status: 'archived' },
  ],
}

const parent: AiPlanningStructureParent = {
  assigneeUserId: 'member-1',
  teamId: 'team-1',
  workItemId: 'story-1',
  workItemTypeId: 'story',
}

/** Records the calls of a fake API backed by in-memory Work Items and dependencies. */
function createFakeApi(
  options: { failParentOnce?: boolean; loseCreateResponseOnce?: boolean; rejectCreateOnce?: boolean } = {},
) {
  const created: { idempotencyKey: string; input: CreateWorkItemInput }[] = []
  const parents = new Map<string, string>()
  const parentCalls: WorkItemParentMutationInput[] = []
  const dependencies: CreateWorkItemScheduleDependencyInput[] = []
  const issuesByKey = new Map<string, string>()
  let graphRevision = 5
  let planningRevision = 9
  let failParent = options.failParentOnce ?? false
  let loseCreateResponse = options.loseCreateResponseOnce ?? false
  let rejectCreate = options.rejectCreateOnce ?? false

  const snapshot = (): PlanningSnapshot => ({
    ...planningSnapshotFixture,
    revision: planningRevision,
    workItemDependencies: dependencies.map((dependency) => ({
      createdAt: '2026-11-25T00:00:00.000Z',
      createdBy: 'member-1',
      id: dependency.id,
      lagDays: dependency.lagDays,
      predecessor: dependency.predecessor,
      successor: dependency.successor,
      type: dependency.type,
      updatedAt: '2026-11-25T00:00:00.000Z',
      updatedBy: 'member-1',
    })),
  })

  const api: AiPlanningStructureApi = {
    async createTeamIssue(_teamId, _token, input, context) {
      if (rejectCreate) {
        // The server refused the input and made nothing.
        rejectCreate = false
        throw new TeamIssuesApiError(400, 'invalid input')
      }
      // The server returns the first result for a repeated idempotency key.
      const existing = issuesByKey.get(context.idempotencyKey)
      const id = existing ?? `child-${issuesByKey.size + 1}`
      if (!existing) {
        issuesByKey.set(context.idempotencyKey, id)
        created.push({ idempotencyKey: context.idempotencyKey, input })
      }
      if (loseCreateResponse) {
        // The server made the child, but its response never reached the client.
        loseCreateResponse = false
        throw new Error('network')
      }
      return { ...teamIssueFixtures[0], id, teamId: 'team-1' }
    },
    async createWorkItemScheduleDependency(_token, input) {
      if (input.expectedRevision !== planningRevision) throw new Error('stale planning revision')
      dependencies.push(input)
      planningRevision += 1
      return snapshot()
    },
    async getPlanningSnapshot() {
      return snapshot()
    },
    async getTeamIssueDetail(_teamId, issueId) {
      const parentId = parents.get(issueId)
      return {
        activity: [],
        issue: { ...teamIssueFixtures[0], id: issueId, teamId: 'team-1' },
        relationGraphRevision: graphRevision,
        relations: parentId === undefined
          ? []
          : [{ sourceWorkItemId: issueId, targetWorkItemId: parentId, type: 'parent' as const }],
      }
    },
    async getWorkItemConfiguration() {
      return { configuration }
    },
    async replaceWorkItemParent(_teamId, workItemId, _token, input) {
      parentCalls.push(input)
      if (failParent) {
        failParent = false
        throw new Error('network')
      }
      if (input.expectedGraphRevision !== graphRevision) throw new Error('stale graph revision')
      parents.set(workItemId, input.parentWorkItemId ?? '')
      graphRevision += 1
      return { graphRevision, parentWorkItemId: input.parentWorkItemId, previousParentWorkItemId: null }
    },
  }
  return { api, created, dependencies, parentCalls, parents }
}

const input = {
  childWorkItemTypeId: 'task',
  children: [
    { plannedEffortMinutes: 90, priority: 'high' as const, rowId: 'row-1', title: 'Write the plan' },
    { priority: 'low' as const, rowId: 'row-2', title: 'Review the plan' },
  ],
  dependencies: [{
    lagDays: 0,
    predecessor: { teamId: 'team-1', workItemId: 'story-1' },
    rowId: 'dependency-1',
    successor: { teamId: 'team-1', workItemId: 'story-2' },
    type: 'finish-to-start' as const,
  }],
  generationId: 'generation-1',
}

describe('AI planning structure adoption', () => {
  test('lists only the active types the parent type allows as children', () => {
    expect(resolveAllowedChildWorkItemTypes(configuration.workItemTypes ?? [], 'story').map((type) => type.id))
      .toEqual(['task'])
    expect(resolveAllowedChildWorkItemTypes(configuration.workItemTypes ?? [], 'task')).toEqual([])
    expect(resolveAllowedChildWorkItemTypes(configuration.workItemTypes ?? [], 'missing')).toEqual([])
  })

  test('creates the children under the parent with their effort and adds the dependency', async () => {
    const fake = createFakeApi()
    const session = createAiPlanningStructureAdoptionSession(fake.api)
    const result = await adoptAiPlanningStructure(session, 'token', parent, input)

    expect(result).toEqual({
      childWorkItemIds: { 'row-1': 'child-1', 'row-2': 'child-2' },
      dependencyRowIds: ['dependency-1'],
    })
    expect(fake.created.map((entry) => entry.input)).toEqual([
      expect.objectContaining({
        assigneeUserId: 'member-1',
        priority: 'high',
        quickCapture: true,
        schedule: expect.objectContaining({ mode: 'unscheduled', plannedEffortMinutes: 90 }),
        title: 'Write the plan',
        workflowStatusId: 'backlog',
        workItemTypeId: 'task',
      }),
      expect.objectContaining({ title: 'Review the plan', workItemTypeId: 'task' }),
    ])
    expect(fake.parents.get('child-1')).toBe('story-1')
    expect(fake.parents.get('child-2')).toBe('story-1')
    // Each parent link sends the graph revision the previous link returned.
    expect(fake.parentCalls.map((call) => call.expectedGraphRevision)).toEqual([5, 6])
    expect(fake.dependencies).toEqual([expect.objectContaining({ expectedRevision: 9, type: 'finish-to-start' })])
  })

  test('sending the same selection again creates nothing new', async () => {
    const fake = createFakeApi()
    const session = createAiPlanningStructureAdoptionSession(fake.api)
    await adoptAiPlanningStructure(session, 'token', parent, input)
    const again = await adoptAiPlanningStructure(session, 'token', parent, input)

    expect(again.childWorkItemIds).toEqual({ 'row-1': 'child-1', 'row-2': 'child-2' })
    expect(fake.created).toHaveLength(2)
    expect(fake.parentCalls).toHaveLength(2)
    expect(fake.dependencies).toHaveLength(1)
  })

  test('a retry after a failed parent link links the existing children without creating them again', async () => {
    const fake = createFakeApi({ failParentOnce: true })
    const session = createAiPlanningStructureAdoptionSession(fake.api)
    expect(session.writtenGenerations.has(input.generationId)).toBe(false)
    await expect(adoptAiPlanningStructure(session, 'token', parent, input)).rejects.toThrow('network')
    expect(fake.created).toHaveLength(2)
    // The session's own writes moved the revisions the approval checks, so it resumes without one.
    expect(session.writtenGenerations.has(input.generationId)).toBe(true)

    // The reviewer edits a title before retrying; the child already created is reused.
    const edited = { ...input, children: [{ ...input.children[0], title: 'Edited' }, input.children[1]] }
    const result = await adoptAiPlanningStructure(session, 'token', parent, edited)

    expect(result.childWorkItemIds).toEqual({ 'row-1': 'child-1', 'row-2': 'child-2' })
    expect(fake.created).toHaveLength(2)
    expect(fake.parents.get('child-1')).toBe('story-1')
    expect(fake.parents.get('child-2')).toBe('story-1')
  })

  test('a retry after deselecting a created row still links that child to the parent', async () => {
    const fake = createFakeApi()
    const createTeamIssue = fake.api.createTeamIssue
    let createCalls = 0
    fake.api.createTeamIssue = async (...args) => {
      createCalls += 1
      if (createCalls === 2) throw new Error('network')
      return createTeamIssue(...args)
    }
    const session = createAiPlanningStructureAdoptionSession(fake.api)
    await expect(adoptAiPlanningStructure(session, 'token', parent, input)).rejects.toThrow('network')
    expect(fake.parents.get('child-1')).toBeUndefined()

    // The reviewer deselects the first row, which was already created, before retrying.
    const result = await adoptAiPlanningStructure(session, 'token', parent, { ...input, children: [input.children[1]] })

    expect(result.childWorkItemIds).toEqual({ 'row-1': 'child-1', 'row-2': 'child-2' })
    expect(fake.parents.get('child-1')).toBe('story-1')
    expect(fake.parents.get('child-2')).toBe('story-1')
  })

  test('a retry after a lost create response reuses the first request even when the row was edited', async () => {
    const fake = createFakeApi({ loseCreateResponseOnce: true })
    const session = createAiPlanningStructureAdoptionSession(fake.api)
    await expect(adoptAiPlanningStructure(session, 'token', parent, input)).rejects.toThrow('network')
    expect(fake.created).toHaveLength(1)

    const edited = { ...input, children: [{ ...input.children[0], title: 'Edited' }, input.children[1]] }
    const result = await adoptAiPlanningStructure(session, 'token', parent, edited)

    expect(result.childWorkItemIds).toEqual({ 'row-1': 'child-1', 'row-2': 'child-2' })
    expect(fake.created.map((entry) => entry.input.title)).toEqual(['Write the plan', 'Review the plan'])
  })

  test('a retry after a refused create sends the edited row', async () => {
    const fake = createFakeApi({ rejectCreateOnce: true })
    const session = createAiPlanningStructureAdoptionSession(fake.api)
    await expect(adoptAiPlanningStructure(session, 'token', parent, input)).rejects.toThrow('invalid input')
    expect(fake.created).toHaveLength(0)

    const edited = { ...input, children: [{ ...input.children[0], title: 'Edited' }, input.children[1]] }
    await adoptAiPlanningStructure(session, 'token', parent, edited)

    expect(fake.created.map((entry) => entry.input.title)).toEqual(['Edited', 'Review the plan'])
  })

  test('refreshes Workspace lists and the lists of the parent Project only', () => {
    expect(isWorkspaceOrProjectWorkItemListKey(['workspace-work-items', 'token', false, ''], 'project-1')).toBe(true)
    expect(isWorkspaceOrProjectWorkItemListKey(['project-issues', 'token', 'project-1', false, null, null], 'project-1'))
      .toBe(true)
    expect(isWorkspaceOrProjectWorkItemListKey(['project-issues', 'token', 'project-2', false, null, null], 'project-1'))
      .toBe(false)
    expect(isWorkspaceOrProjectWorkItemListKey(['project-issues', 'token', 'project-1', false, null, null])).toBe(false)
  })

  test('refuses a child type the parent does not allow before creating anything', async () => {
    const fake = createFakeApi()
    const session = createAiPlanningStructureAdoptionSession(fake.api)
    const refused = adoptAiPlanningStructure(session, 'token', parent, { ...input, childWorkItemTypeId: 'story' })

    await expect(refused).rejects.toBeInstanceOf(AiPlanningStructureAdoptionError)
    await expect(refused).rejects.toMatchObject({ reason: 'child-type-denied' })
    expect(fake.created).toHaveLength(0)
    expect(fake.dependencies).toHaveLength(0)
  })
})

describe('AI planning structure adoption section', () => {
  beforeEach(() => {
    setSystemTime(new Date('2026-08-26T00:00:00.000Z'))
  })

  afterEach(() => {
    setSystemTime()
  })

  test('offers the proposed children and dependencies when the route can create them', () => {
    const html = renderToStaticMarkup(
      <AiWorkItemPlanningAssistantView
        generation={aiPlanningGenerationFixture}
        locale="en"
        onDecide={async () => undefined}
        onGenerate={() => undefined}
        structureAdoption={{
          childTypes: [{ id: 'task', name: 'Task' }],
          parent,
        }}
        t={t}
      />,
    )

    expect(html).toContain('data-testid="ai-planning-structure-adoption"')
    expect(html).toContain('Approve and create selected rows')
    expect(html).toContain('Verify keyboard navigation findings')
    expect(html).toContain('Planned effort (hours)')
    expect(html).toContain('value="2"')
  })

  test('withdraws the section with the draft once the generation expires', () => {
    setSystemTime(new Date(Date.parse(aiPlanningGenerationFixture.expiresAt) + 1_000))
    const html = renderToStaticMarkup(
      <AiWorkItemPlanningAssistantView
        generation={aiPlanningGenerationFixture}
        locale="en"
        onDecide={async () => undefined}
        onGenerate={() => undefined}
        structureAdoption={{ childTypes: [{ id: 'task', name: 'Task' }], parent }}
        t={t}
      />,
    )

    expect(html).not.toContain('ai-planning-structure-adoption')
    expect(html).not.toContain('Verify keyboard navigation findings')
  })

  test('keeps applying the fields available after the structure was approved', () => {
    const html = renderToStaticMarkup(
      <AiWorkItemPlanningAssistantView
        generation={{
          ...aiPlanningGenerationFixture,
          decision: { decidedAt: '2026-08-26T00:00:00.000Z', outcome: 'approved' },
        }}
        locale="en"
        onAdopt={() => undefined}
        onDecide={async () => undefined}
        onGenerate={() => undefined}
        structureAdoption={{ childTypes: [{ id: 'task', name: 'Task' }], parent }}
        t={t}
      />,
    )

    expect(html).toContain('Use supported fields in form')
  })

  test('keeps the section away from read-only routes', () => {
    const html = renderToStaticMarkup(
      <AiWorkItemPlanningAssistantView
        generation={aiPlanningGenerationFixture}
        locale="en"
        onDecide={async () => undefined}
        onGenerate={() => undefined}
        t={t}
      />,
    )

    expect(html).not.toContain('ai-planning-structure-adoption')
  })

  test('explains when the parent type allows no children', () => {
    const html = renderToStaticMarkup(
      <AiWorkItemPlanningAssistantView
        generation={aiPlanningGenerationFixture}
        locale="en"
        onDecide={async () => undefined}
        onGenerate={() => undefined}
        structureAdoption={{ childTypes: [], parent }}
        t={t}
      />,
    )

    expect(html).toContain('allows no child Work Item Types')
  })
})
