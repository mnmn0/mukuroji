import type { AiAssistanceGeneration } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { aiSearchGenerationFixture } from '../../features/ai-assistance/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import { NaturalLanguageSearchComposerView } from './NaturalLanguageSearchComposer'

const applyFilters = fn()
const generateFilters = fn()
const recordFeedback = fn()
const decideGeneration = fn(async (
  outcome: 'approved' | 'rejected',
): Promise<AiAssistanceGeneration> => ({
  ...aiSearchGenerationFixture,
  revision: aiSearchGenerationFixture.revision + 1,
  decision: {
    outcome,
    decidedAt: '2026-08-25T02:05:00.000Z',
  },
}))

/** Storybook metadata for the focused plain-language Search composer. */
const meta = {
  title: 'Application/Search/Plain Language Composer',
  component: NaturalLanguageSearchComposerView,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-canvas)] p-6 max-[480px]:p-3">
        <section className="workbench-toolbar mx-auto max-w-5xl p-5 max-[480px]:p-4">
          <Story />
        </section>
      </main>
    ),
  ],
  args: {
    canGenerate: true,
    generation: aiSearchGenerationFixture,
    locale: 'en',
    onApply: applyFilters,
    onDecide: decideGeneration,
    onFeedback: recordFeedback,
    onGenerate: generateFilters,
    t: createTranslator('en'),
  },
} satisfies Meta<typeof NaturalLanguageSearchComposerView>

export default meta

/** Story type for the focused plain-language composer. */
type Story = StoryObj<typeof meta>

/** Editable generated filters remain local until review approval succeeds. */
export const ReviewAndApply: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    applyFilters.mockClear()
    decideGeneration.mockClear()
    await userEvent.clear(canvas.getByLabelText('Search workspace'))
    await userEvent.type(canvas.getByLabelText('Search workspace'), 'launch')
    await expect(applyFilters).not.toHaveBeenCalled()
    await expect(canvas.getByText('Filters changed after generation. Restore the generated filters or generate again before applying.')).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: 'Restore generated filters' }))
    await expect(canvas.getByLabelText('Search workspace')).toHaveValue('')
    await userEvent.click(canvas.getByRole('button', { name: 'Apply filters' }))
    await expect(decideGeneration).toHaveBeenCalledWith('approved')
    await expect(applyFilters).toHaveBeenCalledWith({
      filters: expect.objectContaining({ statuses: ['todo', 'in-progress'] }),
      report: { groupBy: 'team', metric: 'count' },
    })
  },
}

/** Generation is issued only after the operator submits a non-empty natural-language request. */
export const ExplicitGenerate: Story = {
  args: { generation: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    generateFilters.mockClear()
    applyFilters.mockClear()
    await expect(canvas.getByRole('button', { name: 'Generate filters' })).toBeDisabled()
    await userEvent.type(
      canvas.getByLabelText('Create search filters from plain language'),
      'Open Work Items updated this week',
    )
    await expect(generateFilters).not.toHaveBeenCalled()
    await userEvent.click(canvas.getByRole('button', { name: 'Generate filters' }))
    await expect(generateFilters).toHaveBeenCalledWith('Open Work Items updated this week')
    await expect(applyFilters).not.toHaveBeenCalled()
  },
}

/** Mobile filter review uses stacked controls and full-width primary actions. */
export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
}
