import type { PlanningSnapshot } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, fn, userEvent, within } from 'storybook/test'
import { planningSnapshotFixture } from '../../planning/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkItemDependencyPanel } from './WorkItemDependencyPanel'

const t = createTranslator('ja')

/** Storybook metadata for canonical Work Item schedule-dependency management. */
const meta = {
  title: 'Application/Work Items/Schedule Dependencies',
  component: WorkItemDependencyPanel,
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6">
        <section className="workbench-panel mx-auto max-w-5xl p-5">
          <Story />
        </section>
      </main>
    ),
  ],
  args: {
    onCreate: fn(),
    onDelete: fn(),
    onUpdate: fn(),
    snapshot: planningSnapshotFixture,
    t,
  },
} satisfies Meta<typeof WorkItemDependencyPanel>

export default meta

/** Story type for the canonical Work Item dependency panel. */
type Story = StoryObj<typeof meta>

/** Workspace management view with critical path, constraint, and editable edge. */
export const Management: Story = {}

/** Selected Work Item view with incoming/outgoing creation controls and chips. */
export const CurrentWorkItem: Story = {
  args: {
    currentEndpoint: { teamId: 'core-team', workItemId: 'journey-events' },
  },
}

/** Read-only projection used when the current user lacks manager permissions. */
export const ReadOnly: Story = {
  args: {
    currentEndpoint: { teamId: 'core-team', workItemId: 'journey-events' },
    onCreate: undefined,
    onDelete: undefined,
    onUpdate: undefined,
  },
}

/** Creates the newer authoritative snapshot used to verify editor remount behavior. */
function createRefreshedPlanningSnapshot(): PlanningSnapshot {
  return {
    ...planningSnapshotFixture,
    revision: planningSnapshotFixture.revision + 1,
    workItemDependencies: planningSnapshotFixture.workItemDependencies.map((dependency) =>
      dependency.id === 'work-item-dependency-copy-events'
        ? {
            ...dependency,
            lagDays: 4,
            type: 'start-to-start',
            updatedAt: '2026-07-16T04:00:00.000Z',
          }
        : dependency
    ),
  }
}

/** Renders a user-edited row followed by a newer server-owned version of the same dependency. */
function AuthoritativeRefreshHarness() {
  const [snapshot, setSnapshot] = useState<PlanningSnapshot>(planningSnapshotFixture)

  return (
    <div className="grid gap-4">
      <button
        className="workbench-button-secondary min-h-10 px-4"
        onClick={() => setSnapshot(createRefreshedPlanningSnapshot())}
        type="button"
      >
        最新データを再読込
      </button>
      <WorkItemDependencyPanel
        onUpdate={() => undefined}
        snapshot={snapshot}
        t={t}
      />
    </div>
  )
}

/** A refreshed `updatedAt` replaces stale uncontrolled rule fields after a conflict reload. */
export const AuthoritativeRefresh: Story = {
  render: () => <AuthoritativeRefreshHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const row = within(canvas.getByTestId('work-item-dependency-work-item-dependency-copy-events'))
    const typeSelect = row.getByRole('combobox', { name: t('workItems.dependencies.type') })

    await userEvent.selectOptions(typeSelect, 'start-to-finish')
    await expect(typeSelect).toHaveValue('start-to-finish')
    await userEvent.click(canvas.getByRole('button', { name: '最新データを再読込' }))
    const refreshedRow = within(
      canvas.getByTestId('work-item-dependency-work-item-dependency-copy-events'),
    )
    await expect(
      refreshedRow.getByRole('combobox', { name: t('workItems.dependencies.type') }),
    ).toHaveValue('start-to-start')
    await expect(refreshedRow.getByRole('spinbutton', {
      name: t('workItems.dependencies.lagDays'),
    })).toHaveValue(4)
  },
}
