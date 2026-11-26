import type { DataMigrationDeriveDefinition, DataMigrationRow } from '../data-migration'
import {
  DOCUMENT_COMMENT_PARTICIPANT_INDEX_SCHEMA_VERSION,
  commentKey,
  createCommentParticipantIndexItem,
  createCommentParticipantItem,
  normalizeCommentMemberKey,
} from './adapter-out/dynamodb/document-comment-records'

/** Fields of a stored Document comment row that the participant index is derived from. */
type ParticipantSourceComment = {
  /** Workspace partition. */
  workspaceId: string
  /** Comment ID. */
  id: string
  /** Document that owns the comment. */
  documentId: string
  /** Root comment the reply belongs to; absent for a root comment. */
  parentCommentId?: string
  /** Normalized member key of the author. */
  memberKey: string
}

/**
 * Tells whether a value is a non-empty string.
 *
 * @param value - Stored attribute.
 * @returns Whether the value is a string with at least one character.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Reads the fields the participant index needs from a stored Document comment row.
 *
 * @param row - Stored row whose `entryType` is `document-comment`.
 * @returns The fields, or `undefined` when the row does not have the stored comment shape.
 */
function readParticipantSourceComment(row: DataMigrationRow): ParticipantSourceComment | undefined {
  const { workspaceId, recordKey, id, documentId, parentCommentId, authorUserId, createdAt } = row
  if (
    !isNonEmptyString(workspaceId) ||
    !isNonEmptyString(id) ||
    !isNonEmptyString(documentId) ||
    !isNonEmptyString(createdAt) ||
    !isNonEmptyString(authorUserId) ||
    (parentCommentId !== undefined && (!isNonEmptyString(parentCommentId) || parentCommentId === id)) ||
    recordKey !== commentKey(documentId, createdAt, id)
  ) {
    return undefined
  }
  const memberKey = normalizeCommentMemberKey(authorUserId)
  if (!memberKey) return undefined
  return {
    workspaceId,
    id,
    documentId,
    ...(parentCommentId === undefined ? {} : { parentCommentId }),
    memberKey,
  }
}

/**
 * Backfills the thread participant index of Document comments stored before the index existed
 * (ADR 0092).
 *
 * Every comment row is a source. A comment adds its author to the participant rows of its
 * thread, and a root comment also writes the marker that says the thread's index is complete.
 * The marker can be written before the thread's replies are read, so comment creation, the only
 * reader of the index, is paused while the migration runs (`pause-writers`); once it completes,
 * every thread has every participant and its marker.
 */
export const documentCommentParticipantIndexMigration: DataMigrationDeriveDefinition = {
  kind: 'derive',
  id: '0002-document-comment-participant-index',
  description: 'Create the comment thread participant rows and markers that reply notifications read.',
  table: 'documents',
  keyAttributes: ['workspaceId', 'recordKey'],
  versionAttribute: 'schemaVersion',
  fromSchemaVersion: DOCUMENT_COMMENT_PARTICIPANT_INDEX_SCHEMA_VERSION - 1,
  toSchemaVersion: DOCUMENT_COMMENT_PARTICIPANT_INDEX_SCHEMA_VERSION,
  writerPolicy: 'pause-writers',
  classify: (row) => {
    if (row.entryType !== 'document-comment') return 'unrelated'
    return readParticipantSourceComment(row) === undefined ? 'unknown' : 'pending'
  },
  derive: (row) => {
    const comment = readParticipantSourceComment(row)
    if (comment === undefined || row.entryType !== 'document-comment') {
      throw new TypeError('A stored Document comment row is required.')
    }
    const rootCommentId = comment.parentCommentId ?? comment.id
    return [
      createCommentParticipantItem(comment.workspaceId, comment.documentId, rootCommentId, comment.memberKey),
      ...(comment.parentCommentId === undefined
        ? [createCommentParticipantIndexItem(comment.workspaceId, comment.documentId, rootCommentId)]
        : []),
    ]
  },
}
