import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { workspaceWorkItemConfigurationFixture } from '../fixtures'
import {
  CompletionGateConfigurationSection,
  type CompletionGateConfigurationSectionProps,
} from './CompletionGateConfigurationSection'

/**
 * Keeps the configuration draft in local story state so the chosen requirements stay visible.
 *
 * @param props - Initial section props and the story change callback.
 * @returns The completion Gate section with local draft state.
 */
function CompletionGateConfigurationSectionStoryHarness(props: CompletionGateConfigurationSectionProps) {
  const [configuration, setConfiguration] = useState(props.configuration)
  return (
    <CompletionGateConfigurationSection
      {...props}
      configuration={configuration}
      onChange={(nextConfiguration) => {
        setConfiguration(nextConfiguration)
        props.onChange(nextConfiguration)
      }}
    />
  )
}

/** Metadata of the completion Gate configuration section stories. */
const meta = {
  title: 'Application/Work Items/Completion Gate Configuration',
  component: CompletionGateConfigurationSection,
  render: (args) => <CompletionGateConfigurationSectionStoryHarness {...args} />,
  args: {
    configuration: workspaceWorkItemConfigurationFixture,
    locale: 'ja',
    onChange: fn(),
  },
} satisfies Meta<typeof CompletionGateConfigurationSection>

export default meta
/** Typed completion Gate section story. */
type Story = StoryObj<typeof meta>

/** Every condition starts off; requiring acceptance criteria keeps the other conditions off. */
export const RequireAcceptanceCriteria: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const select = canvas.getByLabelText('受け入れ条件をすべて満たしている')
    await expect(select).toHaveValue('off')
    await expect(canvas.getByLabelText('承認済みの承認が1件以上ある')).toHaveValue('off')
    await userEvent.selectOptions(select, 'required')
    await expect(args.onChange).toHaveBeenCalledWith(expect.objectContaining({
      completionGate: { acceptanceCriteria: 'required' },
    }))
  },
}

/** A saved Gate shows each condition's requirement. */
export const SavedGate: Story = {
  args: {
    configuration: {
      ...workspaceWorkItemConfigurationFixture,
      completionGate: { noPendingApprovals: 'warn', humanApproval: 'required' },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText('判断待ち・修正依頼の承認がない')).toHaveValue('warn')
    await expect(canvas.getByLabelText('承認済みの承認が1件以上ある')).toHaveValue('required')
  },
}
