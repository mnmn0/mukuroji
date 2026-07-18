import type { Meta, StoryObj } from '@storybook/react-vite'
import { EnterpriseDomainVerificationChallengeNotice } from './EnterpriseSecurityPanel'
import { enterpriseSecuritySnapshotFixture } from './fixtures'

/** EnterpriseDomainVerificationChallengeNotice の Storybook metadata です。 */
const meta = {
  title: 'Application/Settings/Enterprise Domain Verification Challenge',
  component: EnterpriseDomainVerificationChallengeNotice,
  parameters: {
    layout: 'padded',
  },
  args: {
    challenge: {
      domain: enterpriseSecuritySnapshotFixture.domains[1]!,
      verificationRecordValue:
        'mukuroji-verification=storybook-one-time-value',
    },
    locale: 'ja',
    onDismiss: () => undefined,
  },
} satisfies Meta<typeof EnterpriseDomainVerificationChallengeNotice>

export default meta

/** EnterpriseDomainVerificationChallengeNotice stories の型です。 */
type Story = StoryObj<typeof meta>

/** DNS に設定する TXT 値を claim 作成直後だけ表示する notice です。 */
export const Default: Story = {}

/** 英語 UI の one-time DNS challenge notice です。 */
export const English: Story = {
  args: {
    locale: 'en',
  },
}
