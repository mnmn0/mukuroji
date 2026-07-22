/** Documents module public application and domain surface. */
export type { DocumentClient } from './documents'
export * from './application/document-use-cases'
export * from './application/ports/document-ports'
export * from './document-types'
export {
  collectDocumentRelationTargets,
  reduceDocumentOperations,
  renderDocumentExport,
  renderPublicDocumentExport,
  validateDocumentPayload,
} from './domain/document-content'
export * from './domain/document-limits'
export * from './errors'
export {
  createDocumentAuthorizationRevisionPut,
  type DocumentAuthorizationRevisionGuard,
} from './adapter-out/dynamodb/document-authorization'
