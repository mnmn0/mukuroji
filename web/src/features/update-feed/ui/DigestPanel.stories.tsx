import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { updateFeedFixture } from '../fixtures'
import { DigestPanel } from './DigestPanel'

const meta = {
  title: 'Application/Updates/Digest preview', component: DigestPanel,
  parameters: { layout: 'padded' },
  decorators: [(Story) => <MemoryRouter><div className="mx-auto max-w-5xl"><Story /></div></MemoryRouter>],
  args: { state: { revision: 1, preferences: { enabled: true, frequency: 'daily', views: ['for-me'] }, history: [{ id: 'daily:2026-10-03', status: 'completed', attempts: 1, token: 'fixture', leaseUntil: 0, count: 1 }] }, loading: false, pending: false, canEdit: true, t: createTranslator('en'), onSave: fn(async () => true), onGenerate: fn(async () => true), onReload: fn(), onDismiss: fn() },
} satisfies Meta<typeof DigestPanel>
export default meta
/** Story variants use the production pure presentation contract. */
type Story = StoryObj<typeof meta>
/** Populated ephemeral preview with target navigation and bodyless history. */
export const Preview: Story = { args: { preview: { id: 'daily:2026-10-03', replay: false, entries: updateFeedFixture.entries.slice(0, 1), truncated: false, transport: 'preview' } } }
/** Keyboard-friendly draft changes prevent previewing unsaved settings. */
export const Settings: Story = { play: async ({ canvasElement, args }) => {
  const canvas = within(canvasElement)
  await userEvent.selectOptions(canvas.getByLabelText('Interval'), 'weekly')
  await expect(canvas.getByRole('button', { name: 'Generate preview' })).toBeDisabled()
  await userEvent.click(canvas.getByRole('button', { name: 'Save preview settings' }))
  await expect(args.onSave).toHaveBeenCalledWith({ enabled: true, frequency: 'weekly', views: ['for-me'] })
} }
/** Permission loss suppresses cached content and settings. */
export const Denied: Story = { args: { ...Preview.args, failure: 'denied', canEdit: false } }
/** Conflict offers metadata reload without automatic generation. */
export const Conflict: Story = { args: { failure: 'conflict' } }
/** Initial loading renders no stale metadata. */
export const Loading: Story = { args: { state: undefined, loading: true } }
/** Japanese text wraps in the same responsive layout. */
export const Japanese: Story = { args: { ...Preview.args, t: createTranslator('ja') } }
/** Current authorization may result in an empty preview. */
export const Empty: Story = { args: { preview: { id: 'daily:2026-10-03', replay: true, entries: [], truncated: false, transport: 'preview' } } }
