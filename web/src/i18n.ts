import type { SidebarLabels, SidebarNavId } from './components/sidebar'

/**
 * ユーザーが選択できる表示言語の一覧です。
 */
export const localeOptions = [
  { locale: 'ja', label: '日本語' },
  { locale: 'en', label: 'English' },
] as const

/**
 * mukuroji がサポートする locale code です。
 */
export type Locale = (typeof localeOptions)[number]['locale']

const storageKey = 'mukuroji.locale'

const dictionaries = {
  ja: {
    'app.title': 'mukuroji',
    'language.aria': '表示言語を選択',
    'story.title': '進捗を、静かに前へ。',
    'story.description':
      'mukuroji は、プロジェクトの状態、タスクの流れ、チームの次の一手をひとつの画面で見渡せる進捗管理ツールです。',
    'preview.aria': 'mukuroji の進捗ダッシュボードのダミープレビュー',
    'preview.nav.dashboard': 'ダッシュボード',
    'preview.nav.projects': 'プロジェクト',
    'preview.nav.tasks': 'タスク',
    'preview.nav.reports': 'レポート',
    'preview.heading': '進捗サマリー',
    'preview.period': '今週',
    'preview.stat.projects': '進行中',
    'preview.stat.completed': '完了タスク',
    'preview.stat.blocked': '要確認',
    'preview.progress': 'プロジェクト進捗',
    'preview.project.website': 'Webリニューアル',
    'preview.project.mobile': 'モバイル改善',
    'preview.project.release': '春リリース',
    'preview.health': '状態',
    'preview.healthText': '主要タスクは予定通りに進行中',
    'login.title': 'ログイン',
    'login.subtitle': 'アカウントにサインインしてください',
    'login.email': 'メールアドレス',
    'login.emailPlaceholder': 'メールアドレスを入力',
    'login.password': 'パスワード',
    'login.passwordPlaceholder': 'パスワードを入力',
    'login.showPassword': 'パスワードを表示',
    'login.hidePassword': 'パスワードを非表示',
    'login.remember': 'ログイン状態を保持',
    'login.submit': 'ログイン',
    'login.loading': 'ログイン中',
    'login.errorInvalid': 'メールアドレスまたはパスワードが正しくありません。',
    'login.errorUnavailable':
      'ローカル Cognito がまだ準備できていません。Floci の起動状態を確認してください。',
    'login.errorUnknown':
      'ログインに失敗しました。時間をおいてもう一度お試しください。',
    'login.forgotPassword': 'パスワードを忘れた場合',
    'dashboard.title': 'ダッシュボード',
    'dashboard.subtitle':
      'Cognito で認証されたユーザーとして、ローカル環境の mukuroji にアクセスしています。',
    'dashboard.loading': 'ユーザー情報を確認しています。',
    'dashboard.authProvider': 'Cognito 認証',
    'dashboard.authProviderValue': 'Floci のローカル Cognito ユーザープールで認証済み',
    'dashboard.signedInAs': 'ログイン中のユーザー',
    'dashboard.logout': 'ログアウト',
    'dashboard.stat.projects': '進行中プロジェクト',
    'dashboard.stat.tasks': '未完了タスク',
    'dashboard.stat.blocked': '要確認',
    'dashboard.team.core': 'コアチーム',
    'dashboard.team.design': 'デザインチーム',
    'dashboard.project.productRoadmap': 'プロダクトロードマップ',
    'dashboard.project.releasePlan': 'リリース計画',
    'dashboard.project.customerFeedback': '顧客フィードバック',
    'footer.aria': '補助リンク',
    'footer.privacy': 'プライバシーポリシー',
    'footer.terms': '利用規約',
    'footer.support': 'サポート',
    'footer.copyright': '© 2026 mukuroji. All rights reserved.',
    'sidebar.aria': 'メインサイドバー',
    'sidebar.globalNavigation': 'グローバルナビゲーション',
    'sidebar.utilityNavigation': '補助ナビゲーション',
    'sidebar.collapse': 'サイドバーを折りたたむ',
    'sidebar.expand': 'サイドバーを展開する',
    'sidebar.teamProjects': 'チーム / プロジェクト',
    'sidebar.createTeam': 'チームを追加',
    'sidebar.teamOverview': 'チーム概要',
    'sidebar.members': 'メンバー',
    'sidebar.projectGroup': 'プロジェクト',
    'sidebar.unreadCount': '{count}件の未読',
    'sidebar.nav.home': 'ホーム',
    'sidebar.nav.myTasks': 'マイタスク',
    'sidebar.nav.inbox': '受信箱',
    'sidebar.nav.dashboard': 'ダッシュボード',
    'sidebar.nav.reports': 'レポート',
    'sidebar.nav.invite': '招待する',
    'sidebar.nav.help': 'ヘルプ',
    'sidebar.nav.settings': '設定',
    'placeholder.backToLogin': 'ログインへ戻る',
    'placeholder.forgotPassword.title': 'パスワード再設定',
    'placeholder.forgotPassword.description':
      'パスワード再設定フローは後続の実装で接続します。',
    'placeholder.privacy.title': 'プライバシーポリシー',
    'placeholder.privacy.description':
      'プライバシーポリシーの本文は後続の実装で追加します。',
    'placeholder.terms.title': '利用規約',
    'placeholder.terms.description':
      '利用規約の本文は後続の実装で追加します。',
    'placeholder.support.title': 'サポート',
    'placeholder.support.description':
      'サポートページは後続の実装で追加します。',
  },
  en: {
    'app.title': 'mukuroji',
    'language.aria': 'Select display language',
    'story.title': 'Move progress forward, calmly.',
    'story.description':
      'mukuroji helps teams see project status, task flow, and the next move from a single progress workspace.',
    'preview.aria': 'Dummy preview of the mukuroji progress dashboard',
    'preview.nav.dashboard': 'Dashboard',
    'preview.nav.projects': 'Projects',
    'preview.nav.tasks': 'Tasks',
    'preview.nav.reports': 'Reports',
    'preview.heading': 'Progress summary',
    'preview.period': 'This week',
    'preview.stat.projects': 'Active',
    'preview.stat.completed': 'Done',
    'preview.stat.blocked': 'Needs review',
    'preview.progress': 'Project progress',
    'preview.project.website': 'Website refresh',
    'preview.project.mobile': 'Mobile updates',
    'preview.project.release': 'Spring release',
    'preview.health': 'Health',
    'preview.healthText': 'Core tasks are tracking on schedule',
    'login.title': 'Log in',
    'login.subtitle': 'Sign in to your account',
    'login.email': 'Email address',
    'login.emailPlaceholder': 'Enter your email address',
    'login.password': 'Password',
    'login.passwordPlaceholder': 'Enter your password',
    'login.showPassword': 'Show password',
    'login.hidePassword': 'Hide password',
    'login.remember': 'Keep me signed in',
    'login.submit': 'Log in',
    'login.loading': 'Logging in',
    'login.errorInvalid': 'The email address or password is incorrect.',
    'login.errorUnavailable':
      'Local Cognito is not ready yet. Check the Floci service status.',
    'login.errorUnknown': 'Login failed. Please try again later.',
    'login.forgotPassword': 'Forgot your password?',
    'dashboard.title': 'Dashboard',
    'dashboard.subtitle':
      'You are accessing local mukuroji as a user authenticated by Cognito.',
    'dashboard.loading': 'Checking user information.',
    'dashboard.authProvider': 'Cognito auth',
    'dashboard.authProviderValue':
      'Authenticated with the Floci local Cognito user pool',
    'dashboard.signedInAs': 'Signed in as',
    'dashboard.logout': 'Log out',
    'dashboard.stat.projects': 'Active projects',
    'dashboard.stat.tasks': 'Open tasks',
    'dashboard.stat.blocked': 'Needs review',
    'dashboard.team.core': 'Core Team',
    'dashboard.team.design': 'Design Team',
    'dashboard.project.productRoadmap': 'Product Roadmap',
    'dashboard.project.releasePlan': 'Release Plan',
    'dashboard.project.customerFeedback': 'Customer Feedback',
    'footer.aria': 'Auxiliary links',
    'footer.privacy': 'Privacy policy',
    'footer.terms': 'Terms of use',
    'footer.support': 'Support',
    'footer.copyright': '© 2026 mukuroji. All rights reserved.',
    'sidebar.aria': 'Main sidebar',
    'sidebar.globalNavigation': 'Global navigation',
    'sidebar.utilityNavigation': 'Utility navigation',
    'sidebar.collapse': 'Collapse sidebar',
    'sidebar.expand': 'Expand sidebar',
    'sidebar.teamProjects': 'Teams / Projects',
    'sidebar.createTeam': 'Create team',
    'sidebar.teamOverview': 'Team overview',
    'sidebar.members': 'Members',
    'sidebar.projectGroup': 'Projects',
    'sidebar.unreadCount': '{count} unread',
    'sidebar.nav.home': 'Home',
    'sidebar.nav.myTasks': 'My tasks',
    'sidebar.nav.inbox': 'Inbox',
    'sidebar.nav.dashboard': 'Dashboard',
    'sidebar.nav.reports': 'Reports',
    'sidebar.nav.invite': 'Invite',
    'sidebar.nav.help': 'Help',
    'sidebar.nav.settings': 'Settings',
    'placeholder.backToLogin': 'Back to login',
    'placeholder.forgotPassword.title': 'Reset password',
    'placeholder.forgotPassword.description':
      'The password reset flow will be connected in a later implementation.',
    'placeholder.privacy.title': 'Privacy policy',
    'placeholder.privacy.description':
      'The privacy policy content will be added in a later implementation.',
    'placeholder.terms.title': 'Terms of use',
    'placeholder.terms.description':
      'The terms content will be added in a later implementation.',
    'placeholder.support.title': 'Support',
    'placeholder.support.description':
      'The support page will be added in a later implementation.',
  },
} as const

/**
 * i18n dictionary に定義された翻訳キーです。
 */
export type MessageKey = keyof (typeof dictionaries)['ja']

function resolveLocale(value: string | null | undefined): Locale {
  return value?.toLowerCase().startsWith('en') ? 'en' : 'ja'
}

/**
 * 保存済み設定またはブラウザ言語から初期 locale を解決します。
 */
export function getInitialLocale(): Locale {
  const savedLocale = window.localStorage.getItem(storageKey)

  if (savedLocale) {
    return resolveLocale(savedLocale)
  }

  return resolveLocale(window.navigator.language)
}

/**
 * ユーザーが選択した locale をブラウザに保存します。
 */
export function setLocalePreference(locale: Locale) {
  window.localStorage.setItem(storageKey, locale)
}

/**
 * 指定 locale の翻訳関数を生成します。
 */
export function createTranslator(locale: Locale) {
  return (key: MessageKey) => dictionaries[locale][key]
}

/**
 * Sidebar コンポーネントへ渡す i18n 済みラベルを生成します。
 */
export function createSidebarLabels(locale: Locale): SidebarLabels {
  const t = createTranslator(locale)
  const navKeyMap: Record<SidebarNavId, MessageKey> = {
    home: 'sidebar.nav.home',
    'my-tasks': 'sidebar.nav.myTasks',
    inbox: 'sidebar.nav.inbox',
    dashboard: 'sidebar.nav.dashboard',
    reports: 'sidebar.nav.reports',
    invite: 'sidebar.nav.invite',
    help: 'sidebar.nav.help',
    settings: 'sidebar.nav.settings',
  }

  return {
    ariaLabel: t('sidebar.aria'),
    globalNavigation: t('sidebar.globalNavigation'),
    utilityNavigation: t('sidebar.utilityNavigation'),
    collapse: t('sidebar.collapse'),
    expand: t('sidebar.expand'),
    teamProjects: t('sidebar.teamProjects'),
    createTeam: t('sidebar.createTeam'),
    teamOverview: t('sidebar.teamOverview'),
    members: t('sidebar.members'),
    projectGroup: t('sidebar.projectGroup'),
    unreadCount: (count) =>
      t('sidebar.unreadCount').replace('{count}', String(count)),
    nav: {
      home: t(navKeyMap.home),
      'my-tasks': t(navKeyMap['my-tasks']),
      inbox: t(navKeyMap.inbox),
      dashboard: t(navKeyMap.dashboard),
      reports: t(navKeyMap.reports),
      invite: t(navKeyMap.invite),
      help: t(navKeyMap.help),
      settings: t(navKeyMap.settings),
    },
  }
}
