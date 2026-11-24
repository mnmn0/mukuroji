import type { Meta, StoryObj } from '@storybook/react-vite'
import { AutomationRuleDefinitionEditor } from './AutomationRuleDefinitionEditor'
import {
  activeAutomationRuleFixture,
  automationRuleEditorOptionsFixture,
} from '../fixtures'

/** Storybook metadata of the rule definition editor. */
const meta = {
  title: 'Application/Automation/Rule Definition Editor',
  component: AutomationRuleDefinitionEditor,
  parameters: { layout: 'padded' },
  args: {
    locale: 'ja',
    rule: activeAutomationRuleFixture,
    options: automationRuleEditorOptionsFixture,
    onSave: async () => undefined,
    onCancel: () => undefined,
    onDryRun: async () => ({
      matched: true,
      triggerType: 'status',
      conditions: [{ index: 0, matched: true, readsEventFields: false }],
      actions: [{ index: 0, type: 'comment' }],
    }),
  },
} satisfies Meta<typeof AutomationRuleDefinitionEditor>

export default meta

/** Story type of the rule definition editor. */
type Story = StoryObj<typeof meta>

/** A rule with one condition and one action, with the dry run available. */
export const EditConditionsAndActions: Story = {}

/** Rows matched by any condition, ordered actions, and a typed custom field condition. */
export const AnyConditionWithOrderedActions: Story = {
  args: {
    rule: {
      ...activeAutomationRuleFixture,
      conditions: [{
        type: 'any',
        conditions: [
          { type: 'field', field: 'workItem.priority', operator: 'equals', value: 'high' },
          { type: 'field', field: 'workItem.customFieldValues.estimate', operator: 'greater-than', value: 3 },
        ],
      }],
      actions: [
        { type: 'assign', assigneeMemberKey: 'sato@example.com' },
        { type: 'update', patch: { workflowStatusId: 'in-review' } },
        { type: 'notify', recipientMemberKeys: ['owner@example.com'], title: 'Assigned' },
      ],
    },
  },
}

/** Saved conditions the rows cannot show, kept unless the administrator rebuilds them. */
export const SavedNestedConditions: Story = {
  args: {
    locale: 'en',
    rule: {
      ...activeAutomationRuleFixture,
      conditions: [{
        type: 'not',
        condition: { type: 'field', field: 'workItem.priority', operator: 'equals', value: 'low' },
      }],
    },
  },
}

/** Without a dry run callback the try section is hidden. */
export const WithoutDryRun: Story = {
  args: { onDryRun: undefined },
}
