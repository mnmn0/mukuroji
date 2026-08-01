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

const orderedItems: ProjectQuickAccessItem[] = [
  { projectId: 'project-a', teamId: 'team-a' },
  { projectId: 'project-b', teamId: 'team-b' },
  { projectId: 'shared-project', teamId: 'team-a' },
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

  test('treats a Project star as global across Team deep-link contexts', () => {
    const result = toggleProjectQuickAccess(orderedItems, {
      projectId: 'shared-project',
      teamId: 'team-b',
    })

    expect(isProjectInQuickAccess(orderedItems, 'shared-project')).toBe(true)
    expect(result.added).toBe(false)
    expect(result.items).toEqual(orderedItems.slice(0, 2))
  })

  test('moves one position while preserving stable order and safe boundaries', () => {
    expect(moveProjectQuickAccessItem(orderedItems, 'project-b', 'up')).toEqual([
      orderedItems[1],
      orderedItems[0],
      orderedItems[2],
    ])
    expect(moveProjectQuickAccessItem(orderedItems, 'project-b', 'down')).toEqual([
      orderedItems[0],
      orderedItems[2],
      orderedItems[1],
    ])
    expect(moveProjectQuickAccessItem(orderedItems, 'project-a', 'up')).toEqual(orderedItems)
    expect(moveProjectQuickAccessItem(orderedItems, 'missing', 'down')).toEqual(orderedItems)
    expect(moveProjectQuickAccessItem(orderedItems, 'shared-project', 'down')).toEqual(orderedItems)
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
