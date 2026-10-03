import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { useRef, useState } from 'react'
import type { UpdateFeedDigestPreferences, UpdateFeedDigestState } from '@mukuroji/contracts'
import { createTranslator } from '../../../shared/i18n/i18n'
import { InboxDigestPanel } from './InboxDigestPanel'

const meta = {
  title: 'Application/Updates/Inbox digest settings', component: InboxDigestPanel,
  parameters: { layout: 'padded' },
  args: { savedFeeds: { revision: 0, feeds: [] }, state: { revision: 0, preferences: { enabled: false, frequency: 'daily', views: ['for-me'] }, history: [] }, loading: false, pending: false, canEdit: true, t: createTranslator('en'), onSave: fn(async () => true), onReload: fn() },
} satisfies Meta<typeof InboxDigestPanel>
export default meta
/** Consent variants use the production presentation contract. */
type Story = StoryObj<typeof meta>
/** Default consent is disabled. */
export const Disabled: Story = {}
/** Saved consent does not imply a running scheduler. */
export const OptedIn: Story = { args: { state: { revision: 1, preferences: { enabled: true, frequency: 'weekly', views: ['recent'] }, history: [] } } }
/** Permission loss removes previously loaded metadata. */
export const Denied: Story = { args: { failure: 'denied', canEdit: false } }
/** Conflicts expose an explicit reload action. */
export const Conflict: Story = { args: { failure: 'conflict' } }
/** Initial loading contains no editable consent. */
export const Loading: Story = { args: { state: undefined, loading: true } }
/** Japanese copy wraps on narrow screens. */
export const Japanese: Story = { args: { t: createTranslator('ja') } }
/** Current personal definitions can be selected independently of standard views. */
export const CustomFeeds: Story = { args: { savedFeeds: { revision: 2, feeds: [{ id: 'mine', name: 'Portfolio risks I follow', view: 'at-risk', filters: { teamIds: [], projects: [], portfolioIds: [], initiativeIds: [], health: [], updateStates: [] } }] }, state: { revision: 3, preferences: { enabled: true, frequency: 'weekly', views: [], savedFeeds: { revision: 2, ids: ['mine'] } }, history: [] } } }
/** Changed or deleted definitions require explicit reselection without leaking old IDs. */
export const ChangedSelection: Story = { args: { ...CustomFeeds.args, savedFeeds: { revision: 3, feeds: [] } } }
/** A pending definition read does not offer a destructive reset of cached selections. */
export const SavedLoading: Story = { args: { ...CustomFeeds.args, savedStatus: 'loading' } }
/** Read-only guests are not offered consent mutations. */
export const Guest: Story = { args: { canEdit: false } }
/** Controls an acknowledgement separately from subsequent local edits. */
function SaveDraftHarness() {
  const [state, setState] = useState<UpdateFeedDigestState>(meta.args.state)
  const finish = useRef<(() => void) | undefined>(undefined)
  /** Commits the submitted preferences without blocking a later local edit. */
  const save = (preferences: UpdateFeedDigestPreferences) => new Promise<boolean>((resolve) => {
    finish.current = () => { setState((current) => ({ ...current, revision: current.revision + 1, preferences })); resolve(true) }
  })
  return <><InboxDigestPanel {...meta.args} state={state} onSave={save} /><button onClick={() => finish.current?.()}>Finish submitted save</button><button onClick={() => setState((current) => ({ ...current, revision: current.revision + 1, preferences: { ...current.preferences, frequency: 'daily', views: ['recent'] } }))}>External settings update</button></>
}
/** Successful acknowledgement clears only the submitted editing snapshot. */
export const SaveDraft: Story = { render: () => <SaveDraftHarness /> }
