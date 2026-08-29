import type { Meta, StoryObj } from '@storybook/react-vite'
import { aiSummaryGenerationFixture } from '../fixtures'
import { createTranslator } from '../../../shared/i18n/i18n'
import { AiSummaryBrief } from './AiSummaryBrief'

const summaryContent = aiSummaryGenerationFixture.content

/** Storybook metadata for the reusable grounded summary brief. */
const meta = {
  title: 'Application/AI Assistance/Summary Brief',
  component: AiSummaryBrief,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-canvas)] p-6 max-[480px]:p-3">
        <section className="workbench-toolbar mx-auto max-w-4xl p-5 max-[480px]:p-4">
          <Story />
        </section>
      </main>
    ),
  ],
  args: {
    citations: summaryContent.citations,
    draft: summaryContent.draft,
    t: createTranslator('en'),
  },
} satisfies Meta<typeof AiSummaryBrief>

export default meta

/** Story type for the reusable grounded summary brief. */
type Story = StoryObj<typeof meta>

/** Desktop brief keeps every generated claim adjacent to confidence and evidence. */
export const Desktop: Story = {}

/** Narrow brief wraps evidence links without horizontal overflow. */
export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
}

/** Empty categories state that no claim was identified instead of silently disappearing. */
export const EmptyCategories: Story = {
  args: {
    draft: {
      ...summaryContent.draft,
      actions: [],
      decisions: [],
      risks: [],
    },
  },
}

/** Missing evidence fails closed before any generated statement enters the DOM. */
export const InvalidEvidence: Story = {
  args: { citations: [] },
}
