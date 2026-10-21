import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn, userEvent, within, expect } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { UpdateFeedApiError } from '../api/updateFeed'
import { SavedUpdateFeedsPanel } from './SavedUpdateFeedsPanel'

const meta = {
  title: 'Application/Updates/Saved feeds', component: SavedUpdateFeedsPanel,
  parameters: { layout: 'padded' },
  args: { collection: { revision: 0, feeds: [] }, selectedId: '', options: { teams: [{ id: 'team', name: 'Product team' }], projects: [{ teamId: 'team', projectId: 'project', name: 'Customer onboarding' }], portfolios: [{ id: 'portfolio', name: 'Customer outcomes' }], initiatives: [{ id: 'initiative', name: 'Reliability' }] }, failed: false, denied: false, optionsFailed: false, canEdit: true, pending: false, t: createTranslator('en'), onSelect: fn(), onEditingChange: fn(), onClearError: fn(), onReload: fn(), onSave: fn(async () => true) },
} satisfies Meta<typeof SavedUpdateFeedsPanel>
/** Configures saved-feed panel stories with shared controls and fixtures. */
export default meta
/** Story type shares the same production component and controls. */
type Story = StoryObj<typeof meta>
/** Opens the editor with readable choices and explicit save/cancel actions. */
export const Create: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement)
  await userEvent.click(canvas.getByRole('button', { name: 'New feed' }))
  await userEvent.type(canvas.getByLabelText('Feed name'), 'My risks')
  await userEvent.selectOptions(canvas.getByRole('listbox', { name: 'Reported health' }), 'at-risk')
  await expect(canvas.getByRole('button', { name: 'Save feed' })).toBeEnabled()
} }
/** Japanese copy uses the same responsive layout. */
export const Japanese: Story = { args: { t: createTranslator('ja') } }
/** Read-only guests cannot create or edit personal definitions. */
export const Guest: Story = { args: { canEdit: false } }
/** Loading failures keep retry available. */
export const Error: Story = { args: { collection: undefined, failed: true } }
/** Permission denial offers no futile retry. */
export const Denied: Story = { args: { collection: undefined, failed: true, denied: true, canEdit: false } }
/** Conflict feedback keeps the draft visible and prevents stale resubmission. */
export const Conflict: Story = { ...Create, args: { error: new UpdateFeedApiError(409) }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement)
  await userEvent.click(canvas.getByRole('button', { name: 'New feed' }))
  await expect(canvas.getByRole('button', { name: 'Save feed' })).toBeDisabled()
} }
/** Retained unavailable conditions expose counts without rendering inaccessible identities. */
export const UnavailableConditions: Story = { args: { selectedId: 'personal', collection: { revision: 1, feeds: [{ id: 'personal', name: 'My view', view: 'recent', filters: { teamIds: ['unavailable-team-a', 'unavailable-team-b'], projects: [], portfolioIds: [], initiativeIds: [], health: [], updateStates: [] } }] } }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement)
  await userEvent.click(canvas.getByRole('button', { name: 'Edit feed' }))
  await expect(canvas.getByRole('listbox', { name: 'Teams' })).toHaveAccessibleDescription('Unavailable saved conditions: 2. Changing this field removes them; editing other fields keeps them.')
  await expect(canvasElement.innerHTML).not.toContain('unavailable-team-a')
} }
