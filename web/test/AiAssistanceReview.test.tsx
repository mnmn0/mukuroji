import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AiAssistanceGeneration } from '@mukuroji/contracts'
import {
  aiSummaryGenerationFixture,
  aiWithheldGenerationFixture,
} from '../src/features/ai-assistance/fixtures'
import { AiAssistanceReview } from '../src/features/ai-assistance/ui/AiAssistanceReview'
import { createTranslator } from '../src/shared/i18n/i18n'

const t = createTranslator('en')

describe('AiAssistanceReview', () => {
  test('keeps evidence, uncertainty, and review actions adjacent to an available draft', () => {
    const html = renderToStaticMarkup(
      <AiAssistanceReview
        generation={aiSummaryGenerationFixture}
        locale="en"
        onAdopt={() => undefined}
        onFeedback={() => undefined}
        onReject={() => undefined}
        renderDraft={({ draft }) => draft.kind === 'summary' ? draft.overview.text : null}
        t={t}
      />,
    )

    expect(html).toContain('The launch review is waiting on the final accessibility sign-off.')
    expect(html).toContain('Launch readiness notes')
    expect(html).toContain('The owner for the final sign-off is not named')
    expect(html).toContain('Adopt draft')
    expect(html).toContain('Reject draft')
    expect(html).toContain('Generation details')
  })

  test('uses instance-unique heading identifiers when multiple assistants share a page', () => {
    const html = renderToStaticMarkup(
      <>
        <AiAssistanceReview
          generation={aiSummaryGenerationFixture}
          locale="en"
          renderDraft={() => null}
          t={t}
        />
        <AiAssistanceReview
          generation={aiSummaryGenerationFixture}
          locale="en"
          renderDraft={() => null}
          t={t}
        />
      </>,
    )
    const identifiers = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1])

    expect(identifiers).toHaveLength(4)
    expect(new Set(identifiers).size).toBe(identifiers.length)
  })

  test('does not invoke the draft renderer or expose evidence after permission loss', () => {
    let renderCalled = false
    const html = renderToStaticMarkup(
      <AiAssistanceReview
        generation={aiWithheldGenerationFixture}
        locale="en"
        renderDraft={() => {
          renderCalled = true
          return 'PROTECTED DRAFT BODY'
        }}
        t={t}
      />,
    )

    expect(renderCalled).toBe(false)
    expect(html).not.toContain('PROTECTED DRAFT BODY')
    expect(html).not.toContain('Launch readiness notes')
    expect(html).not.toContain('Accessibility sign-off remains')
    expect(html).toContain('unavailable because access changed')
  })

  test('fails closed when any available citation has an unsafe path', () => {
    let renderCalled = false
    const unsafeGeneration = {
      ...aiSummaryGenerationFixture,
      content: aiSummaryGenerationFixture.content.availability === 'available'
        ? {
            ...aiSummaryGenerationFixture.content,
            citations: [{
              ...aiSummaryGenerationFixture.content.citations[0],
              href: '//attacker.example/secret',
              label: 'PROTECTED SOURCE LABEL',
              excerpt: 'PROTECTED SOURCE EXCERPT',
            }],
          }
        : aiSummaryGenerationFixture.content,
    }
    const html = renderToStaticMarkup(
      <AiAssistanceReview
        generation={unsafeGeneration}
        locale="en"
        renderDraft={() => {
          renderCalled = true
          return 'PROTECTED GENERATED TEXT'
        }}
        t={t}
      />,
    )

    expect(renderCalled).toBe(false)
    expect(html).not.toContain('PROTECTED GENERATED TEXT')
    expect(html).not.toContain('PROTECTED SOURCE LABEL')
    expect(html).not.toContain('PROTECTED SOURCE EXCERPT')
    expect(html).toContain('safe to review could not be generated')
  })

  /** Verifies the review uses the label belonging to the active workflow. */
  test('uses the active workflow label while generating', () => {
    const html = renderToStaticMarkup(
      <AiAssistanceReview
        generatingLabel="Generating brief"
        isGenerating
        locale="en"
        renderDraft={() => null}
        t={t}
      />,
    )

    expect(html).toContain('Generating brief')
    expect(html).not.toContain('Generating filters')
  })

  test('shows the dedicated rate-limit guidance without rendering a successful draft', () => {
    const html = renderToStaticMarkup(
      <AiAssistanceReview
        errorKind="rate-limit"
        generation={aiSummaryGenerationFixture}
        locale="en"
        onAdopt={() => undefined}
        renderDraft={() => 'PROTECTED GENERATED TEXT'}
        t={t}
      />,
    )

    expect(html).toContain('AI assistance has reached its usage limit')
    expect(html).not.toContain('PROTECTED GENERATED TEXT')
    expect(html).not.toContain('Adopt draft')
  })

  test('keeps a reviewed draft actionable after an ambiguous retryable failure', () => {
    const html = renderToStaticMarkup(
      <AiAssistanceReview
        errorKind="generic"
        generation={aiSummaryGenerationFixture}
        locale="en"
        onAdopt={() => undefined}
        renderDraft={() => 'RETRYABLE GENERATED TEXT'}
        t={t}
      />,
    )

    expect(html).toContain('The AI draft could not be generated. Try again.')
    expect(html).toContain('RETRYABLE GENERATED TEXT')
    expect(html).toContain('Adopt draft')
  })

  /** Verifies rejected decisions are visually distinct from accepted decisions. */
  test('renders a rejected decision with the danger treatment', () => {
    const rejectedGeneration = {
      ...aiSummaryGenerationFixture,
      decision: {
        outcome: 'rejected',
        decidedAt: '2026-08-25T02:05:00.000Z',
      },
    } satisfies AiAssistanceGeneration
    const html = renderToStaticMarkup(
      <AiAssistanceReview
        generation={rejectedGeneration}
        locale="en"
        renderDraft={({ draft }) => draft.kind === 'summary' ? draft.overview.text : null}
        t={t}
      />,
    )

    expect(html).toContain('text-[var(--workbench-danger)]')
    expect(html).toContain('Recorded as rejected.')
    expect(html).toContain('aria-hidden="true" class="inline-flex')
    expect(html).toContain('>!</span>')
    expect(html).not.toContain('text-[var(--workbench-success)]')
  })
})
