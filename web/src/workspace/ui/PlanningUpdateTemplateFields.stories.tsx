import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import type { PlanningUpdateTemplateSettings } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import {
  PlanningUpdateTemplateFields,
  type PlanningUpdateTemplateFieldsProps,
} from './PlanningUpdateTemplateFields'

/** Workspace settings with two required fields and starting text for two fields. */
const populatedSettings: PlanningUpdateTemplateSettings = {
  requiredFields: ['riskSummary', 'evidence'],
  template: {
    summary: '今週の完了事項:\n来週の予定:',
    nextAction: '担当と期日を書く',
  },
}

/**
 * Keeps the edited settings in story state so the controls respond like the admin panel.
 *
 * @param props - Initial settings, lock state, and translator.
 * @returns The editor bound to local state.
 */
function StatefulTemplateFields(props: PlanningUpdateTemplateFieldsProps) {
  const [settings, setSettings] = useState(props.settings)
  return <PlanningUpdateTemplateFields {...props} onChange={setSettings} settings={settings} />
}

/** Storybook metadata for the Workspace health update required fields and template editor. */
const meta = {
  title: 'Application/Workspace/PlanningUpdateTemplateFields',
  component: PlanningUpdateTemplateFields,
  render: (args) => <StatefulTemplateFields {...args} />,
  parameters: { layout: 'centered' },
  args: {
    disabled: false,
    onChange: () => undefined,
    settings: populatedSettings,
    t: createTranslator('ja'),
  },
  decorators: [(Story) => (
    <div className="w-[min(720px,calc(100vw-2rem))]">
      <Story />
    </div>
  )],
} satisfies Meta<typeof PlanningUpdateTemplateFields>

export default meta

/** Story type for the template editor states. */
type Story = StoryObj<typeof meta>

/** Required fields and starting text an administrator can change. */
export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const decision = canvas.getByTestId('tenant-planning-update-required-decisionSummary')
    await userEvent.click(decision)
    await expect(decision).toBeChecked()
    const helpNeeded = canvas.getByTestId('tenant-planning-update-template-helpNeeded')
    await userEvent.type(helpNeeded, '特になし')
    await expect(helpNeeded).toHaveValue('特になし')
  },
}

/** A Workspace without settings: nothing required and no starting text. */
export const Empty: Story = {
  args: { settings: { requiredFields: [], template: {} } },
}

/** Read-only while the tenant is closing. */
export const Locked: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('tenant-planning-update-required-riskSummary')).toBeDisabled()
  },
}
