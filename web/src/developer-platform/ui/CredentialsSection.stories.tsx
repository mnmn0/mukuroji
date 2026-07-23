import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import {
  developerPlatformLabelsFixture,
  developerPlatformResourcesFixture,
  emptyDeveloperPlatformResourcesFixture,
  readOnlyDeveloperPlatformResourcesFixture,
} from '../fixtures'
import { CredentialsSection } from './CredentialsSection'

/**
 * Storybook metadata for the standalone Developer Platform credentials section.
 */
const meta = {
  title: 'Application/Developer Platform/Credentials',
  component: CredentialsSection,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-canvas)] p-6 max-[720px]:p-3">
        <section className="workbench-panel p-5">
          <Story />
        </section>
      </main>
    ),
  ],
  args: {
    apiKeys: developerPlatformResourcesFixture.apiKeys,
    canManage:
      developerPlatformResourcesFixture.capabilities.canManageCredentials,
    formatDateTime: (value) => value,
    labels: developerPlatformLabelsFixture,
    oauthApps: developerPlatformResourcesFixture.oauthApps,
    onCreateApiKey: fn(),
    onCreateOAuthApp: fn(),
    onRevokeApiKey: fn(),
    onRevokeOAuthApp: fn(),
    onRotateApiKey: fn(),
    onRotateOAuthApp: fn(),
  },
} satisfies Meta<typeof CredentialsSection>

export default meta

/**
 * Story type for the standalone credentials section.
 */
type Story = StoryObj<typeof meta>

/**
 * Displays the standard API key and OAuth application ledgers.
 */
export const Default: Story = {}

/**
 * Displays the first-use empty states for both credential types.
 */
export const Empty: Story = {
  args: {
    apiKeys: emptyDeveloperPlatformResourcesFixture.apiKeys,
    oauthApps: emptyDeveloperPlatformResourcesFixture.oauthApps,
  },
}

/**
 * Displays credential metadata without management actions.
 */
export const ReadOnly: Story = {
  args: {
    apiKeys: readOnlyDeveloperPlatformResourcesFixture.apiKeys,
    canManage:
      readOnlyDeveloperPlatformResourcesFixture.capabilities
        .canManageCredentials,
    oauthApps: readOnlyDeveloperPlatformResourcesFixture.oauthApps,
  },
}
