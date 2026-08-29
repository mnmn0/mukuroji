import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SearchCustomFieldFilter } from '@mukuroji/contracts'
import {
  aiSearchGenerationFixture,
  aiWithheldGenerationFixture,
} from '../src/features/ai-assistance/fixtures'
import { createTranslator } from '../src/shared/i18n/i18n'
import { isAiSearchPromptCurrent } from '../src/search/model/aiSearchApplication'
import { NaturalLanguageSearchComposerView } from '../src/search/ui/NaturalLanguageSearchComposer'

describe('NaturalLanguageSearchComposerView', () => {
  test('renders generated filters as editable controls before apply', () => {
    const html = renderToStaticMarkup(
      <NaturalLanguageSearchComposerView
        generation={aiSearchGenerationFixture}
        locale="en"
        onApply={() => undefined}
        onDecide={async () => undefined}
        onGenerate={() => undefined}
        t={createTranslator('en')}
      />,
    )

    expect(html).toContain('Find incomplete Work Items updated this month')
    expect(html).toContain('todo, in-progress')
    expect(html).toContain('core-team')
    expect(html).toContain('2026-08-01')
    expect(html).toContain('Apply filters')
    expect(html).toContain('“Incomplete” was mapped')
    expect(html).toContain('Group by Team ID')
  })

  /** Verifies equivalent custom-field filters remain adoptable despite response key order. */
  test('does not treat custom-field property order as an edited filter', () => {
    const content = aiSearchGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'search') {
      throw new Error('Search fixture must stay available.')
    }
    const customField: SearchCustomFieldFilter = {
      value: 'enterprise',
      operator: 'equals',
      fieldId: 'customer-segment',
    }
    const generation = {
      ...aiSearchGenerationFixture,
      content: {
        ...content,
        draft: {
          ...content.draft,
          filters: { ...content.draft.filters, customFields: [customField] },
        },
      },
    }

    const html = renderToStaticMarkup(
      <NaturalLanguageSearchComposerView
        generation={generation}
        locale="en"
        onApply={() => undefined}
        onDecide={async () => undefined}
        onGenerate={() => undefined}
        t={createTranslator('en')}
      />,
    )

    expect(html).toContain('Apply filters')
    expect(html).not.toContain('Filters changed after generation')
  })

  test('renders permission errors without a generated draft surface', () => {
    const html = renderToStaticMarkup(
      <NaturalLanguageSearchComposerView
        error={{ kind: 'permission' }}
        locale="en"
        onApply={() => undefined}
        onDecide={async () => undefined}
        onGenerate={() => undefined}
        t={createTranslator('en')}
      />,
    )

    expect(html).toContain('do not allow AI assistance')
    expect(html).not.toContain('Apply filters')
  })

  test('explains a withheld generation without exposing or applying its draft', () => {
    const html = renderToStaticMarkup(
      <NaturalLanguageSearchComposerView
        generation={aiWithheldGenerationFixture}
        locale="en"
        onApply={() => undefined}
        onDecide={async () => undefined}
        onGenerate={() => undefined}
        t={createTranslator('en')}
      />,
    )

    expect(html).toContain('unavailable because access changed')
    expect(html).not.toContain('Apply filters')
    expect(html).not.toContain('accessibility sign-off')
  })

  test('matches a draft only to the natural-language prompt that produced it', () => {
    expect(isAiSearchPromptCurrent('find overdue work', 'find overdue work')).toBe(true)
    expect(isAiSearchPromptCurrent('find overdue work', 'find recently overdue work')).toBe(false)
    expect(isAiSearchPromptCurrent('find overdue work', '  find overdue work  ')).toBe(true)
    expect(isAiSearchPromptCurrent(undefined, 'new request')).toBe(true)
  })
})
