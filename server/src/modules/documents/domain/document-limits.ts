import { DOCUMENT_OPERATION_BATCH_LIMIT } from '@mukuroji/contracts'

/** DynamoDB item payload limit with headroom below the physical 400 KB limit. */
export const DOCUMENT_MAX_ITEM_BYTES = 350_000

/** Maximum number of operations accepted in one atomic batch. */
export const DOCUMENT_MAX_OPERATION_COUNT = DOCUMENT_OPERATION_BATCH_LIMIT

/** Maximum number of rich-text blocks in one document. */
export const DOCUMENT_MAX_BLOCK_COUNT = 500

/** Maximum number of objects in one whiteboard. */
export const DOCUMENT_MAX_WHITEBOARD_OBJECT_COUNT = 1_000

/** Maximum number of connectors in one whiteboard. */
export const DOCUMENT_MAX_WHITEBOARD_CONNECTOR_COUNT = 2_000

/** Maximum number of frames in one whiteboard. */
export const DOCUMENT_MAX_WHITEBOARD_FRAME_COUNT = 250

/** Maximum supported document-tree depth. */
export const DOCUMENT_MAX_TREE_DEPTH = 32

/** Maximum comment body length. */
export const DOCUMENT_COMMENT_MAX_LENGTH = 20_000

/** Maximum number of mentions stored with one comment. */
export const DOCUMENT_MENTION_MAX_COUNT = 20

/** Maximum page size for document comments. */
export const DOCUMENT_COMMENT_MAX_PAGE_LIMIT = 100

/** Maximum page size for document backlinks. */
export const DOCUMENT_BACKLINK_MAX_PAGE_LIMIT = 50

/** Default number of random bytes in a public-share token. */
export const DOCUMENT_PUBLIC_SHARE_TOKEN_BYTES = 32

/** Maximum public-share lifetime in days. */
export const DOCUMENT_PUBLIC_SHARE_MAX_DAYS = 365

/** Maximum revision interval between full version snapshots. */
export const DOCUMENT_VERSION_SNAPSHOT_INTERVAL = 20

/** Maximum elapsed time between full version snapshots. */
export const DOCUMENT_VERSION_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1_000

/** Retention period for version metadata and deltas. */
export const DOCUMENT_VERSION_RETENTION_DAYS = 180

/** Retention period for operation idempotency receipts. */
export const DOCUMENT_OPERATION_RECEIPT_RETENTION_DAYS = 30

/**
 * Maximum number of relations and Whiteboard Work Item objects per document.
 *
 * Backlink rows are written in the same DynamoDB transaction as the Document
 * change that adds or removes them, so this total is bounded by item size and
 * relation-target validation cost rather than by the transaction size.
 */
export const DOCUMENT_MAX_BACKLINK_COUNT = 500

/**
 * Maximum number of backlink additions and removals in one Document mutation.
 *
 * Each changed Work Item link writes a backlink row and a target fence row in
 * the Document transaction, so this keeps every mutation within DynamoDB's
 * 100-action transaction limit together with the Document, search, version,
 * receipt, and authorization-guard actions. 28 changes use at most 56
 * backlink actions, the same headroom as replacing every link under the
 * former 14-link document limit.
 */
export const DOCUMENT_MAX_BACKLINK_CHANGE_COUNT = 28

/** Maximum text length accepted by document content validators. */
export const DOCUMENT_MAX_TEXT_LENGTH = 50_000

/** Maximum document-title length. */
export const DOCUMENT_MAX_TITLE_LENGTH = 500

/** Maximum number of table columns. */
export const DOCUMENT_MAX_TABLE_COLUMNS = 50

/** Maximum number of table rows. */
export const DOCUMENT_MAX_TABLE_ROWS = 200
