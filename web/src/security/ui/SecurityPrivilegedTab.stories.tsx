import { useState, type ComponentProps } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import {
  enterpriseSecuritySnapshotFixture,
  enterpriseServiceAccountCredentialResponseFixture,
} from '../fixtures'
import type { EnterpriseSecurityScopeOption } from '../model/enterpriseSecurityForms'
import { SecurityPrivilegedTab } from './SecurityPrivilegedTab'

const scopeOptions: EnterpriseSecurityScopeOption[] = [
  { id: 'workspace-demo', name: 'Workspace', type: 'workspace' },
  { id: 'core-team', name: 'Core team', type: 'team' },
  { id: 'refero', name: 'Refero · Core team', type: 'project' },
]

/** Storybook metadata for the independently rendered privileged tab. */
const meta = {
  title: 'Application/Settings/Enterprise Security/Tabs/Privileged',
  component: SecurityPrivilegedTab,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6">
        <Story />
      </main>
    ),
  ],
  args: {
    locale: 'en',
    scopeOptions,
    snapshot: enterpriseSecuritySnapshotFixture,
    t: createTranslator('en'),
    onCreateServiceAccount: fn(
      async () => enterpriseServiceAccountCredentialResponseFixture,
    ),
    onRegisterBreakGlass: fn(async () => undefined),
    onRequestDeactivateBreakGlass: fn(),
    onRequestRevokeServiceAccount: fn(),
    onRequestRotateServiceAccount: fn(),
    onTestBreakGlass: fn(async () => undefined),
  },
} satisfies Meta<typeof SecurityPrivilegedTab>

export default meta

/** Story type for the enterprise security privileged tab. */
type Story = StoryObj<typeof meta>

/**
 * Updates a role version after account creation to exercise the form key.
 *
 * @param props - Privileged tab story props.
 * @returns The privileged tab with a changing role-version boundary.
 */
function PrivilegedVersionBoundaryStory(
  props: ComponentProps<typeof SecurityPrivilegedTab>,
) {
  const [snapshot, setSnapshot] = useState(props.snapshot)

  return (
    <SecurityPrivilegedTab
      {...props}
      snapshot={snapshot}
      onCreateServiceAccount={async (input) => {
        if (!props.onCreateServiceAccount) {
          throw new Error(
            'The privileged boundary story requires service-account creation.',
          )
        }

        const response = await props.onCreateServiceAccount(input)
        setSnapshot((current) => ({
          ...current,
          roles: current.roles.map((role, index) =>
            index === 0 ? { ...role, version: role.version + 1 } : role,
          ),
        }))
        return response
      }}
    />
  )
}

/** Creates an account and resets its form across a role-version remount. */
export const CreateServiceAccountInteraction: Story = {
  render: (args) => <PrivilegedVersionBoundaryStory {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByRole('textbox', { name: /Service account name/i }),
      'Storybook bot',
    )
    await userEvent.selectOptions(
      canvas.getByRole('combobox', { name: /Role/i }),
      'workspace:member',
    )
    await userEvent.click(
      canvas.getByRole('button', { name: /Create account/i }),
    )
    await expect(args.onCreateServiceAccount).toHaveBeenCalledTimes(1)
    await expect(
      canvas.getByRole('textbox', { name: /Service account name/i }),
    ).toHaveValue('')
  },
}
