import { type EnterprisePermissionId } from '@mukuroji/contracts'
import {
  type WorkspaceActiveMemberConditionOptions,
} from '../../modules/workspace-access/workspace-access'

/** Workspace roles that may perform a Team Triage mutation. */
export const TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS: WorkspaceActiveMemberConditionOptions = {
  allowedRoles: ['owner', 'admin', 'member'],
}

/**
 * `limit` も `cursor` も付けない旧来の `/api/work-items` が一度に返す Work Item の最大件数です。
 * 旧 client は続きを読めないため、超過時は部分応答にせず 413 で fail-closed にします。
 * 新しい client は cursor 付きの page か `/api/work-items/summary` を使います。
 */
export const WORK_ITEMS_RESPONSE_LIMIT = 200

/** Planning publish と Task view の relation 解決が一度に読む Team partition の最大数です。 */
export const WORK_ITEMS_TEAM_READ_LIMIT = 20

/** Automation と Planning publish が 1 partition で filter/dedupe 前に評価する最大 item 数です。 */
export const WORK_ITEMS_PARTITION_SCAN_LIMIT = 1_000

/** Workspace 横断の Work Item 集約読み取りが対象にできる Team partition の最大数です。 */
export const WORK_ITEMS_AGGREGATE_TEAM_LIMIT = 100

/**
 * 全件をメモリに載せる集約読み取り（Focus、Planning snapshot、AI assistance）が保持する
 * Work Item の最大件数です。超過時は 413 で fail-closed にします。
 */
export const WORK_ITEMS_AGGREGATE_ITEM_LIMIT = 10_000

/** 件数だけを数える `/api/work-items/summary` が評価する Work Item row の最大数です。 */
export const WORK_ITEMS_SUMMARY_SCAN_LIMIT = 20_000

/** 集約読み取りが 1 回の DynamoDB Query で読む Work Item の最大件数です。 */
export const WORK_ITEMS_AGGREGATE_READ_PAGE_SIZE = 500

/** 集約読み取りが同時に読む Team partition の数です。 */
export const WORK_ITEMS_AGGREGATE_READ_CONCURRENCY = 8

/**
 * cursor 付き `/api/work-items` が 1 request で評価する Work Item row の最大数です。
 * 到達すると条件に合う件数が `limit` 未満でも continuation 付きで応答します。
 */
export const WORK_ITEMS_PAGE_SCAN_BUDGET = 2_000

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
