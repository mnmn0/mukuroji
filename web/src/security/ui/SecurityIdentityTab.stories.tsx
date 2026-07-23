import { useState, type ComponentProps } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { enterpriseSecuritySnapshotFixture } from '../fixtures'
import { resolveEnterpriseSsoPrerequisites } from '../model/enterpriseSecurityReadiness'
import { SecurityIdentityTab } from './SecurityIdentityTab'

const claimedDomain = enterpriseSecuritySnapshotFixture.domains[1]
if (!claimedDomain) {
  throw new Error('Enterprise security domain fixture is incomplete.')
}

/** Storybook metadata for the independently rendered identity tab. */
const meta = {
  title: 'Application/Settings/Enterprise Security/Tabs/Identity',
  component: SecurityIdentityTab,
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
    prerequisites: resolveEnterpriseSsoPrerequisites(
      enterpriseSecuritySnapshotFixture,
    ),
    snapshot: enterpriseSecuritySnapshotFixture,
    t: createTranslator('en'),
    onCreateDomain: fn(async () => ({
      domain: claimedDomain,
      verificationRecordValue: 'mukuroji-verification=storybook-one-time-value',
    })),
    onRequestEnforcement: fn(),
    onUpdateIdentityProvider: fn(async () => undefined),
    onVerifyDomain: fn(async () => undefined),
  },
} satisfies Meta<typeof SecurityIdentityTab>

export default meta

/** Story type for the enterprise security identity tab. */
type Story = StoryObj<typeof meta>

/**
 * Updates the provider version after domain creation to exercise the form key.
 *
 * @param props - Identity tab story props.
 * @returns The identity tab with a changing provider-version boundary.
 */
function IdentityVersionBoundaryStory(
  props: ComponentProps<typeof SecurityIdentityTab>,
) {
  const [snapshot, setSnapshot] = useState(props.snapshot)

  return (
    <SecurityIdentityTab
      {...props}
      snapshot={snapshot}
      onCreateDomain={async (input) => {
        if (!props.onCreateDomain) {
          throw new Error('The identity boundary story requires domain creation.')
        }

        const challenge = await props.onCreateDomain(input)
        setSnapshot((current) => ({
          ...current,
          identityProvider: {
            ...current.identityProvider,
            version: current.identityProvider.version + 1,
          },
        }))
        return challenge
      }}
    />
  )
}

/** Creates a domain claim and preserves its value across a form remount. */
export const DomainClaimInteraction: Story = {
  render: (args) => <IdentityVersionBoundaryStory {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByTestId('security-domain-input'),
      'New.Example',
    )
    await userEvent.click(canvas.getByRole('button', { name: 'Add domain' }))
    await expect(args.onCreateDomain).toHaveBeenCalledWith({
      domain: 'new.example',
    })
    const notice = await canvas.findByTestId(
      'enterprise-domain-verification-challenge',
    )
    await expect(notice).toBeInTheDocument()
  },
}
