import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { aiProviderCredentialsFixture } from '../src/features/ai-assistance/fixtures'
import type { AiProviderCredentialMutations } from '../src/features/ai-assistance/mutations/useAiProviderCredentialMutations'
import { AiProviderCredentialsView } from '../src/features/ai-assistance/ui/AiProviderCredentialsSection'
import { createTranslator } from '../src/shared/i18n/i18n'

const t = createTranslator('en')
const mutations: AiProviderCredentialMutations = {
  saveKey: async () => 'saved',
  removeKey: async () => 'removed',
}

describe('AiProviderCredentialsView', () => {
  test('shows only the last four characters of a registered key', () => {
    const html = renderToStaticMarkup(
      <AiProviderCredentialsView
        credentials={aiProviderCredentialsFixture}
        loadFailed={false}
        mutations={mutations}
        onRetry={() => undefined}
        t={t}
      />,
    )
    expect(html).toContain('Registered (ends in WXYZ)')
    expect(html).toContain('Not registered')
    expect(html).toContain('type="password"')
    expect(html).toContain('Replace')
    expect(html).toContain('Remove')
  })

  test('hides itself when the deployment enables no external provider', () => {
    const html = renderToStaticMarkup(
      <AiProviderCredentialsView
        credentials={{
          schemaVersion: 1,
          providers: aiProviderCredentialsFixture.providers.map((status) => ({
            ...status,
            deploymentEnabled: false,
          })),
        }}
        loadFailed={false}
        mutations={mutations}
        onRetry={() => undefined}
        t={t}
      />,
    )
    expect(html).toBe('')
  })

  test('offers a retry when the status request failed', () => {
    const html = renderToStaticMarkup(
      <AiProviderCredentialsView
        loadFailed
        mutations={mutations}
        onRetry={() => undefined}
        t={t}
      />,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('Reload')
  })
})
