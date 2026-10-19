import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import type { ConnectivityStore } from '../../shared/lib/pwa/connectivity'
import { ConnectivityNotice } from './ConnectivityNotice'

/**
 * Creates a store that always reports one connectivity value.
 *
 * @param online - Reported connectivity.
 * @returns A fixed connectivity store.
 */
function fixedConnectivity(online: boolean): ConnectivityStore {
  return { subscribe: () => () => undefined, getSnapshot: () => online }
}

const meta = {
  title: 'Application/PWA/Connectivity Notice',
  component: ConnectivityNotice,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ConnectivityNotice>

/** Bar shown at the top of the app while the device has no connection. */
export default meta

/** Story variants for each connectivity state. */
type Story = StoryObj<typeof meta>

/** The device is offline; the bar stays until the connection returns. */
export const Offline: Story = {
  args: { connectivity: fixedConnectivity(false), isUpdateNoticeShown: false },
  play: async ({ canvasElement }) => {
    // The copy follows the saved or browser locale, so only its presence is asserted.
    const notice = within(canvasElement).getByTestId('connectivity-notice')
    await expect(notice).toBeVisible()
    await expect(notice.textContent?.trim()).not.toBe('')
  },
}

/** The update notice occupies the bottom edge, so the offline notice steps aside. */
export const BehindUpdateNotice: Story = {
  args: { connectivity: fixedConnectivity(false), isUpdateNoticeShown: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByTestId('connectivity-notice')).toBeNull()
  },
}

/** The device is online; nothing is shown. */
export const Online: Story = {
  args: { connectivity: fixedConnectivity(true), isUpdateNoticeShown: false },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByTestId('connectivity-notice')).toBeNull()
  },
}
