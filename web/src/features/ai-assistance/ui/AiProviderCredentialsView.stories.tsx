import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { aiProviderCredentialsFixture } from '../fixtures'
import type { AiProviderCredentialFeedback } from '../mutations/useAiProviderCredentialMutations'
import { AiProviderCredentialsView } from './AiProviderCredentialsSection'

/** Storybook metadata for the manager-only external provider key section. */
const meta = {
  title: 'Application/AI Assistance/Provider API keys',
  component: AiProviderCredentialsView,
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
    credentials: aiProviderCredentialsFixture,
    loadFailed: false,
    mutations: {
      saveKey: fn(async (): Promise<AiProviderCredentialFeedback> => 'saved'),
      removeKey: fn(async (): Promise<AiProviderCredentialFeedback> => 'removed'),
    },
    onRetry: fn(),
    t: createTranslator('en'),
  },
} satisfies Meta<typeof AiProviderCredentialsView>

export default meta

/** Story type for the provider key section. */
type Story = StoryObj<typeof meta>

/** Claude API has a key and OpenAI is waiting for one. */
export const Registered: Story = {}

/** Japanese copy for the same state. */
export const Japanese: Story = {
  args: { t: createTranslator('ja') },
}

/** The status request is in flight. */
export const Loading: Story = {
  args: { credentials: undefined },
}

/** The status request failed and can be retried. */
export const LoadFailed: Story = {
  args: { credentials: undefined, loadFailed: true },
}

/** A save is rejected as an invalid key. */
export const InvalidKey: Story = {
  args: {
    mutations: {
      saveKey: fn(async (): Promise<AiProviderCredentialFeedback> => 'invalid'),
      removeKey: fn(async (): Promise<AiProviderCredentialFeedback> => 'removed'),
    },
  },
}
