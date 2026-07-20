import type { Meta, StoryObj } from '@storybook/react-vite'
import type { RequestLocale } from '@mukuroji/contracts'
import { useState } from 'react'
import {
  publicRequestFormFixture,
  requestSubmissionReceiptFixture,
} from './fixtures'
import { normalizePublicRequestForm } from './model/requestForm'
import {
  PublicRequestFormScreen,
  type PublicRequestFormScreenProps,
} from './PublicRequestFormPage'

/**
 * Public request form の Storybook metadata です。
 */
const meta = {
  title: 'Application/Requests/Public Form',
  component: PublicRequestFormScreen,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
        <div className="mx-auto max-w-[860px]"><Story /></div>
      </main>
    ),
  ],
  args: {
    form: normalizePublicRequestForm(publicRequestFormFixture),
    locale: 'ja',
    onLocaleChange: () => undefined,
    onReply: async () => ({
      receivedAt: '2026-07-16T02:05:00.000Z',
      replyId: 'reply-story',
    }),
    onSubmit: async () => requestSubmissionReceiptFixture,
    onUploadAttachment: async () => 'attachment-story',
  },
} satisfies Meta<typeof PublicRequestFormScreen>

/**
 * Public request form の Storybook metadata です。
 */
export default meta

/**
 * Public request form story の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Conditional field、consent、attachment を含む公開 form です。
 */
export const Default: Story = {
  render: (args) => <InteractivePublicRequestFormStory {...args} />,
}

/**
 * Internal identifiers を表示しない submit 完了状態です。
 */
export const Submitted: Story = {
  args: {
    initialReceipt: requestSubmissionReceiptFixture,
  },
}

function InteractivePublicRequestFormStory(args: PublicRequestFormScreenProps) {
  const [locale, setLocale] = useState<RequestLocale>(args.locale)

  return (
    <PublicRequestFormScreen
      {...args}
      locale={locale}
      onLocaleChange={setLocale}
    />
  )
}
