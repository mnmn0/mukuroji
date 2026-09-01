import type { CustomerImpactSignal } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../shared/i18n/i18n'
import { CustomerImpactPanel } from './CustomerImpactPanel'

const t = createTranslator('ja')

const signal = {
  businessValueTotal: 165,
  customerCount: 2,
  customers: [
    {
      businessValue: 90,
      customerId: 'acme',
      health: 'watch',
      name: 'Acme Corporation',
      requestCount: 2,
      tier: 'enterprise',
    },
    {
      businessValue: 75,
      customerId: 'globex',
      health: 'healthy',
      name: 'Globex Inc.',
      requestCount: 1,
      tier: 'growth',
    },
  ],
    highestBusinessValue: 90,
    highestImportance: 'high',
    openRequestCount: 2,
    prioritySignal: 'high',
    requests: [
      {
        customerId: 'acme',
        importance: 'high',
        receivedAt: '2026-08-01T00:00:00.000Z',
        requestId: 'request-1',
        sourceKind: 'email',
        status: 'requested',
      },
      {
        customerId: 'globex',
        importance: 'normal',
        receivedAt: '2026-07-31T00:00:00.000Z',
        requestId: 'request-2',
        sourceKind: 'portal',
        status: 'in-progress',
      },
    ],
    requestCount: 3,
} satisfies CustomerImpactSignal

/** Storybook metadata for the Customer impact summary. */
const meta = {
  title: 'Application/Customers/Customer Impact Panel',
  component: CustomerImpactPanel,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
        <div className="mx-auto max-w-2xl overflow-hidden rounded-lg border border-[var(--workbench-border)]">
          <Story />
        </div>
      </main>
    ),
  ],
  args: {
    signal,
    t,
  },
} satisfies Meta<typeof CustomerImpactPanel>

export default meta

/** Story type for the Customer impact panel. */
type Story = StoryObj<typeof meta>

/** Typical multi-customer impact with an elevated priority signal. */
export const Default: Story = {}

/** Empty impact remains explicit when an aggregate has no contributing accounts. */
export const NoKnownImpact: Story = {
  args: {
    signal: {
      businessValueTotal: 0,
      customerCount: 0,
      customers: [],
      openRequestCount: 0,
      prioritySignal: 'none',
      requests: [],
      requestCount: 0,
    },
  },
}
