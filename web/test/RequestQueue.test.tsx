import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AiAssistanceGeneration } from '@mukuroji/contracts'
import type { AiAssistanceController } from '../src/features/ai-assistance/mutations/useAiAssistanceController'
import { aiTriageGenerationFixture } from '../src/features/ai-assistance/fixtures'
import { requestSubmissionFixture } from '../src/requests/fixtures'
import { normalizeRequestSubmission } from '../src/requests/model/requestForm'
import { RequestQueue } from '../src/requests/ui/RequestQueue'

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

describe('RequestQueue', () => {
  test('renders historical select labels and exposes a focusable detail control', () => {
    const submission = normalizeRequestSubmission(requestSubmissionFixture)
    const html = renderToStaticMarkup(
      <RequestQueue
        locale="en"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).toContain('>Bug</dd>')
    expect(html).not.toContain('>bug</dd>')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('aria-label="Open request details: プロダクトサポート依頼 v1"')
    expect(submission.formId).toBe(requestSubmissionFixture.formId)
  })

  test('renders every known multi-select option label and preserves unknown legacy values', () => {
    const submission = normalizeRequestSubmission({
      ...requestSubmissionFixture,
      answers: {
        ...requestSubmissionFixture.answers,
        'request-kind': ['bug', 'legacy-option'],
      },
    })
    const html = renderToStaticMarkup(
      <RequestQueue
        locale="ja"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).toContain('>不具合, legacy-option</dd>')
  })

  test('does not expose duplicate-candidate actions without the capability', () => {
    const submission = normalizeRequestSubmission({
      ...requestSubmissionFixture,
      capabilities: {
        ...requestSubmissionFixture.capabilities,
        canMarkDuplicate: false,
      },
    })
    const html = renderToStaticMarkup(
      <RequestQueue
        locale="ja"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).not.toContain('submission-previous')
  })

  test('renders an authorized evidence-first triage draft beside the selected conversion flow', () => {
    const submission = normalizeRequestSubmission(requestSubmissionFixture)
    const html = renderToStaticMarkup(
      <RequestQueue
        accessToken="access-token"
        aiAssistanceController={aiController}
        locale="en"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="ai-triage-composer"')
    expect(html).toContain('Unblock customer Workspace provisioning')
    expect(html).toContain('Provisioning intake source')
    expect(html).not.toContain('Use in conversion form')
  })

  /** Verifies adoption is not offered when a triage draft has no conversion fields. */
  test('does not offer adoption when a triage draft has no conversion fields', () => {
    const submission = normalizeRequestSubmission(requestSubmissionFixture)
    const content = aiTriageGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'triage') {
      throw new Error('Triage fixture must stay available.')
    }
    const emptyTriageGeneration = {
      ...aiTriageGenerationFixture,
      content: {
        ...content,
        draft: {
          kind: 'triage',
          customFields: [],
        },
      },
    } satisfies AiAssistanceGeneration
    const html = renderToStaticMarkup(
      <RequestQueue
        accessToken="access-token"
        aiAssistanceController={{ ...aiController, generation: emptyTriageGeneration }}
        locale="en"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="ai-triage-composer"')
    expect(html).toContain('No applicable field suggestions were returned.')
    expect(html).not.toContain('Use in conversion form')
  })

  test('does not render AI draft markup when conversion capability is absent', () => {
    const submission = normalizeRequestSubmission({
      ...requestSubmissionFixture,
      capabilities: {
        ...requestSubmissionFixture.capabilities,
        canConvert: false,
      },
    })
    const html = renderToStaticMarkup(
      <RequestQueue
        accessToken="access-token"
        aiAssistanceController={aiController}
        locale="en"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).not.toContain('data-testid="ai-triage-composer"')
    expect(html).not.toContain('Unblock customer Workspace provisioning')
    expect(html).not.toContain('Provisioning intake source')
  })

  test('does not expose administrator-only intake AI to a converting non-manager', () => {
    const submission = normalizeRequestSubmission(requestSubmissionFixture)
    const html = renderToStaticMarkup(
      <RequestQueue
        accessToken="access-token"
        canUseAiAssistance={false}
        locale="en"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).toContain('Convert to Work Item')
    expect(html).not.toContain('data-testid="ai-triage-composer"')
    expect(html).not.toContain('Generate draft')
  })
})
