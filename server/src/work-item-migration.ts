import { createHash } from 'node:crypto'
import { WORK_ITEM_SCHEMA_VERSION } from '@mukuroji/contracts'

/** DynamoDB DocumentClient が返す汎用 item です。 */
export type MigrationItem = Record<string, unknown>

/** Workspace / Project ごとの owner team 解決結果です。 */
export type ProjectOwnership = {
  /** Workspace / Project 複合 key ごとの active team ID 一覧です。 */
  teamsByDirectoryProjectKey: ReadonlyMap<string, readonly string[]>
}

/** Legacy project task を canonical Work Item に変換する入力です。 */
export type LegacyWorkItemMigrationInput = {
  /** Legacy project task item です。 */
  task: MigrationItem
  /** 明示的に解決済みの owner team ID です。 */
  teamId: string
}

/** Legacy project task の変換結果です。 */
export type LegacyWorkItemMigrationResult =
  | {
      /** 変換に成功したことを表します。 */
      ok: true
      /** Canonical Work Item table に conditional put する item です。 */
      item: MigrationItem
    }
  | {
      /** 変換できなかったことを表します。 */
      ok: false
      /** Operator が修正すべき理由です。 */
      reason: string
    }

/** Existing canonical row に安全に補完する migration metadata です。 */
export type WorkItemMigrationMetadata = {
  /** Legacy project task migration の種別です。 */
  migrationSource: string
  /** Workspace / source project / task に scope-bound な安定 key です。 */
  migrationSourceKey: string
}

/** Existing canonical row の migration metadata 補完判定です。 */
export type WorkItemMigrationMetadataPlan =
  | {
      /** 同じ source metadata がすでに存在することを表します。 */
      action: 'unchanged'
    }
  | {
      /** Metadata だけを conditional update で補完できることを表します。 */
      action: 'backfill'
      /** Race を検出する canonical row の現在 revision です。 */
      expectedRevision: number
      /** 業務 field を含まない補完対象 metadata です。 */
      metadata: WorkItemMigrationMetadata
    }
  | {
      /** 安全に補完できない衝突を表します。 */
      action: 'conflict'
      /** Operator が確認する衝突理由です。 */
      reason: string
    }

/**
 * Workspace / Project を一意に識別する内部 key を作成します。
 */
export function createProjectOwnershipKey(directoryId: string, projectId: string) {
  return JSON.stringify([directoryId, projectId])
}

/**
 * Project directory row から active Team 配下の project と owner 候補を集計します。
 */
export function createProjectOwnership(items: readonly MigrationItem[]): ProjectOwnership {
  const activeTeamKeys = new Set<string>()
  const mutableTeamsByDirectoryProjectKey = new Map<string, Set<string>>()

  for (const item of items) {
    if (
      item.entryType !== 'team' ||
      typeof item.directoryId !== 'string' ||
      !item.directoryId.trim() ||
      typeof item.teamId !== 'string' ||
      !item.teamId.trim() ||
      item.archivedAt !== undefined
    ) {
      continue
    }

    activeTeamKeys.add(createProjectOwnershipKey(item.directoryId.trim(), item.teamId.trim()))
  }

  for (const item of items) {
    if (
      item.entryType !== 'project' ||
      typeof item.directoryId !== 'string' ||
      !item.directoryId.trim() ||
      typeof item.projectId !== 'string' ||
      !item.projectId.trim() ||
      typeof item.teamId !== 'string' ||
      !item.teamId.trim() ||
      item.archivedAt !== undefined
    ) {
      continue
    }

    const directoryId = item.directoryId.trim()
    const projectId = item.projectId.trim()
    const teamId = item.teamId.trim()
    if (!activeTeamKeys.has(createProjectOwnershipKey(directoryId, teamId))) {
      continue
    }

    const ownershipKey = createProjectOwnershipKey(directoryId, projectId)
    const teamIds = mutableTeamsByDirectoryProjectKey.get(ownershipKey) ?? new Set<string>()
    teamIds.add(teamId)
    mutableTeamsByDirectoryProjectKey.set(ownershipKey, teamIds)
  }

  return {
    teamsByDirectoryProjectKey: new Map(
      [...mutableTeamsByDirectoryProjectKey].map(([ownershipKey, teamIds]) => [
        ownershipKey,
        [...teamIds].sort(),
      ]),
    ),
  }
}

/**
 * Project の owner team を一意に解決します。
 *
 * @remarks
 * 複数 team に属する project は、production data を誤った team に移さないよう
 * 明示 mapping が無い限り失敗させます。
 */
export function resolveProjectOwnerTeam(
  ownership: ProjectOwnership,
  directoryId: string,
  projectId: string,
  explicitMappings: ReadonlyMap<string, string>,
) {
  const ownershipKey = createProjectOwnershipKey(directoryId, projectId)
  const candidates = ownership.teamsByDirectoryProjectKey.get(ownershipKey) ?? []
  const explicitTeamId = explicitMappings.get(ownershipKey)
  const projectLabel = `${directoryId}/${projectId}`

  if (explicitTeamId) {
    if (!candidates.includes(explicitTeamId)) {
      return {
        ok: false,
        reason: `Explicit owner team "${explicitTeamId}" is not an active owner of project "${projectLabel}".`,
      } as const
    }

    return { ok: true, teamId: explicitTeamId } as const
  }

  if (candidates.length === 1 && candidates[0]) {
    return { ok: true, teamId: candidates[0] } as const
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `Project "${projectLabel}" has no active owner team.`,
    } as const
  }

  return {
    ok: false,
    reason:
      `Project "${projectLabel}" belongs to multiple active teams (${candidates.join(', ')}). ` +
      `Pass --project-team ${projectLabel}=<teamId>.`,
  } as const
}

/**
 * Legacy project task を既存 TeamIssues table の canonical Work Item row に変換します。
 */
export function createMigratedWorkItem(
  input: LegacyWorkItemMigrationInput,
): LegacyWorkItemMigrationResult {
  const directoryId = readString(input.task.directoryId)
  const projectId = readString(input.task.projectId)
  const taskId = readString(input.task.taskId)
  const assigneeUserId = readString(
    input.task.assigneeUserId ?? input.task.assignee ?? input.task.assigneeKey,
  )
  const status = readString(input.task.status)
  const dueDate = readString(input.task.dueDate)
  const priority = readString(input.task.priority)
  const sortOrder = input.task.sortOrder

  if (!directoryId || !projectId || !taskId) {
    return { ok: false, reason: 'Legacy task is missing directoryId, projectId, or taskId.' }
  }

  if (
    !assigneeUserId ||
    !status ||
    !['in-progress', 'review', 'todo', 'done'].includes(status) ||
    !dueDate ||
    !priority ||
    !['high', 'medium', 'low'].includes(priority) ||
    typeof sortOrder !== 'number' ||
    !Number.isFinite(sortOrder)
  ) {
    return { ok: false, reason: `Legacy task "${projectId}/${taskId}" is missing canonical fields.` }
  }

  const sourceTitle = readString(input.task.title)
  const titleKey = readString(input.task.titleKey)

  if (!sourceTitle && !titleKey) {
    return { ok: false, reason: `Legacy task "${projectId}/${taskId}" has no title.` }
  }
  const title = sourceTitle ?? titleKey as string

  const createdAt = normalizeTimestamp(input.task.createdAt)
  const updatedAt = normalizeTimestamp(input.task.updatedAt, createdAt)
  const item: MigrationItem = {
    directoryId,
    directoryTeamId: `${directoryId}#team#${input.teamId}`,
    directoryProjectId: `${directoryId}#project#${projectId}`,
    teamId: input.teamId,
    assignedProjectId: projectId,
    issueId: taskId,
    sortOrder,
    assigneeUserId,
    status,
    dueDate,
    priority,
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    createdAt,
    updatedAt,
    migrationSource: 'legacy-project-task',
    migrationSourceKey: `${directoryId}#project#${projectId}#task#${taskId}`,
  }

  item.title = title
  if (titleKey) {
    item.titleKey = titleKey
  }
  if (!sourceTitle) {
    item.migrationTitleFallback = true
  }
  const description = readString(input.task.description)
  if (description) {
    item.description = description
  }

  item.migrationFingerprint = createWorkItemMigrationFingerprint(item)

  return { ok: true, item }
}

/**
 * 再実行時の同一性判定に使う canonical field fingerprint を作成します。
 */
export function createWorkItemMigrationFingerprint(item: MigrationItem) {
  const fields = [
    'directoryId',
    'directoryTeamId',
    'directoryProjectId',
    'teamId',
    'assignedProjectId',
    'issueId',
    'sortOrder',
    'title',
    'titleKey',
    'description',
    'assigneeUserId',
    'status',
    'dueDate',
    'priority',
    'schemaVersion',
    'revision',
    'createdAt',
    'updatedAt',
    'migrationSource',
    'migrationSourceKey',
    'migrationTitleFallback',
  ] as const
  const payload = Object.fromEntries(fields.map((field) => [field, item[field] ?? null]))

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/**
 * Migration metadata を持たない canonical seed と legacy task projection の業務 state が同じか判定します。
 *
 * @remarks
 * 作成/更新 timestamp と migration 診断 field は比較しません。既存 canonical row の業務 field が
 * 1つでも異なる場合は collision とし、migration が上書きすることを防ぎます。
 */
export function hasEquivalentWorkItemState(
  current: MigrationItem,
  migrated: MigrationItem,
) {
  const fields = [
    'directoryId',
    'directoryTeamId',
    'directoryProjectId',
    'teamId',
    'assignedProjectId',
    'issueId',
    'sortOrder',
    'assigneeUserId',
    'status',
    'dueDate',
    'priority',
    'schemaVersion',
    'revision',
  ] as const
  const optionalSourceFields = ['titleKey', 'description'] as const
  const titleMatches = migrated.title === undefined ||
    migrated.migrationTitleFallback === true ||
    current.title === migrated.title

  return fields.every((field) => (current[field] ?? null) === (migrated[field] ?? null)) &&
    titleMatches &&
    optionalSourceFields.every((field) =>
      migrated[field] === undefined || current[field] === migrated[field],
    )
}

/**
 * Existing canonical row と legacy projection を比較し、metadata だけの補完を計画します。
 *
 * @remarks
 * `migrationSourceKey` が同じ row は再実行済みとします。key が未設定の場合だけ業務 state の
 * 等価性を確認し、revision と metadata の conditional update 用情報を返します。
 */
export function planWorkItemMigrationMetadataBackfill(
  current: MigrationItem,
  migrated: MigrationItem,
): WorkItemMigrationMetadataPlan {
  const migrationSource = readString(migrated.migrationSource)
  const migrationSourceKey = readString(migrated.migrationSourceKey)
  if (
    !migrationSource ||
    migrated.migrationSource !== migrationSource ||
    !migrationSourceKey ||
    migrated.migrationSourceKey !== migrationSourceKey
  ) {
    return {
      action: 'conflict',
      reason: 'Migrated Work Item is missing source metadata.',
    }
  }

  const currentMigrationSource = readString(current.migrationSource)
  const currentMigrationSourceKey = readString(current.migrationSourceKey)
  if (
    current.migrationSource !== undefined &&
    current.migrationSource !== currentMigrationSource
  ) {
    return {
      action: 'conflict',
      reason: 'Existing Work Item has invalid migrationSource metadata.',
    }
  }
  if (
    current.migrationSourceKey !== undefined &&
    current.migrationSourceKey !== currentMigrationSourceKey
  ) {
    return {
      action: 'conflict',
      reason: 'Existing Work Item has invalid migrationSourceKey metadata.',
    }
  }

  if (currentMigrationSourceKey) {
    if (currentMigrationSourceKey !== migrationSourceKey) {
      return {
        action: 'conflict',
        reason: 'Existing Work Item belongs to another migration source.',
      }
    }
    if (currentMigrationSource && currentMigrationSource !== migrationSource) {
      return {
        action: 'conflict',
        reason: 'Existing Work Item has conflicting migrationSource metadata.',
      }
    }

    return { action: 'unchanged' }
  }

  if (currentMigrationSource && currentMigrationSource !== migrationSource) {
    return {
      action: 'conflict',
      reason: 'Existing Work Item has conflicting migrationSource metadata.',
    }
  }
  if (!hasEquivalentWorkItemState(current, migrated)) {
    return {
      action: 'conflict',
      reason: 'Existing Work Item business state differs from the legacy source.',
    }
  }

  const expectedRevision = current.revision
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
    return {
      action: 'conflict',
      reason: 'Existing Work Item revision cannot guard a metadata backfill.',
    }
  }

  return {
    action: 'backfill',
    expectedRevision: expectedRevision as number,
    metadata: { migrationSource, migrationSourceKey },
  }
}

/** Canonical Work Item schema metadata が有効かを判定します。 */
export function hasCurrentWorkItemVersion(item: MigrationItem) {
  return item.schemaVersion === WORK_ITEM_SCHEMA_VERSION &&
    Number.isSafeInteger(item.revision) &&
    (item.revision as number) >= 1
}

/** Migration が安全に補完できない schema version かを判定します。 */
export function hasUnsupportedWorkItemVersion(item: MigrationItem) {
  return item.schemaVersion !== undefined && item.schemaVersion !== WORK_ITEM_SCHEMA_VERSION
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeTimestamp(value: unknown, fallback = '1970-01-01T00:00:00.000Z') {
  if (typeof value !== 'string') {
    return fallback
  }

  const timestamp = Date.parse(value)

  return Number.isNaN(timestamp) ? fallback : new Date(timestamp).toISOString()
}
