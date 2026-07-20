import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import {
  WorkItemDefinitionFilters,
  type WorkItemDefinitionFiltersProps,
} from './WorkItemDefinitionFilters'
import { workspaceWorkItemConfigurationFixture } from '../fixtures'
import type { WorkItemDefinitionFilter } from '../model/workItemFilters'

/**
 * WorkItemDefinitionFilters の Storybook metadata です。
 */
const meta = {
  title: 'Application/Work Items/Definition Filters',
  component: WorkItemDefinitionFilters,
  parameters: {
    layout: 'padded',
  },
  args: {
    configuration: workspaceWorkItemConfigurationFixture,
    idPrefix: 'storybook-work-items',
    locale: 'ja',
    onChange: () => undefined,
    personOptions: [
      { email: 'sato@example.com', id: 'sato@example.com', name: '佐藤 花子' },
      { email: 'chen@example.com', id: 'chen@example.com', name: 'Alex Chen' },
    ],
    value: { category: 'all', customFieldId: '' },
  },
} satisfies Meta<typeof WorkItemDefinitionFilters>

export default meta

/**
 * WorkItemDefinitionFilters stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Workflow category と typed custom field 値を組み合わせる標準状態です。
 */
export const Interactive: Story = {
  render: (args) => <InteractiveFilterStory {...args} />,
}

function InteractiveFilterStory(args: WorkItemDefinitionFiltersProps) {
  const [value, setValue] = useState<WorkItemDefinitionFilter>(args.value)

  return (
    <div className="workbench-toolbar p-4">
      <WorkItemDefinitionFilters {...args} onChange={setValue} value={value} />
    </div>
  )
}
