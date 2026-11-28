import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import type { WorkspaceAgentCostSettings } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { AgentCostBudgetFields } from './AgentCostBudgetFields'

const t = createTranslator('ja')

/**
 * Keeps the edited settings in state and shows what would be saved, as the tenant administration
 * panel does with its draft.
 *
 * @returns The editor wired to local state.
 */
function EditableAgentCost() {
  const [settings, setSettings] = useState<WorkspaceAgentCostSettings | undefined>(undefined)
  return (
    <div className="max-w-3xl p-6">
      <AgentCostBudgetFields currency="JPY" disabled={false} onChange={setSettings} settings={settings} t={t} />
      <output className="mt-4 block text-xs" data-testid="agent-cost-settings">{JSON.stringify(settings ?? null)}</output>
    </div>
  )
}

const meta = {
  title: 'Application/Workspace/Agent Cost Budget Fields',
  component: AgentCostBudgetFields,
  args: {
    settings: { includeInProjectBudgets: true },
    currency: 'JPY',
    disabled: false,
    onChange: () => undefined,
    t,
  },
} satisfies Meta<typeof AgentCostBudgetFields>

export default meta

/** Story type of the agent cost settings stories. */
type Story = StoryObj<typeof meta>

/** Showing agent cost in US dollars beside a yen budget. */
export const Default: Story = {}

/** A USD Workspace adds the cost to the budget actual. */
export const UsdWorkspace: Story = { args: { currency: 'USD' } }

/** Turning the setting on saves it. */
export const Editing: Story = {
  render: () => <EditableAgentCost />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId('tenant-agent-cost-include'))
    await expect(canvas.getByTestId('agent-cost-settings')).toHaveTextContent('{"includeInProjectBudgets":true}')
  },
}
