/** SDK-independent normalized page reader owned by the data-integrity module. */
export {
  createCrossDomainIntegrityNormalizedPageReader,
  CrossDomainIntegrityNormalizedPageReaderFailure,
} from './cross-domain-integrity-page-reader'
/** SDK-independent normalized page contracts shared with verifier consumers. */
export type {
  CrossDomainIntegrityNormalizedAuditCandidate,
  CrossDomainIntegrityNormalizedAuditCandidateValue,
  CrossDomainIntegrityNormalizedItem,
  CrossDomainIntegrityNormalizedPage,
  CrossDomainIntegrityNormalizedPageReader,
  CrossDomainIntegrityNormalizedPageReaderConfiguration,
  CrossDomainIntegrityNormalizedPageRequest,
  CrossDomainIntegrityTableNames,
  CrossDomainIntegrityTableTarget,
} from './cross-domain-integrity-page-contract'
/** Pure cross-domain integrity contracts and deterministic checker primitives. */
export * from './cross-domain-integrity-checker'
