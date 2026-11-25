import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import {
  calendarFeedsFixture,
  calendarFeedTeamsFixture,
  issuedCalendarFeedUrlFixture,
} from '../fixtures'
import { CalendarFeedsPanel } from './CalendarFeedsPanel'

/** Formats a timestamp in Japan time for stable stories. */
const formatter = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tokyo' })

const meta = {
  title: 'Settings/CalendarFeedsPanel',
  component: CalendarFeedsPanel,
  args: {
    feeds: calendarFeedsFixture,
    isLoading: false,
    hasLoadError: false,
    hasOperationError: false,
    teams: calendarFeedTeamsFixture,
    formatDateTime: (value: string) => formatter.format(new Date(value)),
    t: createTranslator('ja'),
    onIssueMember: fn(),
    onIssueProject: fn(),
    onRevoke: fn(),
    onReload: fn(),
    onDismissIssued: fn(),
    onCopy: fn(async () => true),
  },
} satisfies Meta<typeof CalendarFeedsPanel>

export default meta

type Story = StoryObj<typeof meta>

/** Member and Project feeds already issued. */
export const Issued: Story = {}

/** Right after issuing the member feed, with its URL shown once. */
export const JustIssued: Story = {
  args: {
    issued: { feed: calendarFeedsFixture[0]!, url: issuedCalendarFeedUrlFixture },
  },
}

/** No feed issued yet, in English. */
export const Empty: Story = {
  args: { feeds: [], t: createTranslator('en') },
}

/** The feeds could not be loaded. */
export const LoadError: Story = {
  args: { feeds: undefined, hasLoadError: true },
}
