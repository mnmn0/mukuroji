import { describe, expect, test } from 'bun:test'
import type { ProjectDirectoryTeamResponse } from '../../modules/directory'
import { requireAssignedProjectAcceptsNewWorkItems } from './work-item-access'

type ProjectDirectoryPort = NonNullable<Parameters<typeof requireAssignedProjectAcceptsNewWorkItems>[3]>

const closedTeam = {
  id: 'core-team',
  name: 'Core Team',
  expanded: true,
  projects: [{ id: 'refero', name: 'Refero', tone: 'blue', lifecycleState: 'closed' }],
} as ProjectDirectoryTeamResponse

describe('requireAssignedProjectAcceptsNewWorkItems', () => {
  test('leaves the decision to the commit-time fence so a committed create can still be replayed', async () => {
    const fence = { ConditionCheck: { TableName: 'DirectoryTable', Key: {}, ConditionExpression: 'x' } }
    const projectDirectory = {
      createNewWorkItemProjectConditionCheck: async () => fence,
    } as unknown as ProjectDirectoryPort

    expect(await requireAssignedProjectAcceptsNewWorkItems('workspace-1', closedTeam, 'refero', projectDirectory))
      .toEqual({ newWorkItemProjectConditionCheck: fence })
  })

  test('rejects from the directory snapshot when no fence can be built', async () => {
    await expect(requireAssignedProjectAcceptsNewWorkItems(
      'workspace-1',
      closedTeam,
      'refero',
      {} as ProjectDirectoryPort,
    )).rejects.toMatchObject({ status: 409, code: 'ProjectClosedForNewWorkItems' })
    expect(await requireAssignedProjectAcceptsNewWorkItems('workspace-1', closedTeam, undefined, {} as ProjectDirectoryPort))
      .toEqual({})
  })
})
