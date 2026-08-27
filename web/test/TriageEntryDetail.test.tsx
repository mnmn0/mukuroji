import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AiAssistanceGeneration } from '@mukuroji/contracts'
import type { AiAssistanceController } from '../src/features/ai-assistance/mutations/useAiAssistanceController'
import { aiTriageGenerationFixture } from '../src/features/ai-assistance/fixtures'
import { createTranslator } from '../src/shared/i18n/i18n'
import { triageEntryFixtures } from '../src/triage/fixtures'
import { createTriageEntryView } from '../src/triage/model/triageView'
import { TriageEntryDetail } from '../src/triage/ui/TriageEntryDetail'

const aiController: AiAssistanceController = {
  cancelGeneration: () => undefined,
  decide: async () => undefined,
  generate: async () => aiTriageGenerationFixture,
  generation: aiTriageGenerationFixture,
  isDecisionPending: false,
  isFeedbackPending: false,
  isGenerating: false,
  reset: () => undefined,
  sendFeedback: async () => undefined,
}

describe('TriageEntryDetail', () => {
  test('renders source trace and safe action forms for full visibility', () => {
    const entry = triageEntryFixtures[0]
    if (!entry) throw new Error('Expected a triage fixture.')
    const html = renderToStaticMarkup(
      <TriageEntryDetail
        accessToken="access-token"
        aiAssistanceController={aiController}
        locale="en"
        t={createTranslator('en')}
        teamId="core-team"
        view={createTriageEntryView(entry)}
        onBack={() => undefined}
      />,
    )

    expect(html).toContain('Workspace provisioning blocks customer launch')
    expect(html).toContain('Open original source')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).toContain('Accept')
    expect(html).toContain('Change routing')
    expect(html).toContain('Request information')
    expect(html).toContain('data-testid="ai-triage-composer"')
    expect(html).toContain('Unblock customer Workspace provisioning')
    expect(html).toContain('Provisioning intake source')
  })

  test('does not render source body, email, routing, or reply action for metadata-only access', () => {
    const entry = triageEntryFixtures[1]
    if (!entry) throw new Error('Expected a triage fixture.')
    const html = renderToStaticMarkup(
      <TriageEntryDetail
        accessToken="access-token"
        aiAssistanceController={aiController}
        locale="en"
        t={createTranslator('en')}
        teamId="core-team"
        view={createTriageEntryView(entry)}
        onBack={() => undefined}
      />,
    )

    expect(html).not.toContain('This body must not be rendered')
    expect(html).not.toContain('Billing mailbox default route')
    expect(html).not.toContain('Request information')
    expect(html).not.toContain('data-testid="ai-triage-composer"')
    expect(html).not.toContain('Unblock customer Workspace provisioning')
    expect(html).not.toContain('Provisioning intake source')
    expect(html).toContain('Metadata only')
  })

  test('does not leak denied source title or body into the detail DOM', () => {
    const entry = triageEntryFixtures[3]
    if (!entry) throw new Error('Expected a triage fixture.')
    const html = renderToStaticMarkup(
      <TriageEntryDetail
        accessToken="access-token"
        aiAssistanceController={aiController}
        locale="en"
        t={createTranslator('en')}
        teamId="core-team"
        view={createTriageEntryView(entry)}
        onBack={() => undefined}
      />,
    )

    expect(html).not.toContain('This denied title must never render')
    expect(html).not.toContain('This denied body must never render')
    expect(html).not.toContain('data-testid="ai-triage-composer"')
    expect(html).not.toContain('Unblock customer Workspace provisioning')
    expect(html).not.toContain('Provisioning intake source')
    expect(html).toContain('Source unavailable')
    expect(html).toContain('No actions are available')
  })

  test('keeps a queue back action when a deep-linked entry is unavailable', () => {
    const html = renderToStaticMarkup(
      <TriageEntryDetail
        errorMessage="Entry unavailable"
        locale="en"
        onBack={() => undefined}
        t={createTranslator('en')}
        teamId="core-team"
        view={undefined}
      />,
    )

    expect(html).toContain('Entry unavailable')
    expect(html).toContain('Back to queue')
  })

  test('does not offer assignee-only adoption without Assign capability', () => {
    const entry = triageEntryFixtures[0]
    if (!entry) throw new Error('Expected a triage fixture.')
    const content = aiTriageGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'triage') {
      throw new Error('Triage fixture must stay available.')
    }
    const assigneeOnlyGeneration: AiAssistanceGeneration = {
      ...aiTriageGenerationFixture,
      content: {
        ...content,
        draft: {
          assigneeUserId: content.draft.assigneeUserId,
          customFields: [],
          kind: 'triage',
        },
      },
    }
    const html = renderToStaticMarkup(
      <TriageEntryDetail
        accessToken="access-token"
        aiAssistanceController={{
          ...aiController,
          generation: assigneeOnlyGeneration,
        }}
        locale="en"
        t={createTranslator('en')}
        teamId="core-team"
        view={createTriageEntryView({
          ...entry,
          capabilities: {
            ...entry.capabilities,
            canAcceptCreate: true,
            canAssign: false,
          },
        })}
        onBack={() => undefined}
      />,
    )

    expect(html).toContain('member-ada')
    expect(html).not.toContain('Use in Accept / Assign form')
  })

  test('keeps the AI composer startable while a parent operation fence is active', () => {
    const entry = triageEntryFixtures[0]
    if (!entry) throw new Error('Expected a triage fixture.')
    const generateLabel = createTranslator('en')('ai.triage.generate')
    const html = renderToStaticMarkup(
      <TriageEntryDetail
        accessToken="access-token"
        aiAssistanceController={aiController}
        isAiOperationPending
        locale="en"
        t={createTranslator('en')}
        teamId="core-team"
        view={createTriageEntryView(entry)}
        onBack={() => undefined}
      />,
    )

    const generateButton = html.match(
      new RegExp(`<button[^>]*>${generateLabel}</button>`),
    )?.[0]
    expect(generateButton).toBeDefined()
    expect(generateButton).not.toContain('disabled=""')
    expect(html).toContain('disabled="" type="button">Change routing')
  })
})
