import type { Meta, StoryObj } from '@storybook/react-vite'
import { AutomationRuleEditor } from './AutomationEditors'
import {
  activeInboundWebhookEndpointFixture,
  pausedInboundWebhookEndpointFixture,
} from './fixtures'

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
