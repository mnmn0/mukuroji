import type { Meta, StoryObj } from '@storybook/react-vite'
import { OrgUnitScopesUnavailableNotice } from './OrgUnitScopesUnavailableNotice'

/** OrgUnitScopesUnavailableNotice の Storybook metadata です。 */
const meta = {
  title: 'Application/Settings/OrgUnit Scopes Unavailable',
  component: OrgUnitScopesUnavailableNotice,
  parameters: {
    layout: 'padded',
  },
  args: {
    locale: 'ja',
    onRetry: () => undefined,
  },
} satisfies Meta<typeof OrgUnitScopesUnavailableNotice>

export default meta

/** OrgUnitScopesUnavailableNotice stories の型です。 */
type Story = StoryObj<typeof meta>

/** 部門を読み込めず、割り当て先の候補に部門がないことを知らせます。 */
export const Japanese: Story = {}

/** The same notice in English. */
export const English: Story = {
  args: { locale: 'en' },
}
