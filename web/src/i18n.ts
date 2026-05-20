export const localeOptions = [
  { locale: 'ja', label: '日本語' },
  { locale: 'en', label: 'English' },
] as const

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
    'login.forgotPassword': 'パスワードを忘れた場合',
    'footer.aria': '補助リンク',
    'footer.privacy': 'プライバシーポリシー',
    'footer.terms': '利用規約',
    'footer.support': 'サポート',
    'footer.copyright': '© 2026 mukuroji. All rights reserved.',
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
    'login.forgotPassword': 'Forgot your password?',
    'footer.aria': 'Auxiliary links',
    'footer.privacy': 'Privacy policy',
    'footer.terms': 'Terms of use',
    'footer.support': 'Support',
    'footer.copyright': '© 2026 mukuroji. All rights reserved.',
  },
} as const

export type MessageKey = keyof (typeof dictionaries)['ja']

function resolveLocale(value: string | null | undefined): Locale {
  return value?.toLowerCase().startsWith('en') ? 'en' : 'ja'
}

export function getInitialLocale(): Locale {
  const savedLocale = window.localStorage.getItem(storageKey)

  if (savedLocale) {
    return resolveLocale(savedLocale)
  }

  return resolveLocale(window.navigator.language)
}

export function setLocalePreference(locale: Locale) {
  window.localStorage.setItem(storageKey, locale)
}

export function createTranslator(locale: Locale) {
  return (key: MessageKey) => dictionaries[locale][key]
}
