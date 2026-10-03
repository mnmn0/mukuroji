import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { useRef, useState } from 'react'
import type { UpdateFeedDigestPreferences, UpdateFeedDigestState } from '@mukuroji/contracts'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { updateFeedFixture } from '../fixtures'
import { DigestPanel } from './DigestPanel'

/** Configures preview stories with session-free fixtures and explicit interaction callbacks. */
const meta = {
  title: 'Application/Updates/Digest preview', component: DigestPanel,
  parameters: { layout: 'padded' },
  decorators: [(Story) => <MemoryRouter><div className="mx-auto max-w-5xl"><Story /></div></MemoryRouter>],
  args: { savedFeeds: { revision: 0, feeds: [] }, state: { revision: 1, preferences: { enabled: true, frequency: 'daily', views: ['for-me'] }, history: [{ id: 'daily:2026-10-03', status: 'completed', attempts: 1, token: 'fixture', leaseUntil: 0, count: 1 }] }, loading: false, pending: false, canEdit: true, t: createTranslator('en'), onSave: fn(async () => true), onGenerate: fn(async () => true), onReload: fn(), onDismiss: fn() },
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
  await expect(args.onSave).toHaveBeenCalledWith({ enabled: true, frequency: 'weekly', views: ['for-me'] }, 1)
} }
/** Keeps the asynchronous acknowledgement independently controllable for draft regression checks. */
function SaveDraftHarness() {
  const [state, setState] = useState<UpdateFeedDigestState>(meta.args.state)
  const finish = useRef<(() => void) | undefined>(undefined)
  /** Commits the submitted preferences without preventing a later local edit. */
  const save = (preferences: UpdateFeedDigestPreferences) => new Promise<boolean>((resolve) => {
    finish.current = () => { setState((current) => ({ ...current, revision: current.revision + 1, preferences })); resolve(true) }
  })
  return <><DigestPanel {...meta.args} state={state} onSave={save} /><button onClick={() => finish.current?.()}>Finish submitted save</button><button onClick={() => setState((current) => ({ ...current, revision: current.revision + 1, preferences: { ...current.preferences, frequency: 'daily', views: ['recent'] } }))}>External settings update</button></>
}
/** A successful save clears only its own submitted draft, never subsequent edits. */
export const SaveDraft: Story = { render: () => <SaveDraftHarness /> }
/** Pending definitions suppress custom generation and premature clearing, not withdrawal. */
export const SavedLoading: Story = { args: { savedStatus: 'loading', state: { ...meta.args.state, preferences: { enabled: true, frequency: 'daily', views: [], savedFeeds: { revision: 1, ids: ['mine'] } } } } }
/** Permission loss suppresses cached content and settings. */
export const Denied: Story = { args: { ...Preview.args, failure: 'denied', canEdit: false } }
/** Guests can inspect receipts without mutation controls. */
export const Guest: Story = { args: { canEdit: false } }
/** Conflict offers metadata reload without automatic generation. */
export const Conflict: Story = { args: { failure: 'conflict' } }
/** Initial loading renders no stale metadata. */
export const Loading: Story = { args: { state: undefined, loading: true } }
/** Japanese text wraps in the same responsive layout. */
export const Japanese: Story = { args: { ...Preview.args, t: createTranslator('ja') } }
/** Current authorization may result in an empty preview. */
export const Empty: Story = { args: { preview: { id: 'daily:2026-10-03', replay: true, entries: [], truncated: false, transport: 'preview' } } }
