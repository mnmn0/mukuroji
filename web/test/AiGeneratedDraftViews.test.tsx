import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  aiPlanningGenerationFixture,
  aiSummaryGenerationFixture,
} from '../src/features/ai-assistance/fixtures'
import { AiPlanningDraftReview } from '../src/features/ai-assistance/ui/AiPlanningDraftReview'
import { AiSummaryBrief } from '../src/features/ai-assistance/ui/AiSummaryBrief'
import { createTranslator } from '../src/shared/i18n/i18n'

const t = createTranslator('en')
const summaryContent = aiSummaryGenerationFixture.content
const planningContent = aiPlanningGenerationFixture.content

describe('AiSummaryBrief', () => {
  test('keeps claim confidence and direct evidence adjacent in a grounded brief', () => {
    const html = renderToStaticMarkup(
      <AiSummaryBrief
        citations={summaryContent.citations}
        draft={summaryContent.draft}
        t={t}
      />,
    )

    expect(html).toContain(summaryContent.draft.overview.text)
    expect(html).toContain('Medium confidence')
    expect(html).toContain('Launch readiness notes')
    expect(html).toContain('href="/documents/launch-readiness"')
    expect(html).toContain('None identified in the authorized sources.')
  })

  test('fails closed before rendering generated claims when evidence is missing', () => {
    const html = renderToStaticMarkup(
      <AiSummaryBrief citations={[]} draft={summaryContent.draft} t={t} />,
    )

    expect(html).not.toContain(summaryContent.draft.overview.text)
    expect(html).not.toContain('Launch readiness notes')
    expect(html).toContain('safe to review could not be generated')
  })
})

describe('AiPlanningDraftReview', () => {
  test('renders configured status, effort, dependencies, and status update without applying them', () => {
    const html = renderToStaticMarkup(
      <AiPlanningDraftReview
        citations={planningContent.citations}
        draft={planningContent.draft}
        locale="en"
        resolveStatusLabel={(statusId) => statusId === 'review' ? 'In review' : statusId}
        resolveWorkItemLabel={(endpoint) => endpoint.workItemId === 'staged-launch'
          ? 'Staged launch'
          : 'Accessibility review'}
        t={t}
      />,
    )

    expect(html).toContain('Complete launch accessibility review')
    expect(html).toContain('In review')
    expect(html).toContain('4h')
    expect(html).toContain('Accessibility review → Staged launch')
    expect(html).toContain('Finish to start')
    expect(html).toContain('The launch remains staged while accessibility sign-off is completed.')
    expect(html).toContain('Accessibility review Work Item')
  })

  test('fails closed before rendering any proposal when a cited source is unavailable', () => {
    const html = renderToStaticMarkup(
      <AiPlanningDraftReview
        citations={planningContent.citations.filter((citation) => citation.id !== 'citation-plan-1')}
        draft={planningContent.draft}
        locale="en"
        t={t}
      />,
    )

    expect(html).not.toContain('Complete launch accessibility review')
    expect(html).not.toContain('Accessibility review Work Item')
    expect(html).toContain('safe to review could not be generated')
  })
})
