import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { fn } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { createdInboxFixture, githubReviewTeamsFixture, toReviewInboxFixture } from '../fixtures'
import { PullRequestInbox } from './PullRequestInbox'

/** Formats a timestamp in Japan time for stable stories. */
const formatter = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tokyo' })

/** Team names of the fixtures. */
const teamNames = new Map<string, string>(githubReviewTeamsFixture.map((team) => [team.id, team.name]))

const meta = {
  title: 'Reviews/PullRequestInbox',
  component: PullRequestInbox,
  decorators: [(Story) => <MemoryRouter><Story /></MemoryRouter>],
  args: {
    view: 'to-review',
    inbox: toReviewInboxFixture,
    isLoading: false,
    hasLoadError: false,
    loginSettingsPath: '/settings/personal#settings-github',
    teamName: (teamId: string) => teamNames.get(teamId),
    formatDateTime: (value: string) => formatter.format(new Date(value)),
    t: createTranslator('ja'),
    onViewChange: fn(),
    onReload: fn(),
  },
} satisfies Meta<typeof PullRequestInbox>

export default meta

type Story = StoryObj<typeof meta>

/** Pull requests waiting for the member's review, grouped by section. */
export const ToReview: Story = {}

/** The member's own pull requests. */
export const Created: Story = { args: { view: 'created', inbox: createdInboxFixture } }

/** The member has not registered a GitHub login yet. */
export const NoLogin: Story = { args: { inbox: { configured: true, view: 'to-review', items: [] } } }

/** No GitHub App is configured. */
export const NotConfigured: Story = { args: { inbox: { configured: false, view: 'to-review', items: [] } } }

/** The inbox failed to load. */
export const LoadError: Story = { args: { hasLoadError: true } }

/** English copy. */
export const English: Story = { args: { t: createTranslator('en') } }
