import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type CanonicalWorkItem,
} from '@mukuroji/contracts'
import { describe, expect, test } from 'bun:test'
import type { WorkItemMemberIndexReference } from '../work-items'
import type { FocusRelationGraphSource } from './focus-queue'
import {
  FOCUS_WORK_ITEM_REFERENCE_LIMIT,
  readFocusWorkItemWindow,
  type FocusWorkItemSourceReference,
  type FocusWorkItemWindowPorts,
} from './focus-work-item-window'

/**
 * Creates a canonical Work Item fixture.
 *
 * @param teamId - Owning Team.
 * @param id - Team-local Work Item ID.
 * @param archivedAt - Archive time, when archived.
 * @returns Canonical Work Item.
 */
function createWorkItem(teamId: string, id: string, archivedAt?: string): CanonicalWorkItem {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id,
    teamId,
    title: id,
    assigneeUserId: 'viewer',
    creatorMemberKey: 'viewer',
    dueDate: '',
    schedule: {
      mode: 'unscheduled',
      calendarPolicy: { timeZone: 'UTC', workingWeekdays: ['monday'], holidays: [] },
    },
    priority: 'medium',
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    customFieldValues: {},
    relationIds: [],
    createdAt: '2026-08-09T08:00:00.000Z',
    updatedAt: '2026-08-09T08:00:00.000Z',
    source: 'dynamodb',
    ...(archivedAt === undefined ? {} : { archivedAt }),
  }
}

/** Fake stores plus the calls the use case made to them. */
type FakeWindow = {
  /** Ports given to the use case. */
  ports: FocusWorkItemWindowPorts<FocusWorkItemSourceReference, FocusWorkItemSourceReference>
  /** References passed to the reference read. */
  readReferences: WorkItemMemberIndexReference[][]
  /** Teams whose relation graphs were read. */
  graphTeamIds: string[][]
  /** Number of complete reads. */
  completeReads: number
}

/**
 * Creates fake ports over a fixed set of stored Work Items.
 *
 * @param stored - Stored canonical Work Items.
 * @param overrides - Port overrides.
 * @returns Ports and call records.
 */
function createFakeWindow(
  stored: readonly CanonicalWorkItem[],
  overrides: Partial<FocusWorkItemWindowPorts<FocusWorkItemSourceReference, FocusWorkItemSourceReference>> = {},
): FakeWindow {
  const fake: FakeWindow = {
    readReferences: [],
    graphTeamIds: [],
    completeReads: 0,
    ports: {
      readableTeamIds: ['team-a', 'team-b'],
      notifications: Promise.resolve([{ teamId: 'team-a', issueId: 'mentioned' }]),
      reviewerApprovals: Promise.resolve([{ teamId: 'team-b', issueId: 'reviewed' }]),
      listMemberWorkItemReferences: async () => [
        { teamId: 'team-a', workItemId: 'owned' },
        { teamId: 'hidden-team', workItemId: 'elsewhere' },
      ],
      readWorkItemsByReferences: async (references) => {
        fake.readReferences.push([...references])
        return stored.filter((workItem) =>
          references.some((reference) =>
            reference.teamId === workItem.teamId && reference.workItemId === workItem.id
          )
        )
      },
      readAllAccessibleWorkItems: async () => {
        fake.completeReads += 1
        return stored
      },
      readRelationGraphs: async (teamIds): Promise<FocusRelationGraphSource[]> => {
        fake.graphTeamIds.push([...teamIds])
        return [{
          teamId: 'team-a',
          graphRevision: 1,
          relations: [
            { sourceWorkItemId: 'blocked', targetWorkItemId: 'blocker', type: 'blockedBy', createdAt: '2026-08-09T08:00:00.000Z' },
            { sourceWorkItemId: 'related-a', targetWorkItemId: 'related-b', type: 'related', createdAt: '2026-08-09T08:00:00.000Z' },
          ],
        }]
      },
      readPlanningDependencies: async () => [{
        predecessor: { teamId: 'team-b', workItemId: 'predecessor' },
        successor: { teamId: 'team-b', workItemId: 'successor' },
      }],
      filterAccessibleTeamWorkItems: (_teamId, workItems) =>
        workItems.filter((workItem) => workItem.id !== 'forbidden'),
      createLimitExceededError: (limit) => new Error(`limit ${limit}`),
      ...overrides,
    },
  }
  return fake
}

describe('Focus Work Item window (ADR 0038)', () => {
  test('reads only referenced Work Items in readable Teams and filters them like the full read', async () => {
    const stored = [
      createWorkItem('team-a', 'owned'),
      createWorkItem('team-a', 'mentioned'),
      createWorkItem('team-a', 'blocked'),
      createWorkItem('team-a', 'blocker', '2026-08-10T00:00:00.000Z'),
      createWorkItem('team-b', 'reviewed'),
      createWorkItem('team-b', 'predecessor'),
      createWorkItem('team-b', 'successor'),
      createWorkItem('team-b', 'unreferenced'),
    ]
    const fake = createFakeWindow(stored)

    const window = await readFocusWorkItemWindow(fake.ports)

    expect(fake.completeReads).toBe(0)
    expect(fake.graphTeamIds).toEqual([['team-a', 'team-b']])
    expect(fake.readReferences[0]?.map((reference) => `${reference.teamId}/${reference.workItemId}`).sort()).toEqual([
      'team-a/blocked',
      'team-a/blocker',
      'team-a/mentioned',
      'team-a/owned',
      'team-b/predecessor',
      'team-b/reviewed',
      'team-b/successor',
    ])
    // Archived rows are dropped; related endpoints and hidden Teams are never read.
    expect(window.workItems.map((workItem) => `${workItem.teamId}/${workItem.id}`)).toEqual([
      'team-a/owned',
      'team-a/mentioned',
      'team-a/blocked',
      'team-b/reviewed',
      'team-b/predecessor',
      'team-b/successor',
    ])
    expect(window.notifications).toEqual([{ teamId: 'team-a', issueId: 'mentioned' }])
    expect(window.reviewerApprovals).toEqual([{ teamId: 'team-b', issueId: 'reviewed' }])
  })

  test('applies the access check to every Team', async () => {
    const fake = createFakeWindow([createWorkItem('team-a', 'owned'), createWorkItem('team-a', 'forbidden')], {
      listMemberWorkItemReferences: async () => [
        { teamId: 'team-a', workItemId: 'owned' },
        { teamId: 'team-a', workItemId: 'forbidden' },
      ],
    })

    const window = await readFocusWorkItemWindow(fake.ports)

    expect(window.workItems.map((workItem) => workItem.id)).toEqual(['owned'])
  })

  test('fails before reading when Focus would need more Work Items than the limit', async () => {
    const fake = createFakeWindow([], {
      listMemberWorkItemReferences: async () =>
        Array.from({ length: FOCUS_WORK_ITEM_REFERENCE_LIMIT + 1 }, (_value, index) => ({
          teamId: 'team-a',
          workItemId: `item-${index}`,
        })),
    })

    await expect(readFocusWorkItemWindow(fake.ports)).rejects.toThrow(`limit ${FOCUS_WORK_ITEM_REFERENCE_LIMIT}`)
    expect(fake.readReferences).toEqual([])
  })

  test('falls back to the complete read when the store has no reference reads', async () => {
    const fake = createFakeWindow([createWorkItem('team-b', 'unreferenced')], {
      listMemberWorkItemReferences: undefined,
    })

    const window = await readFocusWorkItemWindow(fake.ports)

    expect(fake.completeReads).toBe(1)
    expect(fake.readReferences).toEqual([])
    expect(fake.graphTeamIds).toEqual([['team-b']])
    expect(window.workItems.map((workItem) => workItem.id)).toEqual(['unreferenced'])
  })
})
