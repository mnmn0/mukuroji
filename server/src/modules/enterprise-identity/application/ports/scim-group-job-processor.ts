import type {
  EnterpriseScimGroupJobReference,
} from '../../domain/scim-group-job-reference'

/**
 * Enterprise SCIM group reconciliation job processor の application port です。
 */
export interface EnterpriseScimGroupJobProcessor {
  /** Durable state を一度読み、一つの bounded job page を処理します。 */
  processJob(reference: EnterpriseScimGroupJobReference): Promise<unknown>
}
