import type { DataMigrationDeriveDefinition } from '../data-migration'
import { isCanonicalWorkItemRecord } from './canonical-work-item'
import { isWorkItemKeyRegistryRecord } from './adapter-out/dynamodb/work-item-key-registry'
import {
  WORK_ITEM_MEMBER_INDEX_SCHEMA_VERSION,
  createWorkItemMemberIndexRecords,
  isWorkItemMemberIndexRecord,
} from './work-item-member-index'

/**
 * Backfills the member index rows of Work Items stored before the index existed (ADR 0038).
 *
 * Every canonical Work Item row is a source; its index rows are written in one transaction that
 * checks the Work Item still has the revision that was read, so a concurrent reassignment is never
 * overwritten by a stale index row. Key registry and index rows are other entities of the table.
 */
export const workItemMemberIndexMigration: DataMigrationDeriveDefinition = {
  kind: 'derive',
  id: '0001-work-item-member-index',
  description: 'Create the member index rows that Focus reads owned and contributed Work Items from.',
  table: 'work-items',
  keyAttributes: ['directoryTeamId', 'issueId'],
  versionAttribute: 'schemaVersion',
  fromSchemaVersion: WORK_ITEM_MEMBER_INDEX_SCHEMA_VERSION - 1,
  toSchemaVersion: WORK_ITEM_MEMBER_INDEX_SCHEMA_VERSION,
  writerPolicy: 'revision-fenced',
  revisionAttribute: 'revision',
  classify: (row) => {
    if (isWorkItemMemberIndexRecord(row) || isWorkItemKeyRegistryRecord(row)) return 'unrelated'
    return isCanonicalWorkItemRecord(row) ? 'pending' : 'unknown'
  },
  derive: (row) => {
    if (!isCanonicalWorkItemRecord(row)) throw new TypeError('A canonical Work Item row is required.')
    return createWorkItemMemberIndexRecords(row.directoryId, row.teamId, row.issueId, row)
  },
}
