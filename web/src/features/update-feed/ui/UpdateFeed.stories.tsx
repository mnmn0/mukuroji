import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { updateFeedFixture } from '../fixtures'
import { UpdateFeed } from './UpdateFeed'

/** Stories for responsive report rows and every asynchronous state. */
const meta = {
  title: 'Application/Updates/Feed', component: UpdateFeed,
  parameters: { layout: 'fullscreen' },
  decorators: [(Story) => <MemoryRouter><main className="min-h-screen bg-white p-6 max-[600px]:p-4"><Story /></main></MemoryRouter>],
  args: { response: updateFeedFixture, view: 'for-me', locale: 'en', t: createTranslator('en'), loading: false, failed: false, denied: false, canMarkRead: true, mutationFailed: false, pending: false, onRetry: fn(), onToggle: fn(), onViewChange: fn() },
} satisfies Meta<typeof UpdateFeed>
export default meta

/** Story type derived from the feed's pure presentation contract. */
type Story = StoryObj<typeof meta>

/** Populated feed with independent health and submission labels. */
export const Reports: Story = { play: async ({ canvasElement, args }) => {
  const canvas = within(canvasElement)
  await expect(canvas.getByText('On track')).toBeVisible()
  await expect(canvas.getByText('Overdue')).toBeVisible()
  await userEvent.click(canvas.getByRole('button', { name: 'Mark as read: Customer onboarding' }))
  await expect(args.onToggle).toHaveBeenCalledWith(updateFeedFixture.entries[0])
} }
/** Localized view suitable for narrow-screen verification. */
export const Japanese: Story = { args: { locale: 'ja', t: createTranslator('ja') } }
/** Personal relevance and report attention remain independently explained. */
export const Relevance: Story = {
  args: { response: { ...updateFeedFixture, entries: updateFeedFixture.entries.slice(0, 1).map((entry) => ({ ...entry, relevance: 9, reasons: ['project-member', 'watching', 'recent-interaction'], attention: { score: 3, reasons: ['recent-comment', 'recent-reaction'] } })), total: 1 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(/You are a current Project member/)).toBeVisible()
    await expect(canvas.getByText(/You watch this target/)).toBeVisible()
    await expect(canvas.getByText(/Comment activity within 7 days/)).toBeVisible()
    await expect(canvas.getByText('On track')).toBeVisible()
    await expect(canvas.getByText('Overdue')).toBeVisible()
  },
}
/** Empty feeds preserve the selected filter and navigation. */
export const Empty: Story = { args: { response: { ...updateFeedFixture, entries: [], total: 0 } } }
/** First-request loading state. */
export const Loading: Story = { args: { response: undefined, loading: true } }
/** Failed refresh suppresses report content and provides an explicit retry. */
export const Error: Story = { args: { response: undefined, failed: true } }
/** Conflict feedback keeps explicit user control of the next choice. */
export const Conflict: Story = { args: { mutationFailed: true } }
/** Permission denial does not offer an ineffective transient-error retry. */
export const Denied: Story = { args: { response: undefined, failed: true, denied: true } }
/** Guests can read authorized content without mutation controls. */
export const Guest: Story = { args: { canMarkRead: false } }
