import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  aiAssistancePolicyFixture,
  aiAssistancePreferenceFixture,
} from '../src/features/ai-assistance/fixtures'
import { AiAssistanceSettingsPanel } from '../src/features/ai-assistance/ui/AiAssistanceSettingsPanel'
import { createTranslator } from '../src/shared/i18n/i18n'

const t = createTranslator('en')

describe('AiAssistanceSettingsPanel', () => {
  test('renders personal opt-out for a member without manager policy controls or values', () => {
    const html = renderToStaticMarkup(
      <AiAssistanceSettingsPanel
        canManagePolicy={false}
        onPreferenceChange={() => undefined}
        onPreferenceSave={() => undefined}
        policy={aiAssistancePolicyFixture}
        preference={aiAssistancePreferenceFixture}
        t={t}
      />,
    )

    expect(html).toContain('Use AI assistance for my account')
    expect(html).toContain('Save personal setting')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save personal setting<\/button>/)
    expect(html).not.toContain('Allowed Bedrock model IDs')
    expect(html).not.toContain(aiAssistancePolicyFixture.defaultModelId)
  })

  test('enables each save action only for its own changed draft', () => {
    const html = renderToStaticMarkup(
      <AiAssistanceSettingsPanel
        canManagePolicy
        isPolicyDirty
        isPreferenceDirty
        onPolicyChange={() => undefined}
        onPolicySave={() => undefined}
        onPreferenceChange={() => undefined}
        onPreferenceSave={() => undefined}
        policy={{ ...aiAssistancePolicyFixture, retentionDays: 45 }}
        preference={{ ...aiAssistancePreferenceFixture, enabled: false }}
        t={t}
      />,
    )

    expect(html).toMatch(/<button(?![^>]*\sdisabled="")[^>]*>Save personal setting<\/button>/)
    expect(html).toMatch(/<button(?![^>]*\sdisabled="")[^>]*>Save Workspace policy<\/button>/)
  })

  test('renders the complete revisioned Bedrock policy for an administrator', () => {
    const html = renderToStaticMarkup(
      <AiAssistanceSettingsPanel
        canManagePolicy
        onPolicyChange={() => undefined}
        onPolicySave={() => undefined}
        onPreferenceChange={() => undefined}
        onPreferenceSave={() => undefined}
        policy={aiAssistancePolicyFixture}
        preference={aiAssistancePreferenceFixture}
        t={t}
      />,
    )

    expect(html).toContain('Workspace policy')
    expect(html).toContain('Allowed Bedrock model IDs')
    expect(html).toContain('Revision 4')
    expect(html).toContain('Save Workspace policy')
    expect(html).toContain(aiAssistancePolicyFixture.defaultModelId)
  })

  test('scopes revision-conflict feedback to the policy save action', () => {
    const html = renderToStaticMarkup(
      <AiAssistanceSettingsPanel
        canManagePolicy
        onPolicyChange={() => undefined}
        onPolicySave={() => undefined}
        onPreferenceChange={() => undefined}
        onPreferenceSave={() => undefined}
        policy={aiAssistancePolicyFixture}
        policyFeedback="conflict"
        preference={aiAssistancePreferenceFixture}
        t={t}
      />,
    )

    expect(html).toContain('These settings changed. Review the latest values before saving again.')
    expect(html).toContain('role="alert"')
  })

  test('preserves a stale policy draft behind an explicit latest-value action', () => {
    const html = renderToStaticMarkup(
      <AiAssistanceSettingsPanel
        canManagePolicy
        hasPolicyRevisionConflict
        isPolicyDirty
        onPolicyChange={() => undefined}
        onPolicySave={() => undefined}
        onPolicyUseLatest={() => undefined}
        onPreferenceChange={() => undefined}
        onPreferenceSave={() => undefined}
        policy={{ ...aiAssistancePolicyFixture, retentionDays: 45 }}
        policyFeedback="conflict"
        preference={aiAssistancePreferenceFixture}
        t={t}
      />,
    )

    expect(html).toContain('value="45"')
    expect(html).toContain('Discard local changes and show latest')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save Workspace policy<\/button>/)
  })

  test('keeps personal opt-out available while the manager policy loads', () => {
    const html = renderToStaticMarkup(
      <AiAssistanceSettingsPanel
        canManagePolicy
        isPolicyLoading
        onPreferenceChange={() => undefined}
        onPreferenceSave={() => undefined}
        preference={aiAssistancePreferenceFixture}
        t={t}
      />,
    )

    expect(html).toContain('Use AI assistance for my account')
    expect(html).toContain('Loading Workspace policy')
    expect(html).not.toContain('AI assistance settings could not be loaded')
  })
})
