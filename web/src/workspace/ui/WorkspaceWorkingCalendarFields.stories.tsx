import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import type { WorkspaceCalendarSettings } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkspaceWorkingCalendarFields } from './WorkspaceWorkingCalendarFields'

const t = createTranslator('ja')

/** Calendar with Saturday working days and a few company holidays. */
const sampleCalendar: WorkspaceCalendarSettings = {
  fiscalYearStartMonth: 4,
  weekStartDay: 1,
  workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
  holidays: ['2027-01-01', '2027-01-02', '2027-05-03'],
}

/** Calendar with a single working weekday, whose checkbox cannot be cleared. */
const singleWeekdayCalendar: WorkspaceCalendarSettings = {
  fiscalYearStartMonth: 1,
  weekStartDay: 1,
  workingWeekdays: ['monday'],
  holidays: [],
}

/** Props of {@link EditableWorkingCalendar}. */
type EditableWorkingCalendarProps = {
  /** Calendar the editor starts from. */
  initialCalendar: WorkspaceCalendarSettings
  /** Whether the editor is read-only. */
  disabled?: boolean
}

/**
 * Keeps the edited calendar in state, as the tenant administration panel does with its draft.
 *
 * @param props - Starting calendar and lock state.
 * @returns The editor wired to local state.
 */
function EditableWorkingCalendar({ initialCalendar, disabled = false }: EditableWorkingCalendarProps) {
  const [calendar, setCalendar] = useState(initialCalendar)
  return (
    <div className="max-w-2xl p-6">
      <WorkspaceWorkingCalendarFields calendar={calendar} disabled={disabled} onChange={setCalendar} t={t} />
    </div>
  )
}

const meta = {
  title: 'Application/Workspace/Working Calendar Fields',
  component: WorkspaceWorkingCalendarFields,
  args: {
    calendar: sampleCalendar,
    disabled: false,
    onChange: () => undefined,
    t,
  },
} satisfies Meta<typeof WorkspaceWorkingCalendarFields>

/** Working weekday and company holiday editor of the tenant administration settings. */
export default meta

/** Story variants for the working calendar editor. */
type Story = StoryObj<typeof meta>

/** Adding and removing holidays, and turning weekdays on and off. */
export const Editable: Story = {
  render: () => <EditableWorkingCalendar initialCalendar={sampleCalendar} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByTestId('tenant-holiday-draft'), '2027-08-13')
    await userEvent.click(canvas.getByTestId('tenant-holiday-add'))
    await expect(canvas.getByText('2027-08-13')).toBeInTheDocument()
    await userEvent.click(canvas.getByRole('button', { name: '休日 2027-01-02 を削除' }))
    await expect(canvas.queryByText('2027-01-02')).not.toBeInTheDocument()
    await userEvent.click(canvas.getByTestId('tenant-working-weekday-saturday'))
    await expect(canvas.getByTestId('tenant-working-weekday-saturday')).not.toBeChecked()
  },
}

/** The only working weekday stays checked, so the Workspace always has a working day. */
export const SingleWorkingWeekday: Story = {
  render: () => <EditableWorkingCalendar initialCalendar={singleWeekdayCalendar} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('tenant-working-weekday-monday')).toBeDisabled()
    await expect(canvas.getByText('休日はまだありません。')).toBeInTheDocument()
  },
}

/** Read-only while the tenant is closing. */
export const Locked: Story = {
  render: () => <EditableWorkingCalendar disabled initialCalendar={sampleCalendar} />,
}
