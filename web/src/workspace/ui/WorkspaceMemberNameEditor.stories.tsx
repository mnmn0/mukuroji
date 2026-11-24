import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../api/access'
import { WorkspaceMemberNameEditor } from './WorkspaceMemberNameEditor'

const t = createTranslator('ja')

const member = {
  id: 'sato@example.com',
  memberKey: 'sato@example.com',
  email: 'sato@example.com',
  name: 'Sato',
  role: 'member',
  status: 'active',
  version: 2,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
} satisfies WorkspaceMember

const meta = {
  args: {
    member,
    t,
    testId: 'sato-example-com',
    onSave: async () => {},
  },
  component: WorkspaceMemberNameEditor,
  decorators: [
    (Story) => (
      <div className="max-w-md p-6">
        <Story />
      </div>
    ),
  ],
  title: 'Application/Settings/Workspace Member Name Editor',
} satisfies Meta<typeof WorkspaceMemberNameEditor>

export default meta

/** Story variants for the member display name editor. */
type Story = StoryObj<typeof meta>

/** The closed state: a button in the member row. */
export const Closed: Story = {}

/** The inline form, opened from the button. */
export const Editing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: t('workspace.access.members.rename') }))
    await expect(canvas.getByTestId('workspace-member-rename-input-sato-example-com')).toHaveValue('Sato')
  },
}

/**
 * A name with a control character is refused before saving. The draft starts from a stored name
 * that has a tab, because typing cannot go past the field's length limit.
 */
export const InvalidName: Story = {
  args: { member: { ...member, name: 'Sato\tHanako' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: t('workspace.access.members.rename') }))
    await expect(canvas.getByTestId('workspace-member-rename-input-sato-example-com')).toHaveAttribute('aria-invalid', 'true')
    await expect(canvas.getByRole('alert')).toHaveTextContent(t('workspace.settings.profile.invalid'))
    await expect(canvas.getByTestId('workspace-member-rename-save-sato-example-com')).toBeDisabled()
  },
}

/** A save that fails keeps the form open with a message. */
export const SaveFailed: Story = {
  args: {
    onSave: async () => {
      throw new Error('failed')
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: t('workspace.access.members.rename') }))
    await userEvent.click(canvas.getByTestId('workspace-member-rename-save-sato-example-com'))
    await expect(await canvas.findByRole('alert')).toHaveTextContent(t('workspace.access.members.renameFailed'))
  },
}
