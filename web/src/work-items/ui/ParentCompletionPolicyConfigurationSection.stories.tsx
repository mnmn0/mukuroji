import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { workspaceWorkItemConfigurationFixture } from '../fixtures'
import {
  ParentCompletionPolicyConfigurationSection,
  type ParentCompletionPolicyConfigurationSectionProps,
} from './ParentCompletionPolicyConfigurationSection'

/**
 * Keeps the configuration draft in local story state so the selected policy stays visible.
 *
 * @param props - Initial section props and the story change callback.
 * @returns The parent completion policy section with local draft state.
 */
function ParentCompletionPolicyConfigurationSectionStoryHarness(
  props: ParentCompletionPolicyConfigurationSectionProps,
) {
  const [configuration, setConfiguration] = useState(props.configuration)
  return (
    <ParentCompletionPolicyConfigurationSection
      {...props}
      configuration={configuration}
      onChange={(nextConfiguration) => {
        setConfiguration(nextConfiguration)
        props.onChange(nextConfiguration)
      }}
    />
  )
}

/** Metadata of the parent completion policy configuration section stories. */
const meta = {
  title: 'Application/Work Items/Parent Completion Policy Configuration',
  component: ParentCompletionPolicyConfigurationSection,
  render: (args) => <ParentCompletionPolicyConfigurationSectionStoryHarness {...args} />,
  args: {
    configuration: workspaceWorkItemConfigurationFixture,
    locale: 'ja',
    onChange: fn(),
  },
} satisfies Meta<typeof ParentCompletionPolicyConfigurationSection>

export default meta
/** Typed parent completion policy section story. */
type Story = StoryObj<typeof meta>

/** Default warn policy, switched to reject. */
export const SwitchToReject: Story = {
  play: async ({ args, canvasElement }) => {
    const select = within(canvasElement).getByLabelText('子が未完了の親を完了にするとき')
    await expect(select).toHaveValue('warn')
    await userEvent.selectOptions(select, 'reject')
    await expect(args.onChange).toHaveBeenCalledWith(expect.objectContaining({ parentCompletionPolicy: 'reject' }))
  },
}
