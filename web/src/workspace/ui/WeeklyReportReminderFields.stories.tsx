import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS, type WeeklyReportReminderSettings } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { hasWeeklyReportReminderConflict } from '../model/weeklyReportReminders'
import { WeeklyReportReminderFields } from './WeeklyReportReminderFields'

const t = createTranslator('ja')

/** Props of {@link EditableWeeklyReportReminders}. */
type EditableWeeklyReportRemindersProps = {
  /** Settings the editor starts from. */
  initialSettings: WeeklyReportReminderSettings
  /** Whether the editor is read-only. */
  disabled?: boolean
}

/**
 * Keeps the edited settings in state and locks a save button on a conflict, as the tenant
 * administration panel does with its draft.
 *
 * @param props - Starting settings and lock state.
 * @returns The editor wired to local state.
 */
function EditableWeeklyReportReminders({ initialSettings, disabled = false }: EditableWeeklyReportRemindersProps) {
  const [settings, setSettings] = useState(initialSettings)
  return (
    <div className="max-w-2xl p-6">
      <WeeklyReportReminderFields disabled={disabled} onChange={setSettings} settings={settings} t={t} />
      <button
        className="workbench-button-primary mt-5"
        disabled={disabled || hasWeeklyReportReminderConflict(settings)}
        type="button"
      >
        {t('workspace.tenantAdministration.saveProfile')}
      </button>
    </div>
  )
}

const meta = {
  title: 'Application/Workspace/Weekly Report Reminder Fields',
  component: WeeklyReportReminderFields,
  args: {
    settings: DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS,
    disabled: false,
    onChange: () => undefined,
    t,
  },
} satisfies Meta<typeof WeeklyReportReminderFields>

/** Weekly report reminder and escalation editor of the tenant administration settings. */
export default meta

/** Story variants for the weekly report reminder editor. */
type Story = StoryObj<typeof meta>

/** Moving both notices, reaching the same-slot conflict, and turning the notices off. */
export const Editable: Story = {
  render: () => <EditableWeeklyReportReminders initialSettings={DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const save = canvas.getByRole('button', { name: t('workspace.tenantAdministration.saveProfile') })
    await userEvent.selectOptions(canvas.getByTestId('tenant-weekly-report-reminder-weekday'), '4')
    await userEvent.selectOptions(canvas.getByTestId('tenant-weekly-report-reminder-hour'), '9')
    await expect(canvas.getByTestId('tenant-weekly-report-reminder-weekday')).toHaveValue('4')
    await expect(save).toBeEnabled()

    // The same weekday and hour for both notices is refused.
    await userEvent.selectOptions(canvas.getByTestId('tenant-weekly-report-escalation-weekday'), '4')
    await userEvent.selectOptions(canvas.getByTestId('tenant-weekly-report-escalation-hour'), '9')
    await expect(canvas.getByRole('alert')).toHaveTextContent(t('workspace.tenantAdministration.weeklyReportReminders.conflict'))
    await expect(save).toBeDisabled()

    // Turning the escalation off clears the conflict and locks its pickers.
    await userEvent.click(canvas.getByTestId('tenant-weekly-report-escalation-enabled'))
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument()
    await expect(canvas.getByTestId('tenant-weekly-report-escalation-hour')).toBeDisabled()
    await expect(save).toBeEnabled()

    // Turning the reminder off also locks the escalation.
    await userEvent.click(canvas.getByTestId('tenant-weekly-report-reminder-enabled'))
    await expect(canvas.getByTestId('tenant-weekly-report-reminder-weekday')).toBeDisabled()
    await expect(canvas.getByTestId('tenant-weekly-report-escalation-enabled')).toBeDisabled()
  },
}

/** Read-only while the tenant is closing. */
export const Locked: Story = {
  render: () => <EditableWeeklyReportReminders disabled initialSettings={DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS} />,
}
