import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import {
  createMigratedWorkItem,
  createProjectOwnership,
  createProjectOwnershipKey,
  createWorkItemMigrationFingerprint,
  hasEquivalentWorkItemState,
  hasCurrentWorkItemVersion,
  planWorkItemMigrationMetadataBackfill,
  resolveProjectOwnerTeam,
} from './work-item-migration'
import { processLegacyTask } from '../scripts/migrate-work-items'

afterEach(() => {
  setSystemTime()
})

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
    const input = {
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
    }
    setSystemTime(new Date('2026-07-12T00:00:00.000Z'))
    const firstGenerationTime = Date.now()
    const first = createMigratedWorkItem(input)
    setSystemTime(new Date('2026-07-13T00:00:00.000Z'))
    const secondGenerationTime = Date.now()
    const second = createMigratedWorkItem(input)

    expect(firstGenerationTime).not.toBe(secondGenerationTime)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) {
      throw new Error('Expected migrated Work Items.')
    }
    const fingerprint = first.item.migrationFingerprint
    if (typeof fingerprint !== 'string') {
      throw new Error('Expected a migration fingerprint.')
    }
    expect(first.item.migrationFingerprint).toBe(second.item.migrationFingerprint)
    expect(createWorkItemMigrationFingerprint(first.item)).toBe(fingerprint)
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

  test('plans a metadata-only backfill for an equivalent canonical seed', () => {
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
      migrationSource: 'legacy-project-task',
      migrationSourceKey: 'workspace-1#project#refero#task#wireframe',
      migrationTitleFallback: true,
    }
    const canonicalSeed = {
      ...migrated,
      title: 'Wireframe',
      migrationSource: undefined,
      migrationSourceKey: undefined,
      migrationTitleFallback: undefined,
    }
    const before = structuredClone(canonicalSeed)

    expect(planWorkItemMigrationMetadataBackfill(canonicalSeed, migrated)).toEqual({
      action: 'backfill',
      expectedRevision: 1,
      metadata: {
        migrationSource: 'legacy-project-task',
        migrationSourceKey: 'workspace-1#project#refero#task#wireframe',
      },
    })
    expect(canonicalSeed).toEqual(before)
  })

  test('keeps a metadata backfill idempotent without comparing later business edits', () => {
    const migrated = {
      directoryId: 'workspace-1',
      directoryTeamId: 'workspace-1#team#core-team',
      directoryProjectId: 'workspace-1#project#refero',
      teamId: 'core-team',
      assignedProjectId: 'refero',
      issueId: 'wireframe',
      sortOrder: 10,
      title: 'Wireframe',
      assigneeUserId: 'sato@example.com',
      status: 'todo',
      dueDate: '2026/06/03',
      priority: 'high',
      schemaVersion: 1,
      revision: 1,
      migrationSource: 'legacy-project-task',
      migrationSourceKey: 'workspace-1#project#refero#task#wireframe',
    }

    expect(planWorkItemMigrationMetadataBackfill({
      ...migrated,
      revision: 4,
      status: 'done',
    }, migrated)).toEqual({ action: 'unchanged' })
    expect(planWorkItemMigrationMetadataBackfill({
      ...migrated,
      migrationSource: undefined,
    }, migrated)).toEqual({ action: 'unchanged' })
    expect(planWorkItemMigrationMetadataBackfill({
      ...migrated,
      migrationSourceKey: 'workspace-1#project#other#task#wireframe',
    }, migrated)).toMatchObject({ action: 'conflict' })
    expect(planWorkItemMigrationMetadataBackfill({
      ...migrated,
      migrationSource: ' legacy-project-task ',
    }, migrated)).toMatchObject({ action: 'conflict' })
    expect(planWorkItemMigrationMetadataBackfill({
      ...migrated,
      migrationSourceKey: ' workspace-1#project#refero#task#wireframe ',
    }, migrated)).toMatchObject({ action: 'conflict' })
  })

  test('rejects metadata backfill when equivalent seed business state changed', () => {
    const migrated = {
      directoryId: 'workspace-1',
      directoryTeamId: 'workspace-1#team#core-team',
      directoryProjectId: 'workspace-1#project#refero',
      teamId: 'core-team',
      assignedProjectId: 'refero',
      issueId: 'wireframe',
      sortOrder: 10,
      title: 'Wireframe',
      assigneeUserId: 'sato@example.com',
      status: 'todo',
      dueDate: '2026/06/03',
      priority: 'high',
      schemaVersion: 1,
      revision: 1,
      migrationSource: 'legacy-project-task',
      migrationSourceKey: 'workspace-1#project#refero#task#wireframe',
    }
    const canonical = {
      ...migrated,
      migrationSource: undefined,
      migrationSourceKey: undefined,
      status: 'done',
    }

    expect(planWorkItemMigrationMetadataBackfill(canonical, migrated))
      .toMatchObject({ action: 'conflict' })
  })

  test('maps dry-run, verify, and apply modes for a metadata-only backfill', async () => {
    const task = {
      directoryId: 'workspace-1',
      projectId: 'refero',
      taskId: 'wireframe',
      sortOrder: 10,
      titleKey: 'tasks.item.wireframe',
      assigneeUserId: 'sato@example.com',
      status: 'todo',
      dueDate: '2026/06/03',
      priority: 'high',
    }
    const canonicalSeed = {
      directoryId: 'workspace-1',
      directoryTeamId: 'workspace-1#team#core-team',
      directoryProjectId: 'workspace-1#project#refero',
      teamId: 'core-team',
      assignedProjectId: 'refero',
      issueId: 'wireframe',
      sortOrder: 10,
      title: 'Wireframe',
      titleKey: 'tasks.item.wireframe',
      assigneeUserId: 'sato@example.com',
      status: 'todo',
      dueDate: '2026/06/03',
      priority: 'high',
      schemaVersion: 1,
      revision: 1,
    }
    const ownership = createProjectOwnership([
      { directoryId: 'workspace-1', entryType: 'team', teamId: 'core-team' },
      {
        directoryId: 'workspace-1',
        entryType: 'project',
        projectId: 'refero',
        teamId: 'core-team',
      },
    ])
    const createOptions = (mode: 'apply' | 'dry-run' | 'verify') => ({
      checkpointPath: 'unused',
      dryRun: mode === 'dry-run',
      help: false,
      projectTeamMappings: new Map<string, string>(),
      verify: mode === 'verify',
    })
    const run = async (mode: 'apply' | 'dry-run' | 'verify') => {
      const sentInputs: Array<Record<string, unknown>> = []
      const client = {
        async send(command: { input: Record<string, unknown> }) {
          sentInputs.push(command.input)
          return 'Key' in command.input ? { Item: canonicalSeed } : {}
        },
      }
      const result = await processLegacyTask(
        task,
        ownership,
        client as never,
        'WorkItemsTable',
        createOptions(mode),
      )

      return { result, sentInputs }
    }

    const dryRun = await run('dry-run')
    const verify = await run('verify')
    const apply = await run('apply')

    expect(dryRun.result).toBe('written')
    expect(dryRun.sentInputs).toHaveLength(1)
    expect(verify.result).toBe('conflict')
    expect(verify.sentInputs).toHaveLength(1)
    expect(apply.result).toBe('written')
    expect(apply.sentInputs).toHaveLength(2)
    expect(apply.sentInputs[1]).toMatchObject({
      ConditionExpression:
        'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND ' +
        '#schemaVersion = :schemaVersion AND #revision = :expectedRevision AND ' +
        'attribute_not_exists(#migrationSourceKey) AND ' +
        'attribute_not_exists(#migrationSource)',
      ExpressionAttributeValues: {
        ':expectedRevision': 1,
        ':migrationSource': 'legacy-project-task',
        ':migrationSourceKey': 'workspace-1#project#refero#task#wireframe',
        ':schemaVersion': 1,
      },
      UpdateExpression:
        'SET #migrationSource = :migrationSource, #migrationSourceKey = :migrationSourceKey',
    })
    expect(apply.sentInputs[1]).not.toHaveProperty('title')
    expect(canonicalSeed).not.toHaveProperty('migrationSourceKey')
  })

  test('classifies only the same metadata as a duplicate after a conditional race', async () => {
    const task = {
      directoryId: 'workspace-1',
      projectId: 'refero',
      taskId: 'wireframe',
      sortOrder: 10,
      title: 'Wireframe',
      assigneeUserId: 'sato@example.com',
      status: 'todo',
      dueDate: '2026/06/03',
      priority: 'high',
    }
    const canonicalSeed = {
      ...task,
      directoryTeamId: 'workspace-1#team#core-team',
      directoryProjectId: 'workspace-1#project#refero',
      teamId: 'core-team',
      assignedProjectId: 'refero',
      issueId: 'wireframe',
      schemaVersion: 1,
      revision: 1,
    }
    const ownership = createProjectOwnership([
      { directoryId: 'workspace-1', entryType: 'team', teamId: 'core-team' },
      {
        directoryId: 'workspace-1',
        entryType: 'project',
        projectId: 'refero',
        teamId: 'core-team',
      },
    ])
    const options = {
      checkpointPath: 'unused',
      dryRun: false,
      help: false,
      projectTeamMappings: new Map<string, string>(),
      verify: false,
    }
    const runRace = async (migrationSourceKey: string) => {
      let readCount = 0
      const client = {
        async send(command: { input: Record<string, unknown> }) {
          if ('UpdateExpression' in command.input) {
            throw { name: 'ConditionalCheckFailedException' }
          }

          readCount += 1
          return {
            Item: readCount === 1
              ? canonicalSeed
              : {
                  ...canonicalSeed,
                  migrationSource: 'legacy-project-task',
                  migrationSourceKey,
                },
          }
        },
      }

      return processLegacyTask(
        task,
        ownership,
        client as never,
        'WorkItemsTable',
        options,
      )
    }

    await expect(runRace('workspace-1#project#refero#task#wireframe'))
      .resolves.toBe('duplicate')
    await expect(runRace('workspace-1#project#other#task#wireframe'))
      .resolves.toBe('conflict')
  })
})
