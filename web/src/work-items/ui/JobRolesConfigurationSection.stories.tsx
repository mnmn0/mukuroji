import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { workspaceWorkItemConfigurationFixture } from '../fixtures'
import {
  JobRolesConfigurationSection,
  type JobRolesConfigurationSectionProps,
} from './JobRolesConfigurationSection'

/** Job role IDs that the story treats as already saved, so they show the archive-only row state. */
const savedJobRoleIds: ReadonlySet<string> = new Set(['designer', 'qa-engineer', 'legacy-writer'])

/** Configuration draft with saved, archived, and newly added unsaved job roles. */
const populatedJobRolesConfiguration = {
  ...workspaceWorkItemConfigurationFixture,
  jobRoles: [
    { id: 'designer', name: 'デザイナー' },
    { id: 'qa-engineer', name: 'QA エンジニア' },
    { id: 'legacy-writer', name: 'テクニカルライター', archived: true },
    { id: 'role-draft-data-analyst', name: 'データアナリスト' },
  ],
}

/**
 * Keeps the configuration draft in local story state so rename, archive, and remove edits are visible.
 *
 * @param props - Initial section props and the story change callback.
 * @returns The job role section with interactive local draft state.
 */
function JobRolesConfigurationSectionStoryHarness(props: JobRolesConfigurationSectionProps) {
  const [configuration, setConfiguration] = useState(props.configuration)

  return (
    <JobRolesConfigurationSection
      {...props}
      configuration={configuration}
      onChange={(nextConfiguration) => {
        setConfiguration(nextConfiguration)
        props.onChange(nextConfiguration)
      }}
    />
  )
}

/** Storybook metadata for the job role configuration section. */
const meta = {
  title: 'Application/Work Items/Job Roles Configuration',
  component: JobRolesConfigurationSection,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
        <Story />
      </main>
    ),
  ],
  args: {
    configuration: populatedJobRolesConfiguration,
    locale: 'ja',
    onChange: fn(),
    savedJobRoleIds,
  },
  render: (args) => <JobRolesConfigurationSectionStoryHarness {...args} />,
} satisfies Meta<typeof JobRolesConfigurationSection>

export default meta

/** Story type for the job role configuration section. */
type Story = StoryObj<typeof meta>

/**
 * Saved roles (rename and archive only), an archived saved role, and an unsaved role that can still be removed.
 */
export const Populated: Story = {}

/** The same populated rows in the English locale. */
export const PopulatedEnglish: Story = {
  args: {
    configuration: {
      ...populatedJobRolesConfiguration,
      jobRoles: [
        { id: 'designer', name: 'Designer' },
        { id: 'qa-engineer', name: 'QA engineer' },
        { id: 'legacy-writer', name: 'Technical writer', archived: true },
        { id: 'role-draft-data-analyst', name: 'Data analyst' },
      ],
    },
    locale: 'en',
  },
}

/** No job roles configured yet. */
export const Empty: Story = {
  args: {
    configuration: { ...populatedJobRolesConfiguration, jobRoles: [] },
    savedJobRoleIds: new Set<string>(),
  },
}
