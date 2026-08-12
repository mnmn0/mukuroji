import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { focusQueueResponseFixture } from '../fixtures'
import { FocusPolicyPanel } from './FocusPolicyPanel'

const effectivePolicy = focusQueueResponseFixture.effectivePolicies[0]
if (!effectivePolicy) throw new Error('The Focus policy story requires one effective policy.')

const savePolicy = fn(async () => undefined)

/** Storybook metadata for the standalone Focus policy editor. */
const meta = {
  args: {
    canEditPersonal: true,
    canEditTeam: true,
    onSave: savePolicy,
    personalPolicy: focusQueueResponseFixture.userPolicy,
    policy: effectivePolicy,
    teamPolicy: focusQueueResponseFixture.teamPolicies[0],
    t: createTranslator('en'),
  },
  component: FocusPolicyPanel,
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-canvas)] p-6">
        <div className="mx-auto max-w-4xl"><Story /></div>
      </main>
    ),
  ],
  parameters: { layout: 'fullscreen' },
  title: 'Application/Focus/Policy',
} satisfies Meta<typeof FocusPolicyPanel>

export default meta

/** Story type derived from the standalone policy metadata. */
type Story = StoryObj<typeof meta>

/** Personal scope can save a sparse override through the supplied action. */
export const PersonalEditable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Focus priority rules'))
    await userEvent.clear(canvas.getByLabelText('Urgent weight'))
    await userEvent.type(canvas.getByLabelText('Urgent weight'), '42')
    await userEvent.click(canvas.getByRole('button', { name: 'Save rules' }))
    await expect(savePolicy).toHaveBeenCalledWith(
      { type: 'user' },
      focusQueueResponseFixture.userPolicy?.version ?? 0,
      { weights: { urgent: 42 } },
    )
  },
}

/** Team managers can switch scope and save the selected Team layer. */
export const TeamEditable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Focus priority rules'))
    await userEvent.selectOptions(canvas.getByLabelText('Policy scope'), 'team')
    await userEvent.clear(canvas.getByLabelText('Due-soon window in days'))
    await userEvent.type(canvas.getByLabelText('Due-soon window in days'), '5')
    await userEvent.click(canvas.getByRole('button', { name: 'Save rules' }))
    await expect(savePolicy).toHaveBeenCalledWith(
      { teamId: 'core-team', type: 'team' },
      focusQueueResponseFixture.teamPolicies[0]?.version ?? 0,
      { dueSoonDays: 5 },
    )
  },
}

/** A viewer without policy permission can inspect inheritance but cannot edit it. */
export const ReadOnly: Story = {
  args: { canEditPersonal: false, canEditTeam: false },
}

/** In-flight policy replacement disables the complete editor and labels the action. */
export const Saving: Story = {
  args: { isSaving: true },
}

/** A failed replacement exposes a scoped retry message without an item-action error. */
export const ErrorState: Story = {
  args: { hasError: true },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByText('Focus priority rules'))
  },
}
