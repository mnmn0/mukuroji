import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReactElement } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { ForgotPasswordPage } from './ForgotPasswordPage'
import { NotFoundPage } from './NotFoundPage'
import { PrivacyPage } from './PrivacyPage'
import { SupportPage } from './SupportPage'
import { TermsPage } from './TermsPage'

const meta = {
  title: 'Application/Public Pages',
  parameters: {
    layout: 'fullscreen',
    controls: {
      disable: true,
    },
  },
} satisfies Meta

/**
 * 公開ページ群の Storybook meta です。
 */
export default meta

/**
 * 公開ページ Story の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * 公開ページを指定URLの memory router 内に描画します。
 */
function renderPublicPage(element: ReactElement, initialEntry: string) {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element,
      },
    ],
    {
      initialEntries: [initialEntry],
    },
  )

  return <RouterProvider router={router} />
}

/**
 * 未送信であることを明示するパスワード復旧の初期画面です。
 */
export const ForgotPassword: Story = {
  render: () => renderPublicPage(<ForgotPasswordPage initialLocale="ja" />, '/forgot-password'),
}

/**
 * 有効なメール入力後に安全な連絡メモを表示した復旧画面です。
 */
export const ForgotPasswordGuidance: Story = {
  render: () => renderPublicPage(
    <ForgotPasswordPage
      initialEmail="demo@example.com"
      initialGuidanceVisible
      initialLocale="ja"
    />,
    '/forgot-password',
  ),
}

/**
 * 目次と実本文を持つ日本語プライバシーポリシーです。
 */
export const Privacy: Story = {
  render: () => renderPublicPage(<PrivacyPage initialLocale="ja" />, '/privacy'),
}

/**
 * 英語の長文可読性を確認するプライバシーポリシーです。
 */
export const PrivacyEnglish: Story = {
  render: () => renderPublicPage(<PrivacyPage initialLocale="en" />, '/privacy'),
}

/**
 * 目次と実本文を持つ利用規約です。
 */
export const Terms: Story = {
  render: () => renderPublicPage(<TermsPage initialLocale="ja" />, '/terms'),
}

/**
 * FAQ検索、カテゴリ、問い合わせ導線をまとめたサポート画面です。
 */
export const Support: Story = {
  render: () => renderPublicPage(<SupportPage initialLocale="ja" />, '/support'),
}

/**
 * アカウントカテゴリを選択済みにしたサポート画面です。
 */
export const SupportAccountAccess: Story = {
  render: () => renderPublicPage(
    <SupportPage initialLocale="ja" />,
    '/support?topic=access',
  ),
}

/**
 * 検索結果がない場合の復帰導線を表示するサポート画面です。
 */
export const SupportNoResults: Story = {
  render: () => renderPublicPage(
    <SupportPage initialLocale="ja" initialQuery="存在しない質問" />,
    '/support',
  ),
}

/**
 * 不明なURLと復帰先を表示する専用404画面です。
 */
export const NotFound: Story = {
  render: () => renderPublicPage(<NotFoundPage initialLocale="ja" />, '/unknown/workspace'),
}

/**
 * 英語表示の専用404画面です。
 */
export const NotFoundEnglish: Story = {
  render: () => renderPublicPage(<NotFoundPage initialLocale="en" />, '/unknown/workspace'),
}
