/**
 * Keys and rows of Document comments and their thread participant index (ADR 0092), shared by the
 * DynamoDB client that writes them live and the migration that derives them from older comments,
 * so both write the same rows.
 */

/** Stored schema version of a participant row and of a completion marker. */
export const DOCUMENT_COMMENT_PARTICIPANT_INDEX_SCHEMA_VERSION = 1

/**
 * Participant index row of one comment thread: one row per member who wrote in it, so reply
 * notifications read the thread's participants without scanning the Document's comments.
 */
export type StoredDocumentCommentParticipantItem = {
  /** Canonical Workspace partition key. */
  workspaceId: string
  /** Sort key from the Document, the root comment, and the member. */
  recordKey: string
  /** Row discriminator. */
  entryType: 'document-comment-participant'
  /** Document that owns the thread. */
  documentId: string
  /** Root comment of the thread. */
  rootCommentId: string
  /** Normalized member key of the participant. */
  memberKey: string
  /** Stored schema version, {@link DOCUMENT_COMMENT_PARTICIPANT_INDEX_SCHEMA_VERSION}. */
  schemaVersion: number
}

/**
 * Marks a thread whose participant index is complete: written with a new root, after an older
 * thread's participants were all backfilled, or by the migration. Kept apart from the participant
 * rows, so a reply by the root author never marks an incomplete older thread as complete.
 */
export type StoredDocumentCommentParticipantIndexItem = {
  /** Canonical Workspace partition key. */
  workspaceId: string
  /** Sort key from the Document and the root comment. */
  recordKey: string
  /** Row discriminator. */
  entryType: 'document-comment-participant-index'
  /** Document that owns the thread. */
  documentId: string
  /** Root comment of the thread. */
  rootCommentId: string
  /** Stored schema version, {@link DOCUMENT_COMMENT_PARTICIPANT_INDEX_SCHEMA_VERSION}. */
  schemaVersion: number
}

/**
 * Encodes one identifier for use inside a Documents table sort key.
 *
 * @param value - Identifier.
 * @returns The base64url encoding of its UTF-8 bytes.
 */
export function encodeKeyPart(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/**
 * Builds the sort key of one Document comment row.
 *
 * @param documentId - Document that owns the comment.
 * @param createdAt - ISO creation time of the comment.
 * @param commentId - Comment ID.
 * @returns The time-ordered comment sort key.
 */
export function commentKey(documentId: string, createdAt: string, commentId: string): string {
  return `COMMENT#${encodeKeyPart(documentId)}#${createdAt}#${encodeKeyPart(commentId)}`
}

/**
 * Normalizes a comment author or mention member key for comparisons.
 *
 * @param memberKey - Stored or requested member key.
 * @returns Trimmed lowercase member key.
 */
export function normalizeCommentMemberKey(memberKey: string): string {
  return memberKey.trim().toLowerCase()
}

/**
 * Builds the sort key prefix of one thread's participant index.
 *
 * @param documentId - Document that owns the thread.
 * @param rootCommentId - Root comment of the thread.
 * @returns The prefix shared by the thread's participant rows.
 */
export function commentParticipantPrefix(documentId: string, rootCommentId: string): string {
  return `COMMENT_PARTICIPANT#${encodeKeyPart(documentId)}#${encodeKeyPart(rootCommentId)}#`
}

/**
 * Builds the sort key of one thread participant row.
 *
 * @param documentId - Document that owns the thread.
 * @param rootCommentId - Root comment of the thread.
 * @param memberKey - Normalized participant member key.
 * @returns The participant row sort key.
 */
export function commentParticipantKey(documentId: string, rootCommentId: string, memberKey: string): string {
  return `${commentParticipantPrefix(documentId, rootCommentId)}${encodeKeyPart(memberKey)}`
}

/**
 * Builds the sort key of the marker of a thread whose participant index is complete.
 *
 * @param documentId - Document that owns the thread.
 * @param rootCommentId - Root comment of the thread.
 * @returns The marker sort key.
 */
export function commentParticipantIndexKey(documentId: string, rootCommentId: string): string {
  return `COMMENT_PARTICIPANT_INDEX#${encodeKeyPart(documentId)}#${encodeKeyPart(rootCommentId)}`
}

/**
 * Builds the participant row of one member in one thread.
 *
 * @param workspaceId - Workspace partition.
 * @param documentId - Document that owns the thread.
 * @param rootCommentId - Root comment of the thread.
 * @param memberKey - Normalized participant member key.
 * @returns The participant row.
 */
export function createCommentParticipantItem(
  workspaceId: string,
  documentId: string,
  rootCommentId: string,
  memberKey: string,
): StoredDocumentCommentParticipantItem {
  return {
    workspaceId,
    recordKey: commentParticipantKey(documentId, rootCommentId, memberKey),
    entryType: 'document-comment-participant',
    documentId,
    rootCommentId,
    memberKey,
    schemaVersion: DOCUMENT_COMMENT_PARTICIPANT_INDEX_SCHEMA_VERSION,
  }
}

/**
 * Builds the completion marker of one thread's participant index.
 *
 * @param workspaceId - Workspace partition.
 * @param documentId - Document that owns the thread.
 * @param rootCommentId - Root comment of the thread.
 * @returns The marker row.
 */
export function createCommentParticipantIndexItem(
  workspaceId: string,
  documentId: string,
  rootCommentId: string,
): StoredDocumentCommentParticipantIndexItem {
  return {
    workspaceId,
    recordKey: commentParticipantIndexKey(documentId, rootCommentId),
    entryType: 'document-comment-participant-index',
    documentId,
    rootCommentId,
    schemaVersion: DOCUMENT_COMMENT_PARTICIPANT_INDEX_SCHEMA_VERSION,
  }
}
