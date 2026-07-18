import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { projectDirectoryFixtures } from '../projects/fixtures'
import { teamWorkItemConfigurationFixture } from '../work-items/fixtures'
import { requestFormFixture } from './fixtures'
import { normalizeRequestForm } from './model'
import {
  RequestFormBuilder,
  type RequestFormBuilderProps,
} from './RequestFormBuilder'

/**
 * Request form builder の Storybook metadata です。
 */
const meta = {
  title: 'Application/Requests/Form Builder',
  component: RequestFormBuilder,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
        <Story />
      </main>
    ),
  ],
  args: {
    locale: 'ja',
    model: normalizeRequestForm(requestFormFixture),
    onChange: () => undefined,
    onPublish: async () => undefined,
    onSave: async () => undefined,
    teams: projectDirectoryFixtures,
    workflowStatuses: teamWorkItemConfigurationFixture.workflow.statuses,
  },
} satisfies Meta<typeof RequestFormBuilder>

/**
 * Request form builder の Storybook metadata です。
 */
export default meta

/**
 * Request form builder story の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Locale、condition、consent、attachment、routing を編集できる標準状態です。
 */
export const Default: Story = {
  render: (args) => <InteractiveRequestFormBuilderStory {...args} />,
}

function InteractiveRequestFormBuilderStory(args: RequestFormBuilderProps) {
  const [model, setModel] = useState(args.model)

  return <RequestFormBuilder {...args} model={model} onChange={setModel} />
}
