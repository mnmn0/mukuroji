import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { slackIngestStatusFixture, slackIngestTeamsFixture } from '../fixtures'
import { SlackIngestPanel } from './SlackIngestPanel'

const meta = {
  title: 'Settings/SlackIngestPanel',
  component: SlackIngestPanel,
  args: {
    status: slackIngestStatusFixture,
    hasLoadError: false,
    hasOperationError: false,
    teams: slackIngestTeamsFixture,
    t: createTranslator('ja'),
    onReload: fn(),
    onSaveRetention: fn(),
    onSetTarget: fn(),
  },
} satisfies Meta<typeof SlackIngestPanel>

export default meta

type Story = StoryObj<typeof meta>

/** The Slack app is set up and three channels are joined, one of them unmapped. */
export const Connected: Story = {}

/** No Slack app secret yet, in English. */
export const NotConfigured: Story = {
  args: {
    status: { ...slackIngestStatusFixture, configured: false, channels: [] },
    t: createTranslator('en'),
  },
}

/** The status could not be loaded. */
export const LoadError: Story = {
  args: { status: undefined, hasLoadError: true },
}
