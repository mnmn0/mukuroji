import type { Meta, StoryObj } from '@storybook/react-vite'
import { AutomationRuleEditor } from './AutomationEditors'
import {
  activeInboundWebhookEndpointFixture,
  pausedInboundWebhookEndpointFixture,
} from '../fixtures'

/** AutomationRuleEditor の Storybook metadata です。 */
const meta = {
  title: 'Application/Automation/Rule Editor',
  component: AutomationRuleEditor,
  parameters: { layout: 'padded' },
  args: {
    initialSchedule: {
      catchUpPolicy: 'all',
      daysOfWeek: [0],
      frequency: 'weekly',
      interval: 1,
      localTime: '09:00',
      startDate: '2026-03-01',
      timeZone: 'America/New_York',
    },
    locale: 'en',
    onCreate: async () => undefined,
    teams: [{ id: 'core-team', name: 'Core Team' }],
  },
} satisfies Meta<typeof AutomationRuleEditor>

export default meta

/** AutomationRuleEditor Story の型です。 */
type Story = StoryObj<typeof meta>

/** DST timezone と Sunday 指定の weekly catch-up schedule を編集する状態です。 */
export const DaylightSavingSchedule: Story = {}

/** 31日指定の monthly schedule を編集する状態です。 */
export const MonthlyDayOfMonth: Story = {
  args: {
    initialSchedule: {
      catchUpPolicy: 'latest',
      dayOfMonth: 31,
      frequency: 'monthly',
      interval: 1,
      localTime: '18:30',
      startDate: '2026-03-01',
      timeZone: 'Asia/Tokyo',
    },
  },
}

/** Active endpoint だけを選択できる inbound Webhook trigger です。 */
export const InboundWebhookTrigger: Story = {
  args: {
    initialSchedule: undefined,
    initialTriggerType: 'webhook',
    webhookEndpoints: [
      activeInboundWebhookEndpointFixture,
      pausedInboundWebhookEndpointFixture,
    ],
  },
}

/** Team-qualified Work Item Type trigger を編集する状態です。 */
export const WorkItemTypeTrigger: Story = {
  args: {
    initialSchedule: undefined,
    initialTriggerType: 'work-item-type',
  },
}

/** Relation trigger that starts a rule when a blocker or parent link changes. */
export const RelationTrigger: Story = {
  args: {
    initialSchedule: undefined,
    initialTriggerType: 'relation',
    locale: 'ja',
  },
}

/** Approval decision trigger that starts a rule when an approval request is decided. */
export const ApprovalDecisionTrigger: Story = {
  args: {
    initialSchedule: undefined,
    initialTriggerType: 'approval',
    locale: 'ja',
  },
}

/** Daily schedule with the due-soon days field, for rules such as "notify the assignee 3 days before". */
export const DueSoonSchedule: Story = {
  args: {
    initialSchedule: {
      catchUpPolicy: 'skip',
      frequency: 'daily',
      interval: 1,
      localTime: '09:00',
      startDate: '2026-03-01',
      timeZone: 'Asia/Tokyo',
    },
    locale: 'ja',
  },
}

/** Monthly schedule that runs on the last day of each month. */
export const MonthlyLastDay: Story = {
  args: {
    initialSchedule: {
      catchUpPolicy: 'latest',
      frequency: 'monthly',
      interval: 1,
      localTime: '18:00',
      monthlyDay: 'last-day',
      startDate: '2026-03-01',
      timeZone: 'Asia/Tokyo',
    },
    locale: 'ja',
  },
}
