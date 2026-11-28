import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { githubReviewTeamsFixture, repositoryLinksFixture } from '../fixtures'
import { GitHubLoginPanel } from './GitHubLoginPanel'
import { GitHubRepositoryLinksPanel } from './GitHubRepositoryLinksPanel'

const meta = {
  title: 'Settings/GitHubLoginPanel',
  component: GitHubLoginPanel,
  args: {
    githubLogin: 'demo-user',
    isLoading: false,
    hasLoadError: false,
    t: createTranslator('ja'),
    onSave: fn(async () => true),
    onRemove: fn(),
    onReload: fn(),
  },
} satisfies Meta<typeof GitHubLoginPanel>

export default meta

/** Story type for the GitHub settings panels. */
type Story = StoryObj<typeof meta>

/** A registered login. */
export const Registered: Story = {}

/** No login registered yet. */
export const NotRegistered: Story = { args: { githubLogin: undefined } }

/** Another member holds the login. */
export const Taken: Story = { args: { githubLogin: undefined, operationError: 'login-taken' } }

/** Repository links of the Workspace settings, in the same file to keep the GitHub settings together. */
export const RepositoryLinks: Story = {
  render: () => (
    <GitHubRepositoryLinksPanel
      hasLoadError={false}
      isLoading={false}
      listing={repositoryLinksFixture}
      t={createTranslator('ja')}
      teams={githubReviewTeamsFixture}
      onLink={fn()}
      onReload={fn()}
      onUnlink={fn()}
    />
  ),
}

/** Repository links while no GitHub App is configured. */
export const RepositoryLinksNotConfigured: Story = {
  render: () => (
    <GitHubRepositoryLinksPanel
      hasLoadError={false}
      isLoading={false}
      listing={{ configured: false, repositories: [] }}
      t={createTranslator('ja')}
      teams={githubReviewTeamsFixture}
      onLink={fn()}
      onReload={fn()}
      onUnlink={fn()}
    />
  ),
}
