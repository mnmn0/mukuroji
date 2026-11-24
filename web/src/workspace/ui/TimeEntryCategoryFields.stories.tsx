import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import {
  DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS,
  type WorkspaceTimeEntryCategorySettings,
} from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { hasTimeEntryCategoryProblem } from '../model/timeEntryCategories'
import { TimeEntryCategoryFields } from './TimeEntryCategoryFields'

const t = createTranslator('ja')

/**
 * Keeps the edited categories in state and locks a save button while they are invalid, as the
 * tenant administration panel does with its draft.
 *
 * @returns The editor wired to local state.
 */
function EditableTimeEntryCategories() {
  const [settings, setSettings] = useState<WorkspaceTimeEntryCategorySettings>(DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS)
  return (
    <div className="max-w-2xl p-6">
      <TimeEntryCategoryFields disabled={false} onChange={setSettings} settings={settings} t={t} />
      <button
        className="workbench-button-primary mt-5"
        disabled={hasTimeEntryCategoryProblem(settings)}
        type="button"
      >
        {t('workspace.tenantAdministration.saveProfile')}
      </button>
    </div>
  )
}

const meta = {
  title: 'Application/Workspace/Time Entry Category Fields',
  component: TimeEntryCategoryFields,
  args: {
    settings: DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS,
    disabled: false,
    onChange: () => undefined,
    t,
  },
} satisfies Meta<typeof TimeEntryCategoryFields>

/** Work category editor of the tenant administration settings. */
export default meta

/** Story variants for the work category editor. */
type Story = StoryObj<typeof meta>

/** Adding a category, renaming and moving one, and retiring them all, which blocks the save. */
export const Editable: Story = {
  render: () => <EditableTimeEntryCategories />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const save = canvas.getByRole('button', { name: t('workspace.tenantAdministration.saveProfile') })
    await userEvent.type(canvas.getByTestId('tenant-time-entry-category-new'), '営業支援')
    await userEvent.click(canvas.getByRole('button', { name: t('workspace.tenantAdministration.timeEntryCategories.add') }))
    await expect(canvas.getAllByTestId('tenant-time-entry-category')).toHaveLength(8)
    await expect(canvas.getByDisplayValue('営業支援')).toBeInTheDocument()
    await expect(save).toBeEnabled()

    // A category the Workspace added cannot lose its name.
    await userEvent.clear(canvas.getByDisplayValue('営業支援'))
    await expect(canvas.getByRole('alert')).toHaveTextContent(t('workspace.tenantAdministration.timeEntryCategories.invalid'))
    await expect(save).toBeDisabled()
  },
}

/** The editor while the tenant is closing. */
export const Disabled: Story = {
  args: { disabled: true },
}
