/** Documents module public application and domain surface. */
export {
  DocumentError,
  validateDocumentPayload,
  type DocumentClient,
  type DocumentManagerLifecycleSnapshot,
} from './documents'
export {
  createDocumentAuthorizationRevisionPut,
  type DocumentAuthorizationRevisionGuard,
} from './document-authorization'
