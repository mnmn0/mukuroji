/** Documents module public application and domain surface. */
export type { DocumentClient } from './documents'
export * from './application/document-use-cases'
export * from './application/ports/document-ports'
export * from './document-types'
export {
  collectDocumentRelationTargets,
  reduceDocumentOperations,
  renderDocumentExport,
  renderDocumentProjectionExport,
  renderPublicDocumentExport,
  validateDocumentPayload,
} from './domain/document-content'
export * from './domain/document-limits'
/** Backfill of the comment thread participant index (ADR 0092). */
export { documentCommentParticipantIndexMigration } from './document-comment-participant-index-migration'
export * from './errors'
