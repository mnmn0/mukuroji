import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../shared/i18n/i18n'
import { teamReminderSettingsControllerFixture } from '../fixtures'
import { TeamReminderSettingsPanel } from './TeamReminderSettingsPanel'

/** Team reminder day settings shown on the Team members page. */
const meta = {
  title: 'Application/Notifications/TeamReminderSettings',
  component: TeamReminderSettingsPanel,
  parameters: { layout: 'padded' },
  args: { controller: teamReminderSettingsControllerFixture, t: createTranslator('ja') },
} satisfies Meta<typeof TeamReminderSettingsPanel>

/** Registers the Team reminder settings stories in Storybook. */
export default meta
/** Story type for Team reminder settings. */
type Story = StoryObj<typeof meta>
/** A Team manager editing overrides; blank fields show the defaults. */
export const Manager: Story = {}
/** A Team member sees the settings read-only. */
export const Member: Story = {
  args: {
    controller: {
      ...teamReminderSettingsControllerFixture,
      ...(teamReminderSettingsControllerFixture.settings
        ? { settings: { ...teamReminderSettingsControllerFixture.settings, canManage: false } }
        : {}),
    },
  },
}
/** The narrow phone layout. */
export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
