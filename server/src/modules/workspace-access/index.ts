/** Workspace Access module public application and domain surface. */
export type { WorkspaceRole } from './domain/workspace-role'
export * from './workspace-access'
export {
  requirePrivateDocumentManagerContinuity,
  type DocumentManagerLifecycleDependencies,
} from './document-manager-lifecycle'
