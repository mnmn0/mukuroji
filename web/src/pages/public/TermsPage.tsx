import type { Locale } from '../../shared/i18n/i18n'
import { PublicLegalPage, type LegalSection } from './PublicLegalPage'

/**
 * 利用規約ページの Storybook 初期状態です。
 */
type TermsPageProps = {
  /**
   * Storybook などで固定する初期 locale です。
   */
  initialLocale?: Locale
}

const termsSections = [
  {
    id: 'agreement-and-scope',
    titleKey: 'public.terms.section.scope.title',
    paragraphKeys: [
      'public.terms.section.scope.body1',
      'public.terms.section.scope.body2',
    ],
  },
  {
    id: 'accounts',
    titleKey: 'public.terms.section.account.title',
    paragraphKeys: [
      'public.terms.section.account.body1',
      'public.terms.section.account.body2',
    ],
  },
  {
    id: 'workspace-content',
    titleKey: 'public.terms.section.content.title',
    paragraphKeys: [
      'public.terms.section.content.body1',
      'public.terms.section.content.body2',
    ],
  },
  {
    id: 'acceptable-use',
    titleKey: 'public.terms.section.use.title',
    paragraphKeys: [
      'public.terms.section.use.body1',
      'public.terms.section.use.body2',
    ],
  },
  {
    id: 'service-operation',
    titleKey: 'public.terms.section.operation.title',
    paragraphKeys: [
      'public.terms.section.operation.body1',
      'public.terms.section.operation.body2',
    ],
  },
  {
    id: 'suspension-and-termination',
    titleKey: 'public.terms.section.suspension.title',
    paragraphKeys: [
      'public.terms.section.suspension.body1',
      'public.terms.section.suspension.body2',
    ],
  },
  {
    id: 'responsibility',
    titleKey: 'public.terms.section.responsibility.title',
    paragraphKeys: [
      'public.terms.section.responsibility.body1',
      'public.terms.section.responsibility.body2',
    ],
  },
  {
    id: 'changes-and-contact',
    titleKey: 'public.terms.section.changes.title',
    paragraphKeys: [
      'public.terms.section.changes.body1',
      'public.terms.section.changes.body2',
    ],
  },
] as const satisfies readonly LegalSection[]

/**
 * mukuroji の利用条件と利用者・組織管理者の責任範囲を説明します。
 */
export function TermsPage({ initialLocale }: TermsPageProps = {}) {
  return (
    <PublicLegalPage
      eyebrowKey="public.terms.eyebrow"
      initialLocale={initialLocale}
      introKey="public.terms.intro"
      sections={termsSections}
      titleKey="public.terms.title"
      updatedKey="public.terms.updated"
    />
  )
}
