import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import {
  aiSummaryGenerationFixture,
  aiWithheldGenerationFixture,
} from '../fixtures'
import { AiAssistanceReview } from './AiAssistanceReview'

/** Storybook metadata for the reusable evidence-first AI review surface. */
const meta = {
  title: 'Application/AI Assistance/Evidence Review',
  component: AiAssistanceReview,
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
    generation: aiSummaryGenerationFixture,
    locale: 'en',
    onAdopt: fn(),
    onFeedback: fn(),
    onReject: fn(),
    renderDraft: ({ draft }) => draft.kind === 'summary' ? (
      <div className="grid gap-3">
        <p className="text-app-body font-semibold text-[var(--workbench-text)]">{draft.overview.text}</p>
        {draft.actions.map((action) => (
          <p className="text-app-caption text-[var(--workbench-muted)]" key={action.id}>{action.text}</p>
        ))}
      </div>
    ) : null,
    t: createTranslator('en'),
  },
} satisfies Meta<typeof AiAssistanceReview>

export default meta

/** Story type for the reusable evidence-first review surface. */
type Story = StoryObj<typeof meta>

/** Desktop review with evidence, uncertainty, human decisions, feedback, and audit details. */
export const Desktop: Story = {}

/** Narrow review that stacks the decision actions into full-width touch targets. */
export const Mobile: Story = {
  globals: { viewport: { isRotated: false, value: 'mobile1' } },
}

/** Permission loss removes the draft and every citation from the rendered surface. */
export const PermissionWithheld: Story = {
  args: { generation: aiWithheldGenerationFixture },
}

/** Provider failure exposes retry-safe localized copy without raw response content. */
export const Error: Story = {
  args: {
    errorKind: 'provider',
    generation: undefined,
  },
}

/** Low-confidence output uses explicit text and warning color rather than color alone. */
export const LowConfidence: Story = {
  args: {
    generation: {
      ...aiSummaryGenerationFixture,
      content: aiSummaryGenerationFixture.content.availability === 'available'
        ? {
            ...aiSummaryGenerationFixture.content,
            uncertainty: {
              level: 'low',
              reason: 'Only one currently authorized source supports this summary.',
            },
          }
        : aiSummaryGenerationFixture.content,
    },
  },
}
