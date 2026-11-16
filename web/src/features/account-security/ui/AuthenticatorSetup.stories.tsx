import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { AuthenticatorSetup } from './AuthenticatorSetup'

const setup = {
  accountName: 'member@example.com',
  secretCode: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
}

/** Storybook metadata for the authenticator app registration steps. */
const meta = {
  title: 'Application/Settings/Account Security/Authenticator Setup',
  component: AuthenticatorSetup,
  parameters: { layout: 'padded' },
  args: {
    t: createTranslator('ja'),
    onStart: fn(async () => setup),
    onVerify: fn(async () => undefined),
    onCancel: fn(),
  },
} satisfies Meta<typeof AuthenticatorSetup>

export default meta

/** Story type for the authenticator setup. */
type Story = StoryObj<typeof meta>

/** Before the secret is issued. */
export const Start: Story = {}

/** The QR code, the grouped manual key, and the code form. */
export const ScanAndVerify: Story = {
  args: { initialSetup: setup },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('authenticator-secret')).toHaveTextContent('JBSW Y3DP')
    await userEvent.type(canvas.getByRole('textbox'), '12a3456')
    await userEvent.click(canvas.getByRole('button', { name: '登録する' }))
    await expect(args.onVerify).toHaveBeenCalledWith('123456', setup)
  },
}

/** English copy. */
export const English: Story = {
  args: { initialSetup: setup, t: createTranslator('en') },
}
