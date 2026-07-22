import { describe, expect, test } from 'bun:test'
import {
  createSidebarLabels,
  createTranslator,
  type MessageKey,
} from '../src/shared/i18n/i18n'
import { createPlanningLabels } from '../src/planning/ui/labels'

const representativeMessages: ReadonlyArray<{
  key: MessageKey
  ja: string
  en: string
}> = [
  { key: 'story.title', ja: '進捗を、静かに前へ。', en: 'Move progress forward, calmly.' },
  { key: 'login.title', ja: 'ログイン', en: 'Log in' },
  { key: 'workspace.home.title', ja: 'ホーム', en: 'Home' },
  {
    key: 'tasks.breadcrumb.aria',
    ja: 'プロジェクトのパンくずリスト',
    en: 'Project breadcrumb',
  },
  { key: 'issues.eyebrow', ja: 'プロダクト Issue', en: 'Product issues' },
  { key: 'documents.title', ja: 'ドキュメント', en: 'Documents' },
  { key: 'collaboration.title', ja: 'ディスカッション', en: 'Discussion' },
  { key: 'automation.title', ja: 'オートメーション', en: 'Automation' },
  { key: 'analytics.title', ja: 'レポート', en: 'Reports' },
  { key: 'planning.title', ja: 'プランニング', en: 'Planning' },
  { key: 'requests.title', ja: 'リクエスト', en: 'Requests' },
  {
    key: 'public.nav.aria',
    ja: '公開ページナビゲーション',
    en: 'Public page navigation',
  },
  {
    key: 'security.title',
    ja: '組織のセキュリティ管理',
    en: 'Organization security controls',
  },
]

describe('domain message dictionaries', () => {
  test('translates representative screens in both supported locales', () => {
    const ja = createTranslator('ja')
    const en = createTranslator('en')

    for (const message of representativeMessages) {
      expect(ja(message.key)).toBe(message.ja)
      expect(en(message.key)).toBe(message.en)
    }
  })
})

describe('sidebar shortcut labels', () => {
  test('shows the supported modifier keys independently of locale', () => {
    expect(createSidebarLabels('ja').searchShortcut).toBe('Ctrl/⌘ K')
    expect(createSidebarLabels('en').searchShortcut).toBe('Ctrl/⌘ K')
  })

  test('localizes the Planning navigation entry', () => {
    expect(createSidebarLabels('ja').nav.planning).toBe('プランニング')
    expect(createSidebarLabels('en').nav.planning).toBe('Planning')
  })

  test('localizes Planning slack and entity type labels independently', () => {
    const ja = createPlanningLabels('ja')
    const en = createPlanningLabels('en')

    expect(ja.slackDays(3)).toBe('余裕日数: 3')
    expect(en.slackDays(3)).toBe('Slack (days): 3')
    expect(ja.entityType).toBe('計画種別')
    expect(en.entityType).toBe('Plan type')
  })
})
