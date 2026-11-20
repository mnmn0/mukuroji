import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { createTranslator } from '../../shared/i18n/i18n'
import type { SearchFilterOption } from '../model/filterOptions'
import { SearchFilterPicker, type SearchFilterPickerProps } from './SearchFilterPicker'

const memberOptions: SearchFilterOption[] = [
  { description: 'ada@example.com', label: 'Ada Lovelace', value: 'member-ada' },
  { description: 'grace@example.com', label: 'Grace Hopper', value: 'member-grace' },
  { label: 'ken@example.com', value: 'member-ken' },
]

/**
 * Keeps the picker selection in story state so checkbox interactions update the view.
 *
 * @param props - Story args for the picker.
 * @returns The picker with local selection state.
 */
function StatefulSearchFilterPicker(props: SearchFilterPickerProps) {
  const [selectedValues, setSelectedValues] = useState<readonly string[]>(props.selectedValues)
  return (
    <SearchFilterPicker
      {...props}
      onChange={(values) => {
        setSelectedValues(values)
        props.onChange(values)
      }}
      selectedValues={selectedValues}
    />
  )
}

/**
 * Storybook meta for the Search ID filter picker.
 */
const meta = {
  title: 'Application/Search/FilterPicker',
  component: SearchFilterPicker,
  args: {
    label: '担当者',
    onChange: () => undefined,
    options: memberOptions,
    selectedValues: ['member-ada'],
    t: createTranslator('ja'),
  },
  decorators: [
    (Story) => (
      <div className="max-w-[360px] bg-[var(--workbench-canvas)] p-6">
        <Story />
      </div>
    ),
  ],
  render: (args) => <StatefulSearchFilterPicker {...args} />,
} satisfies Meta<typeof SearchFilterPicker>

export default meta

/**
 * Search filter picker story type.
 */
type Story = StoryObj<typeof meta>

/**
 * Members listed by name with one selected.
 */
export const Members: Story = {}

/**
 * A selected ID that is no longer listed, such as one restored from a saved view.
 */
export const UnknownSelectedId: Story = {
  args: {
    selectedValues: ['member-ada', 'legacy-user'],
  },
}

/**
 * Member options that failed to load, leaving ID entry available.
 */
export const LoadFailed: Story = {
  args: {
    options: [],
    selectedValues: [],
    statusMessage: '一部のメンバーを読み込めませんでした',
  },
}

/**
 * English labels.
 */
export const English: Story = {
  args: {
    label: 'Assignee',
    t: createTranslator('en'),
  },
}
