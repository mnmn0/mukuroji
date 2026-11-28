import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import {
  DEFAULT_WORKSPACE_INVESTMENT_CATEGORY_SETTINGS,
  type WorkspaceInvestmentCategorySettings,
} from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { hasInvestmentCategoryProblem } from '../model/investmentCategories'
import { InvestmentCategoryFields } from './InvestmentCategoryFields'

const t = createTranslator('ja')

/**
 * Keeps the edited categories in state and locks a save button while they are invalid, as the
 * tenant administration panel does with its draft.
 *
 * @returns The editor wired to local state.
 */
function EditableInvestmentCategories() {
  const [settings, setSettings] = useState<WorkspaceInvestmentCategorySettings>(DEFAULT_WORKSPACE_INVESTMENT_CATEGORY_SETTINGS)
  return (
    <div className="max-w-2xl p-6">
      <InvestmentCategoryFields disabled={false} onChange={setSettings} settings={settings} t={t} />
      <button
        className="workbench-button-primary mt-5"
        disabled={hasInvestmentCategoryProblem(settings)}
        type="button"
      >
        {t('workspace.tenantAdministration.saveProfile')}
      </button>
    </div>
  )
}

const meta = {
  title: 'Application/Workspace/Investment Category Fields',
  component: InvestmentCategoryFields,
  args: {
    settings: DEFAULT_WORKSPACE_INVESTMENT_CATEGORY_SETTINGS,
    disabled: false,
    onChange: () => undefined,
    t,
  },
} satisfies Meta<typeof InvestmentCategoryFields>

/** Investment category editor of the tenant administration settings. */
export default meta

/** Story variants for the investment category editor. */
type Story = StoryObj<typeof meta>

/** Adding an Opex category, then clearing its name, which blocks the save. */
export const Editable: Story = {
  render: () => <EditableInvestmentCategories />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const save = canvas.getByRole('button', { name: t('workspace.tenantAdministration.saveProfile') })
    await userEvent.type(canvas.getByPlaceholderText(t('workspace.tenantAdministration.investmentCategories.newName')), '監査対応')
    await userEvent.selectOptions(canvas.getByLabelText(t('workspace.tenantAdministration.investmentCategories.newGroup')), 'opex')
    await userEvent.click(canvas.getByRole('button', { name: t('workspace.tenantAdministration.investmentCategories.add') }))
    await expect(canvas.getAllByTestId('tenant-investment-category')).toHaveLength(6)
    await expect(save).toBeEnabled()

    await userEvent.clear(canvas.getByDisplayValue('監査対応'))
    await expect(canvas.getByRole('alert')).toHaveTextContent(t('workspace.tenantAdministration.investmentCategories.invalid'))
    await expect(save).toBeDisabled()
  },
}

/** The editor while the tenant is closing. */
export const Disabled: Story = {
  args: { disabled: true },
}
