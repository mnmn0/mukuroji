import { describe, expect, test } from 'bun:test'
import {
  createMigratedWorkItem,
  createProjectOwnership,
  createProjectOwnershipKey,
  createWorkItemMigrationFingerprint,
  hasEquivalentWorkItemState,
  hasCurrentWorkItemVersion,
  resolveProjectOwnerTeam,
} from './work-item-migration'

describe('Work Item state migration', () => {
  test('resolves a project with one active owner team', () => {
    const ownership = createProjectOwnership([
      {
        directoryId: 'workspace-1',
        entryType: 'team',
        teamId: 'core-team',
      },
      {
        directoryId: 'workspace-1',
        entryType: 'project',
        projectId: 'refero',
        teamId: 'core-team',
      },
    ])

    expect(resolveProjectOwnerTeam(ownership, 'workspace-1', 'refero', new Map())).toEqual({
      ok: true,
      teamId: 'core-team',
    })
  })

  test('requires an explicit mapping for projects shared by active teams', () => {
    const ownership = createProjectOwnership([
      { directoryId: 'workspace-1', entryType: 'team', teamId: 'core-team' },
      { directoryId: 'workspace-1', entryType: 'team', teamId: 'design-team' },
      {
        directoryId: 'workspace-1',
        entryType: 'project',
        projectId: 'shared',
        teamId: 'core-team',
      },
      {
        directoryId: 'workspace-1',
        entryType: 'project',
        projectId: 'shared',
        teamId: 'design-team',
      },
    ])

    expect(
      resolveProjectOwnerTeam(ownership, 'workspace-1', 'shared', new Map()),
    ).toMatchObject({ ok: false })
    expect(
      resolveProjectOwnerTeam(
        ownership,
        'workspace-1',
        'shared',
        new Map([[createProjectOwnershipKey('workspace-1', 'shared'), 'design-team']]),
      ),
    ).toEqual({ ok: true, teamId: 'design-team' })
  })

  test('keeps identical project IDs isolated by Workspace', () => {
    const ownership = createProjectOwnership([
      { directoryId: 'workspace-1', entryType: 'team', teamId: 'core-team' },
      { directoryId: 'workspace-2', entryType: 'team', teamId: 'design-team' },
      {
        directoryId: 'workspace-1',
        entryType: 'project',
        projectId: 'refero',
        teamId: 'core-team',
      },
      {
        directoryId: 'workspace-2',
        entryType: 'project',
        projectId: 'refero',
        teamId: 'design-team',
      },
    ])

    const workspaceOneMapping = new Map([
      [createProjectOwnershipKey('workspace-1', 'refero'), 'core-team'],
    ])

    expect(
      resolveProjectOwnerTeam(ownership, 'workspace-1', 'refero', workspaceOneMapping),
    ).toEqual({
      ok: true,
      teamId: 'core-team',
    })
    expect(
      resolveProjectOwnerTeam(ownership, 'workspace-2', 'refero', workspaceOneMapping),
    ).toEqual({
      ok: true,
      teamId: 'design-team',
    })
  })

  test('excludes projects whose parent Team is archived', () => {
    const ownership = createProjectOwnership([
      {
        directoryId: 'workspace-1',
        entryType: 'team',
        teamId: 'archived-team',
        archivedAt: '2026-07-01T00:00:00.000Z',
      },
      { directoryId: 'workspace-1', entryType: 'team', teamId: 'active-team' },
      {
        directoryId: 'workspace-1',
        entryType: 'project',
        projectId: 'shared',
        teamId: 'archived-team',
      },
      {
        directoryId: 'workspace-1',
        entryType: 'project',
        projectId: 'shared',
        teamId: 'active-team',
      },
    ])

    expect(resolveProjectOwnerTeam(ownership, 'workspace-1', 'shared', new Map())).toEqual({
      ok: true,
      teamId: 'active-team',
    })
    expect(
      resolveProjectOwnerTeam(
        ownership,
        'workspace-1',
        'shared',
        new Map([[createProjectOwnershipKey('workspace-1', 'shared'), 'archived-team']]),
      ),
    ).toMatchObject({ ok: false })
  })

  test('creates a versioned canonical row without changing the legacy source', () => {
    const task = {
      directoryId: 'workspace-1',
      directoryProjectId: 'workspace-1#project#refero',
      projectId: 'refero',
      taskId: 'wireframe',
      sortOrder: 10,
      titleKey: 'tasks.item.wireframe',
      assigneeUserId: 'sato@example.com',
      status: 'in-progress',
      dueDate: '2026/06/03',
      priority: 'high',
    }

    const result = createMigratedWorkItem({ task, teamId: 'core-team' })

    expect(result).toMatchObject({
      ok: true,
      item: {
        directoryTeamId: 'workspace-1#team#core-team',
        directoryProjectId: 'workspace-1#project#refero',
        teamId: 'core-team',
        assignedProjectId: 'refero',
        issueId: 'wireframe',
        title: 'tasks.item.wireframe',
        titleKey: 'tasks.item.wireframe',
        schemaVersion: 1,
        revision: 1,
        migrationSource: 'legacy-project-task',
        migrationTitleFallback: true,
      },
    })
    expect(task).not.toHaveProperty('schemaVersion')
  })

  test('creates a deterministic fingerprint for idempotent reruns', () => {
    const first = createMigratedWorkItem({
      teamId: 'core-team',
      task: {
        directoryId: 'workspace-1',
        projectId: 'refero',
        taskId: 'wireframe',
        sortOrder: 10,
        title: 'Wireframe',
        assigneeUserId: 'sato@example.com',
        status: 'todo',
        dueDate: '2026/06/03',
        priority: 'high',
      },
    })
    const second = structuredClone(first)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) {
      throw new Error('Expected migrated Work Items.')
    }
    expect(first.item.migrationFingerprint).toBe(second.item.migrationFingerprint)
    expect(createWorkItemMigrationFingerprint(first.item)).toBe(first.item.migrationFingerprint)
  })

  test('rejects legacy rows with unsupported canonical values', () => {
    const result = createMigratedWorkItem({
      teamId: 'core-team',
      task: {
        directoryId: 'workspace-1',
        projectId: 'refero',
        taskId: 'broken',
        sortOrder: 10,
        title: 'Broken',
        assigneeUserId: 'sato@example.com',
        status: 'blocked',
        dueDate: '2026/06/03',
        priority: 'urgent',
      },
    })

    expect(result).toMatchObject({ ok: false })
  })

  test('recognizes only supported positive revisions as current', () => {
    expect(hasCurrentWorkItemVersion({ schemaVersion: 1, revision: 1 })).toBe(true)
    expect(hasCurrentWorkItemVersion({ schemaVersion: 1, revision: 0 })).toBe(false)
    expect(hasCurrentWorkItemVersion({ schemaVersion: 2, revision: 1 })).toBe(false)
  })

  test('accepts an equivalent canonical seed without migration metadata', () => {
    const migrated = {
      directoryId: 'workspace-1',
      directoryTeamId: 'workspace-1#team#core-team',
      directoryProjectId: 'workspace-1#project#refero',
      teamId: 'core-team',
      assignedProjectId: 'refero',
      issueId: 'wireframe',
      sortOrder: 10,
      title: 'tasks.item.wireframe',
      titleKey: 'tasks.item.wireframe',
      assigneeUserId: 'sato@example.com',
      status: 'todo',
      dueDate: '2026/06/03',
      priority: 'high',
      schemaVersion: 1,
      revision: 1,
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z',
      migrationSource: 'legacy-project-task',
      migrationTitleFallback: true,
    }
    const canonicalSeed = {
      ...migrated,
      title: 'Wireframe',
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
      migrationSource: undefined,
      migrationTitleFallback: undefined,
    }

    expect(hasEquivalentWorkItemState(canonicalSeed, migrated)).toBe(true)
    expect(hasEquivalentWorkItemState({ ...canonicalSeed, status: 'done' }, migrated)).toBe(false)
  })
})
