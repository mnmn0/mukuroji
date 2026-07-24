import type { Meta, StoryObj } from '@storybook/react-vite'
import { EnterpriseOneTimeSecretNotice } from './EnterpriseOneTimeSecretNotice'

/** EnterpriseOneTimeSecretNotice の Storybook metadata です。 */
const meta = {
  title: 'Application/Settings/Enterprise One-Time Secret',
  component: EnterpriseOneTimeSecretNotice,
  parameters: {
    layout: 'padded',
  },
  args: {
    kind: 'service-account',
    label: 'Release bot',
    locale: 'ja',
    token: 'svc_storybook_one_time_token',
    onDismiss: () => undefined,
  },
} satisfies Meta<typeof EnterpriseOneTimeSecretNotice>

export default meta

/** EnterpriseOneTimeSecretNotice stories の型です。 */
type Story = StoryObj<typeof meta>

/** Credential 発行直後だけ表示する service account token です。 */
export const ServiceAccountCredential: Story = {}

/** IdPへ保存するまで再表示できない SCIM bearer token です。 */
export const ScimCredential: Story = {
  args: {
    kind: 'scim',
    label: 'SCIM bearer token',
    locale: 'en',
    token: 'scim_storybook_one_time_token',
  },
}
