import type { Meta, StoryObj } from '@storybook/react-vite'
import type { PushDeviceController } from '../mutations/usePushDevice'
import { PushDeviceSettings } from './PushDeviceSettings'

/** Controller with no-op actions for stories. */
const offController: PushDeviceController = {
  status: 'off',
  pending: false,
  enable: () => undefined,
  disable: () => undefined,
  retry: () => undefined,
}

/** Registers or removes this device for push notifications. */
const meta = {
  title: 'Application/Notifications/Push Device',
  component: PushDeviceSettings,
  parameters: { layout: 'padded' },
  args: { locale: 'ja', controller: offController },
} satisfies Meta<typeof PushDeviceSettings>

/** Registers the push device stories in Storybook. */
export default meta
/** Story type for the push device card. */
type Story = StoryObj<typeof meta>
/** Not registered yet; the member can turn it on. */
export const Off: Story = {}
/** Registered after the member allowed notifications. */
export const On: Story = { args: { controller: { ...offController, status: 'on', result: 'enabled' } } }
/** A request is running; the button stays focusable but inactive. */
export const Pending: Story = { args: { controller: { ...offController, pending: true } } }
/** Status is still loading. */
export const Loading: Story = { args: { controller: { ...offController, status: 'loading' } } }
/** Notifications are denied in the browser. */
export const Blocked: Story = { args: { controller: { ...offController, status: 'blocked', result: 'denied' } } }
/** The browser lacks the Push API. */
export const Unsupported: Story = { args: { controller: { ...offController, status: 'unsupported' } } }
/** The deployment has no push key. */
export const Disabled: Story = { args: { controller: { ...offController, status: 'disabled' } } }
/** The configuration could not be loaded. */
export const LoadError: Story = { args: { controller: { ...offController, status: 'load-error' } } }
/** The last change failed. */
export const Failed: Story = { args: { controller: { ...offController, result: 'failed' } } }
