import { type EnterprisePermissionId } from '@mukuroji/contracts'
import {
  type WorkspaceActiveMemberConditionOptions,
} from '../../modules/workspace-access/workspace-access'

/** Workspace roles that may perform a Team Triage mutation. */
export const TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS: WorkspaceActiveMemberConditionOptions = {
  allowedRoles: ['owner', 'admin', 'member'],
}

/**
 * `/api/work-items` は既存の `{ workItems }` 契約を維持するため cursor を追加せず、
 * pagination 契約を導入するまで hard cap 超過を 413 で fail-closed にします。
 * この値は一度に返す Work Item の最大件数です。
 */
export const WORK_ITEMS_RESPONSE_LIMIT = 200

/** `/api/work-items` が一度に読む Team partition の最大数です。 */
export const WORK_ITEMS_TEAM_READ_LIMIT = 20

/** `/api/work-items` が 1 partition で filter/dedupe 前に評価する最大 item 数です。 */
export const WORK_ITEMS_PARTITION_SCAN_LIMIT = 1_000

/** Relation target の強整合 detail read を同時実行する最大数です。 */
export const WORK_ITEM_RELATION_TARGET_READ_CONCURRENCY = 8

/** Cross-table authorization snapshot を安定化する再読込回数です。 */
export const DOCUMENT_AUTHORIZATION_SNAPSHOT_RETRY_LIMIT = 3

/** Prefix of legacy per-user project directory IDs. */
export const projectDirectoryIdPrefix = 'user#'

/** Enterprise permissions required to read planning data. */
export const ENTERPRISE_PLANNING_READ_PERMISSIONS = [
  'planning.read',
  'work-items.read',
] satisfies readonly EnterprisePermissionId[]

/** Enterprise permissions required to write planning data. */
export const ENTERPRISE_PLANNING_WRITE_PERMISSIONS = [
  'planning.write',
  'work-items.write',
] satisfies readonly EnterprisePermissionId[]

/** Enterprise permissions required to read Work Items. */
export const ENTERPRISE_WORK_ITEM_READ_PERMISSIONS = [
  'work-items.read',
] satisfies readonly EnterprisePermissionId[]

/** Number of attempts to read a stable enterprise service account snapshot. */
export const ENTERPRISE_SERVICE_ACCOUNT_SNAPSHOT_RETRY_LIMIT =
  3
