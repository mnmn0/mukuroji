import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkspaceAccessApiError } from '../api/errors'
import type { MemberProfile } from '../api/memberProfile'
import { MemberProfileSection } from './MemberProfileSection'

const t = createTranslator('ja')

const profile = {
  memberKey: 'sato@example.com',
  email: 'sato@example.com',
  name: '佐藤 花子',
  nameEditable: true,
  version: 3,
} satisfies MemberProfile

const meta = {
  args: {
    profile,
    t,
    userLabel: 'sato@example.com',
    onSave: async () => {},
  },
  component: MemberProfileSection,
  decorators: [
    (Story) => (
      <div className="max-w-3xl p-6">
        <Story />
      </div>
    ),
  ],
  title: 'Application/Settings/Member Profile Section',
} satisfies Meta<typeof MemberProfileSection>

export default meta

/** Story variants for the member profile section. */
type Story = StoryObj<typeof meta>

/** A member who can change their display name. */
export const Editable: Story = {}

/** A directory (SCIM) member, whose name the directory manages. */
export const DirectoryManaged: Story = {
  args: {
    profile: { ...profile, nameEditable: false },
  },
}

/** Saving keeps the button busy until the server answers. */
export const Saving: Story = {
  args: {
    onSave: () => new Promise<void>(() => {}),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByTestId('settings-profile-name')
    await userEvent.clear(input)
    await userEvent.type(input, '佐藤')
    await userEvent.click(canvas.getByTestId('settings-profile-save'))
    await expect(canvas.getByTestId('settings-profile-save')).toBeDisabled()
  },
}

/** A save refused because the member changed elsewhere. */
export const SaveConflict: Story = {
  args: {
    onSave: async () => {
      throw new WorkspaceAccessApiError(409, 'Member profile request failed.', 'WorkspaceVersionConflict')
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByTestId('settings-profile-name')
    await userEvent.clear(input)
    await userEvent.type(input, '佐藤')
    await userEvent.click(canvas.getByTestId('settings-profile-save'))
    await expect(await canvas.findByRole('alert')).toHaveTextContent(t('workspace.settings.profile.conflict'))
  },
}

/** The profile could not be loaded. */
export const LoadFailed: Story = {
  args: {
    loadFailed: true,
    onRetry: () => {},
    profile: undefined,
  },
}
