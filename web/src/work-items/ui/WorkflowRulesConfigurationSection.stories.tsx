import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { workspaceWorkItemConfigurationFixture } from '../fixtures'
import {
  WorkflowRulesConfigurationSection,
  type WorkflowRulesConfigurationSectionProps,
} from './WorkflowRulesConfigurationSection'

/**
 * Keeps the workflow draft in local story state so checked rules stay visible.
 *
 * @param props - Initial section props and the story change callback.
 * @returns The workflow rules section with local draft state.
 */
function WorkflowRulesConfigurationSectionStoryHarness(props: WorkflowRulesConfigurationSectionProps) {
  const [workflow, setWorkflow] = useState(props.workflow)
  return (
    <section className="workbench-panel overflow-hidden">
      <WorkflowRulesConfigurationSection
        {...props}
        workflow={workflow}
        onChange={(nextWorkflow) => {
          setWorkflow(nextWorkflow)
          props.onChange(nextWorkflow)
        }}
      />
    </section>
  )
}

/** Approval-style workflow where only a Project manager can finish a review. */
const approvalWorkflow = {
  ...workspaceWorkItemConfigurationFixture.workflow,
  transitions: workspaceWorkItemConfigurationFixture.workflow.transitions.map((transition) =>
    transition.fromStatusId === 'review' && transition.toStatusId === 'done'
      ? { ...transition, allowedActorRoles: ['project-manager' as const] }
      : transition),
  statuses: workspaceWorkItemConfigurationFixture.workflow.statuses.map((status) =>
    status.id === 'review'
      ? { ...status, requiredFields: ['acceptance-criteria' as const], requiredCustomFieldIds: ['customer-impact'] }
      : status),
}

/** Metadata of the workflow rules configuration section stories. */
const meta = {
  title: 'Application/Work Items/Workflow Rules Configuration',
  component: WorkflowRulesConfigurationSection,
  render: (args) => <WorkflowRulesConfigurationSectionStoryHarness {...args} />,
  args: {
    workflow: approvalWorkflow,
    customFields: workspaceWorkItemConfigurationFixture.customFields,
    locale: 'ja',
    onChange: fn(),
  },
} satisfies Meta<typeof WorkflowRulesConfigurationSection>

export default meta
/** Typed workflow rules section story. */
type Story = StoryObj<typeof meta>

/** A manager-only review approval, then restricting another transition to the assignee. */
export const RestrictTransition: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText('In review から Done への遷移をProject マネージャーに許可')).toBeChecked()
    await userEvent.click(canvas.getByLabelText('In progress から In review への遷移を担当者に許可'))
    await expect(args.onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      transitions: expect.arrayContaining([
        { fromStatusId: 'active', toStatusId: 'review', allowedActorRoles: ['assignee'] },
      ]),
    }))
  },
}

/** Requiring a due date before a Work Item enters Done. */
export const RequireField: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByLabelText('Done で 期限 を必須にする'))
    await expect(args.onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      statuses: expect.arrayContaining([expect.objectContaining({ id: 'done', requiredFields: ['due-date'] })]),
    }))
  },
}

/** English labels on a phone-width screen. */
export const MobileEnglish: Story = {
  args: { locale: 'en' },
  globals: { viewport: { value: 'mobile1' } },
}
