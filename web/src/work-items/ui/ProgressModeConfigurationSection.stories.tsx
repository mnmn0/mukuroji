import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { workspaceWorkItemConfigurationFixture } from '../fixtures'
import {
  ProgressModeConfigurationSection,
  type ProgressModeConfigurationSectionProps,
} from './ProgressModeConfigurationSection'

/**
 * Keeps the configuration draft in local story state so the selected mode stays visible.
 *
 * @param props - Initial section props and the story change callback.
 * @returns The progress mode section with local draft state.
 */
function ProgressModeConfigurationSectionStoryHarness(props: ProgressModeConfigurationSectionProps) {
  const [configuration, setConfiguration] = useState(props.configuration)
  return (
    <ProgressModeConfigurationSection
      {...props}
      configuration={configuration}
      onChange={(nextConfiguration) => {
        setConfiguration(nextConfiguration)
        props.onChange(nextConfiguration)
      }}
    />
  )
}

/** Metadata of the progress mode configuration section stories. */
const meta = {
  title: 'Application/Work Items/Progress Mode Configuration',
  component: ProgressModeConfigurationSection,
  render: (args) => <ProgressModeConfigurationSectionStoryHarness {...args} />,
  args: {
    configuration: workspaceWorkItemConfigurationFixture,
    locale: 'ja',
    onChange: fn(),
  },
} satisfies Meta<typeof ProgressModeConfigurationSection>

export default meta
/** Typed progress mode section story. */
type Story = StoryObj<typeof meta>

/** Default status-category mode, switched to remaining effort. */
export const SwitchToRemainingEffort: Story = {
  play: async ({ args, canvasElement }) => {
    const select = within(canvasElement).getByLabelText('進捗率の算出方法')
    await expect(select).toHaveValue('status-category')
    await userEvent.selectOptions(select, 'remaining-effort')
    await expect(args.onChange).toHaveBeenCalledWith(expect.objectContaining({ progressMode: 'remaining-effort' }))
  },
}
