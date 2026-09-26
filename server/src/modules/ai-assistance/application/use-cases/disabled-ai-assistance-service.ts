import type { AiAssistanceService } from '../ports/ai-assistance-ports'
import { AiAssistanceError } from '../../errors'

/**
 * Creates the deployment-disabled AI service without provider or storage access.
 *
 * @returns A service that disables UI preferences and rejects every AI operation.
 */
export function createDisabledAiAssistanceService(): AiAssistanceService {
  /** Rejects operations that require a configured deployment model. */
  const rejectDisabled = async (): Promise<never> => {
    throw new AiAssistanceError(
      'authorization',
      'AiAssistanceDisabled',
      'AI assistance is not configured for this deployment.',
    )
  }
  return {
    getPolicy: rejectDisabled,
    updatePolicy: rejectDisabled,
    /** Returns an effective opt-out so workflow controls remain hidden. */
    async getPreference() {
      return {
        schemaVersion: 1,
        deploymentEnabled: false,
        enabled: false,
        revision: 0,
        updatedAt: '1970-01-01T00:00:00.000Z',
      }
    },
    updatePreference: rejectDisabled,
    generate: rejectDisabled,
    generateWithMetadata: rejectDisabled,
    getGeneration: rejectDisabled,
    decideGeneration: rejectDisabled,
    createFeedback: rejectDisabled,
  }
}
