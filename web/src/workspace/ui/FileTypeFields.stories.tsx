import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import {
  DEFAULT_WORKSPACE_FILE_TYPE_SETTINGS,
  type WorkspaceFileTypeSettings,
} from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { FileTypeFields } from './FileTypeFields'

const t = createTranslator('ja')

/**
 * Keeps the edited File types in state and shows the settings that would be saved, as the tenant
 * administration panel does with its draft.
 *
 * @returns The editor wired to local state.
 */
function EditableFileTypes() {
  const [settings, setSettings] = useState<WorkspaceFileTypeSettings>(DEFAULT_WORKSPACE_FILE_TYPE_SETTINGS)
  return (
    <div className="max-w-3xl p-6">
      <FileTypeFields disabled={false} onChange={setSettings} settings={settings} t={t} />
      <output className="mt-4 block text-xs" data-testid="file-type-settings">{JSON.stringify(settings)}</output>
    </div>
  )
}

const meta = {
  title: 'Application/Workspace/File Type Fields',
  component: FileTypeFields,
  args: {
    settings: DEFAULT_WORKSPACE_FILE_TYPE_SETTINGS,
    disabled: false,
    onChange: () => undefined,
    t,
  },
} satisfies Meta<typeof FileTypeFields>

/** File type editor of the tenant administration settings. */
export default meta

/** Story variants for the File type editor. */
type Story = StoryObj<typeof meta>

/** Enabling an opt-in type and blocking a default one. */
export const Editable: Story = {
  render: () => <EditableFileTypes />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('tenant-file-type-xlsm')).toBeChecked()
    await expect(canvas.getByTestId('tenant-file-type-rar')).not.toBeChecked()
    await userEvent.click(canvas.getByTestId('tenant-file-type-rar'))
    await userEvent.click(canvas.getByTestId('tenant-file-type-xlsm'))
    await expect(canvas.getByTestId('file-type-settings')).toHaveTextContent('{"allowed":["rar"],"blocked":["xlsm"]}')
  },
}

/** The editor while the tenant is closing. */
export const Disabled: Story = {
  args: { disabled: true },
}
