import {
  createRef,
  useRef,
  useState,
  type ComponentProps,
} from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { enterpriseSecuritySnapshotFixture } from '../fixtures'
import type { EnterpriseSecurityConfirmation } from '../model/enterpriseSecurityConfirmation'
import { EnterpriseSecurityConfirmationDialog } from './EnterpriseSecurityConfirmationDialog'

const serviceAccount = enterpriseSecuritySnapshotFixture.serviceAccounts[0]
if (!serviceAccount) {
  throw new Error('Enterprise security service account fixture is incomplete.')
}

const confirmation = {
  account: serviceAccount,
  kind: 'service-account-revoke',
} satisfies EnterpriseSecurityConfirmation

/** Storybook metadata for the standalone security confirmation dialog. */
const meta = {
  title: 'Application/Settings/Enterprise Security/Confirmation Dialog',
  component: EnterpriseSecurityConfirmationDialog,
  parameters: { layout: 'fullscreen' },
  args: {
    confirmation,
    isBusy: false,
    returnFocusRef: createRef<HTMLElement>(),
    t: createTranslator('en'),
    onConfirm: fn(async () => undefined),
    onRequestClose: fn(),
  },
} satisfies Meta<typeof EnterpriseSecurityConfirmationDialog>

export default meta

/** Story type for the enterprise security confirmation dialog. */
type Story = StoryObj<typeof meta>

/**
 * Provides a real return-focus target and owns the dialog open state.
 *
 * @param props - Confirmation dialog story props.
 * @returns A trigger button and conditionally mounted dialog.
 */
function ConfirmationDialogHarness(
  props: ComponentProps<typeof EnterpriseSecurityConfirmationDialog>,
) {
  const [isOpen, setIsOpen] = useState(true)
  const triggerRef = useRef<HTMLButtonElement>(null)

  return (
    <main className="min-h-screen bg-[var(--workbench-page)] p-6">
      <button
        className="workbench-button-primary min-h-10 px-4"
        data-testid="confirmation-trigger"
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(true)}
      >
        Open confirmation
      </button>
      {isOpen ? (
        <EnterpriseSecurityConfirmationDialog
          {...props}
          returnFocusRef={triggerRef}
          onRequestClose={() => {
            props.onRequestClose()
            setIsOpen(false)
          }}
        />
      ) : null}
    </main>
  )
}

/** Verifies focus wrapping, Escape dismissal, and focus restoration. */
export const DestructiveConfirmation: Story = {
  render: (args) => <ConfirmationDialogHarness {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const cancelButton = canvas.getByRole('button', { name: 'Cancel' })
    const confirmButton = canvas.getByRole('button', { name: 'Revoke' })
    const triggerButton = canvas.getByTestId('confirmation-trigger')

    await waitFor(() => expect(cancelButton).toHaveFocus())
    await userEvent.tab()
    await expect(confirmButton).toHaveFocus()
    await userEvent.tab()
    await expect(cancelButton).toHaveFocus()
    await userEvent.tab({ shift: true })
    await expect(confirmButton).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect(args.onRequestClose).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(triggerButton).toHaveFocus())
  },
}

/** Verifies that a busy destructive operation cannot dismiss the dialog. */
export const BusyConfirmation: Story = {
  args: { isBusy: true },
  render: (args) => <ConfirmationDialogHarness {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole('button', { name: 'Cancel' }),
    ).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    await expect(args.onRequestClose).not.toHaveBeenCalled()
    await expect(canvas.getByRole('dialog')).toBeInTheDocument()
  },
}
