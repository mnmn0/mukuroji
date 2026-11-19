import type { Meta, StoryObj } from '@storybook/react-vite'
import type { PlanningEntity } from '@mukuroji/contracts'
import { fn } from 'storybook/test'
import { planningSnapshotFixture } from '../../planning/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import { CycleBurndownPanel } from './CycleBurndownPanel'

const cycle: PlanningEntity = {
  ...planningSnapshotFixture.entities[0]!,
  id: 'cycle-47',
  type: 'cycle',
  title: 'Sprint 47',
  baseline: { startDate: '2026-11-12', endDate: '2026-11-25' },
}

const series = [12, 11, 11, 9, 7, 6].map((remaining, index) => {
  const from = new Date(Date.UTC(2026, 10, 11, 15) + index * 86_400_000)
  return {
    from: from.toISOString(),
    to: new Date(from.getTime() + 86_400_000 - 1).toISOString(),
    value: remaining,
    sampleSize: remaining,
  }
})

const meta = {
  title: 'Application/Analytics/CycleBurndownPanel',
  component: CycleBurndownPanel,
  args: {
    cycle,
    locale: 'ja',
    onRetry: fn(),
    state: { kind: 'ready', series },
    t: createTranslator('ja'),
    timeZone: 'Asia/Tokyo',
  },
} satisfies Meta<typeof CycleBurndownPanel>

export default meta

type Story = StoryObj<typeof meta>

/** Loaded burndown. */
export const Ready: Story = {}

/** Waiting for the Analytics API. */
export const Loading: Story = { args: { state: { kind: 'loading' } } }

/** The Analytics request failed and can be retried. */
export const LoadFailed: Story = { args: { state: { kind: 'error' } } }

/** No Work Items are linked to the Cycle. */
export const Empty: Story = { args: { state: { kind: 'empty' } } }

/** The Cycle lists more Work Items than one Analytics query accepts. */
export const TooMany: Story = { args: { state: { kind: 'too-many' } } }
