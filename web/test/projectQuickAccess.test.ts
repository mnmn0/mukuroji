import { describe, expect, test } from 'bun:test'
import type { ProjectQuickAccessItem } from '@mukuroji/contracts'
import type { ProjectDirectoryTeam } from '../src/projects/api/directory'
import {
  canUndoProjectQuickAccess,
  isProjectInQuickAccess,
  moveProjectQuickAccessItem,
  resolveProjectQuickAccessItems,
  toggleProjectQuickAccess,
} from '../src/projects/model/projectQuickAccess'

const teams: ProjectDirectoryTeam[] = [
  {
    id: 'team-a',
    name: 'Team A',
    projects: [
      { id: 'project-a', name: 'Project A', tone: 'blue' },
      { id: 'shared-project', name: 'Shared Project', tone: 'green' },
    ],
  },
  {
    id: 'team-b',
    name: 'Team B',
    projects: [
      { id: 'project-b', name: 'Project B', tone: 'purple' },
      { id: 'shared-project', name: 'Shared Project', tone: 'yellow' },
    ],
  },
]

const projectAItem: ProjectQuickAccessItem = {
  projectId: 'project-a',
  teamId: 'team-a',
}
const projectBItem: ProjectQuickAccessItem = {
  projectId: 'project-b',
  teamId: 'team-b',
}
const teamASharedProject: ProjectQuickAccessItem = {
  projectId: 'shared-project',
  teamId: 'team-a',
}
const orderedItems: ProjectQuickAccessItem[] = [
  projectAItem,
  projectBItem,
  teamASharedProject,
]

describe('Project quick access model', () => {
  test('resolves readable Projects in stored order and drops stale references', () => {
    const resolved = resolveProjectQuickAccessItems(
      [
        orderedItems[1],
        { projectId: 'archived-project', teamId: 'team-a' },
        orderedItems[0],
        { projectId: 'project-a', teamId: 'archived-team' },
      ].filter((item): item is ProjectQuickAccessItem => item !== undefined),
      teams,
    )

    expect(resolved).toEqual([
      {
        name: 'Project B',
        projectId: 'project-b',
        teamId: 'team-b',
        teamName: 'Team B',
        tone: 'purple',
      },
      {
        name: 'Project A',
        projectId: 'project-a',
        teamId: 'team-a',
        teamName: 'Team A',
        tone: 'blue',
      },
    ])
  })

  test('adds an unstarred Project to the end without mutating the input', () => {
    const current = orderedItems.slice(0, 2)
    const result = toggleProjectQuickAccess(current, {
      projectId: 'shared-project',
      teamId: 'team-b',
    })

    expect(result).toEqual({
      added: true,
      items: [
        ...current,
        { projectId: 'shared-project', teamId: 'team-b' },
      ],
    })
    expect(current).toEqual(orderedItems.slice(0, 2))
  })

  test('keeps duplicate Project IDs independently starred by Team context', () => {
    const teamBSharedProject = {
      projectId: 'shared-project',
      teamId: 'team-b',
    }
    const added = toggleProjectQuickAccess(orderedItems, teamBSharedProject)
    const removed = toggleProjectQuickAccess(added.items, teamASharedProject)

    expect(isProjectInQuickAccess(orderedItems, teamASharedProject)).toBe(true)
    expect(isProjectInQuickAccess(orderedItems, teamBSharedProject)).toBe(false)
    expect(added).toEqual({
      added: true,
      items: [...orderedItems, teamBSharedProject],
    })
    expect(removed).toEqual({
      added: false,
      items: [orderedItems[0], orderedItems[1], teamBSharedProject],
    })
  })

  test('moves one position while preserving stable order and safe boundaries', () => {
    expect(moveProjectQuickAccessItem(orderedItems, projectBItem, 'up')).toEqual([
      projectBItem,
      projectAItem,
      teamASharedProject,
    ])
    expect(moveProjectQuickAccessItem(orderedItems, projectBItem, 'down')).toEqual([
      projectAItem,
      teamASharedProject,
      projectBItem,
    ])
    expect(moveProjectQuickAccessItem(orderedItems, projectAItem, 'up')).toEqual(orderedItems)
    expect(moveProjectQuickAccessItem(
      orderedItems,
      { projectId: 'missing', teamId: 'team-a' },
      'down',
    )).toEqual(orderedItems)
    expect(moveProjectQuickAccessItem(
      orderedItems,
      teamASharedProject,
      'down',
    )).toEqual(orderedItems)
  })

  test('allows Undo only while the committed revision is still current', () => {
    const feedback = {
      kind: 'removed' as const,
      undoItems: orderedItems,
      undoRevision: 8,
    }

    expect(canUndoProjectQuickAccess(feedback, 8)).toBe(true)
    expect(canUndoProjectQuickAccess(feedback, 9)).toBe(false)
    expect(canUndoProjectQuickAccess({ kind: 'error' }, 8)).toBe(false)
  })
})
