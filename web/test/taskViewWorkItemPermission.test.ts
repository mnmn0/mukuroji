import { describe, expect, test } from 'bun:test'
import { canWriteTaskViewWorkItem } from '../src/task-views/model/taskViewWorkItemPermission'

describe('task-view Work Item write permission', () => {
  test('requires the qualified Project scope for an assigned Work Item', () => {
    const capabilities = {
      writableProjectScopes: [{ projectId: 'project-a', teamId: 'team-a' }],
      writableTeamIds: ['team-b'],
    }

    expect(canWriteTaskViewWorkItem(capabilities, {
      assignedProjectId: 'project-a',
      teamId: 'team-a',
    })).toBe(true)
    expect(canWriteTaskViewWorkItem(capabilities, {
      assignedProjectId: 'project-a',
      teamId: 'team-b',
    })).toBe(false)
    expect(canWriteTaskViewWorkItem(capabilities, {
      assignedProjectId: 'project-b',
      teamId: 'team-b',
    })).toBe(false)
  })

  test('uses Team permission only for an unassigned Work Item', () => {
    const capabilities = {
      writableProjectScopes: [{ projectId: 'project-a', teamId: 'team-a' }],
      writableTeamIds: ['team-b'],
    }

    expect(canWriteTaskViewWorkItem(capabilities, { teamId: 'team-b' })).toBe(true)
    expect(canWriteTaskViewWorkItem(capabilities, { teamId: 'team-a' })).toBe(false)
  })
})
