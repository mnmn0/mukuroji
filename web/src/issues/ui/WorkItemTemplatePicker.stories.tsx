import type { Meta, StoryObj } from '@storybook/react-vite'
import { AUTOMATION_SCHEMA_VERSION, createDefaultUnscheduledWorkItemSchedule } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import type { WorkItemTemplate } from '../model/workItemDuplicate'
import { WorkItemTemplatePicker } from './WorkItemTemplatePicker'

/**
 * Builds a story Work Item template.
 *
 * @param id - Template ID.
 * @param name - Template display name.
 * @returns The template.
 */
function storyTemplate(id: string, name: string): WorkItemTemplate {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id,
    workspaceId: 'workspace-1',
    kind: 'work-item',
    name,
    enabled: true,
    version: 1,
    revision: 1,
    payload: { title: name, schedule: createDefaultUnscheduledWorkItemSchedule() },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  }
}

/** Storybook metadata for the create panels' Work Item template picker. */
const meta = {
  title: 'Application/Issues/Work Item Template Picker',
  component: WorkItemTemplatePicker,
  args: {
    onSelect: () => undefined,
    t: createTranslator('ja'),
    templates: [storyTemplate('release-check', 'リリース確認'), storyTemplate('bug-report', '不具合の報告')],
    testId: 'story-template-picker',
  },
  decorators: [
    (Story) => (
      <div className="bg-[var(--workbench-page)] p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkItemTemplatePicker>

export default meta

/** Story type for one picker state. */
type Story = StoryObj<typeof meta>

/** No template is picked yet. */
export const Unselected: Story = {}

/** The draft starts from a template. */
export const Selected: Story = {
  args: { selectedTemplateId: 'release-check' },
}

/** The template list could not be loaded. */
export const LoadError: Story = {
  args: { hasLoadError: true, templates: [] },
}
