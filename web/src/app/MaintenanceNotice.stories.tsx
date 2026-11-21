import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import type { MaintenanceNoticeState, MaintenanceStore } from '../shared/api/maintenance'
import { MaintenanceNotice } from './MaintenanceNotice'

/**
 * Creates a store that always reports one maintenance state.
 *
 * @param state - Reported state.
 * @returns A fixed maintenance store.
 */
function fixedMaintenance(state: MaintenanceNoticeState): MaintenanceStore {
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => state,
    observe: () => undefined,
    refresh: async () => undefined,
  }
}

const meta = {
  title: 'Application/Maintenance Notice',
  component: MaintenanceNotice,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof MaintenanceNotice>

/** Banner shown at the top of the app while the API is in maintenance. */
export default meta

/** Story variants for each maintenance state. */
type Story = StoryObj<typeof meta>

/** Read-only maintenance: pages can be viewed, and changes are rejected. */
export const ReadOnly: Story = {
  args: { maintenance: fixedMaintenance('read-only') },
  play: async ({ canvasElement }) => {
    const notice = within(canvasElement).getByTestId('maintenance-notice')
    await expect(notice).toBeVisible()
    await expect(notice.dataset.maintenanceState).toBe('read-only')
  },
}

/** The API is stopped for maintenance. */
export const Stopped: Story = {
  args: { maintenance: fixedMaintenance('stopped') },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('maintenance-notice').dataset.maintenanceState).toBe('stopped')
  },
}

/** No maintenance; nothing is shown. */
export const None: Story = {
  args: { maintenance: fixedMaintenance('none') },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByTestId('maintenance-notice')).toBeNull()
  },
}
