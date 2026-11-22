import { describe, expect, test } from 'bun:test'
import type { AiAssistanceProviderCredentials } from '@mukuroji/contracts'
import { mergeProviderCredentialStatuses } from '../src/features/ai-assistance/mutations/useAiProviderCredentialMutations'

/**
 * Builds a key-free status list with the given Claude API and OpenAI revisions.
 *
 * @param anthropicRevision - Claude API key revision; odd means configured.
 * @param openaiRevision - OpenAI key revision; odd means configured.
 * @returns Status list as the server returns it.
 */
function createStatus(anthropicRevision: number, openaiRevision: number): AiAssistanceProviderCredentials {
  return {
    schemaVersion: 1,
    providers: [
      { provider: 'anthropic', deploymentEnabled: true, configured: anthropicRevision % 2 === 1, revision: anthropicRevision },
      { provider: 'openai', deploymentEnabled: true, configured: openaiRevision % 2 === 1, revision: openaiRevision },
    ],
  }
}

describe('mergeProviderCredentialStatuses', () => {
  test('keeps a newer cached provider row when a late response carries an older one', () => {
    const cached = createStatus(1, 1)
    const late = createStatus(0, 1)

    expect(mergeProviderCredentialStatuses(cached, late)).toEqual(createStatus(1, 1))
  })

  test('takes the response when nothing is cached or the response is newer', () => {
    expect(mergeProviderCredentialStatuses(undefined, createStatus(1, 0))).toEqual(createStatus(1, 0))
    expect(mergeProviderCredentialStatuses(createStatus(1, 0), createStatus(2, 1))).toEqual(createStatus(2, 1))
  })
})
