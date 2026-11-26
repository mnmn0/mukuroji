import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { aiAssistanceUsageFixture } from '../fixtures'
import { AiAssistanceUsageSection } from './AiAssistanceUsageSection'

/** Storybook metadata for the manager-only monthly AI usage section. */
const meta = {
  title: 'Application/AI Assistance/Usage',
  component: AiAssistanceUsageSection,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-canvas)] p-6 max-[480px]:p-3">
        <div className="mx-auto max-w-5xl">
          <Story />
        </div>
      </main>
    ),
  ],
  args: {
    locale: 'en',
    onRetry: fn(),
    t: createTranslator('en'),
    usage: aiAssistanceUsageFixture,
  },
} satisfies Meta<typeof AiAssistanceUsageSection>

export default meta

/** Usage past 80% of the monthly cost cap shows the warning. */
export const NearLimit: StoryObj<typeof meta> = {}

/** Japanese copy with the cap reached and the deployment-wide switch off. */
export const ExhaustedAndPausedJapanese: StoryObj<typeof meta> = {
  args: {
    locale: 'ja',
    t: createTranslator('ja'),
    usage: { ...aiAssistanceUsageFixture, deploymentPaused: true, exhausted: true },
  },
}

/** A month without any recorded usage. */
export const Empty: StoryObj<typeof meta> = {
  args: {
    usage: {
      ...aiAssistanceUsageFixture,
      members: [],
      tasks: [],
      totals: { costUnavailableGenerations: 0, costUsd: 0, generations: 0, inputTokens: 0, outputTokens: 0 },
      warning: false,
    },
  },
}

/** The usage request failed. */
export const LoadError: StoryObj<typeof meta> = {
  args: { loadError: true, usage: undefined },
}
