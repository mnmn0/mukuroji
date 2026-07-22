import type { Locale } from '../../shared/i18n/i18n'
import { PublicLegalDocument, type LegalSection } from '../../features/public-site/ui/PublicLegalDocument'

/**
 * プライバシーポリシーページの Storybook 初期状態です。
 */
type PrivacyPageProps = {
  /**
   * Storybook などで固定する初期 locale です。
   */
  initialLocale?: Locale
}

const privacySections = [
  {
    id: 'scope',
    titleKey: 'public.privacy.section.scope.title',
    paragraphKeys: [
      'public.privacy.section.scope.body1',
      'public.privacy.section.scope.body2',
    ],
  },
  {
    id: 'data-we-handle',
    titleKey: 'public.privacy.section.data.title',
    paragraphKeys: [
      'public.privacy.section.data.body1',
      'public.privacy.section.data.body2',
    ],
  },
  {
    id: 'purpose',
    titleKey: 'public.privacy.section.purpose.title',
    paragraphKeys: [
      'public.privacy.section.purpose.body1',
      'public.privacy.section.purpose.body2',
    ],
  },
  {
    id: 'sharing',
    titleKey: 'public.privacy.section.sharing.title',
    paragraphKeys: [
      'public.privacy.section.sharing.body1',
      'public.privacy.section.sharing.body2',
    ],
  },
  {
    id: 'retention-and-security',
    titleKey: 'public.privacy.section.security.title',
    paragraphKeys: [
      'public.privacy.section.security.body1',
      'public.privacy.section.security.body2',
    ],
  },
  {
    id: 'choices-and-contact',
    titleKey: 'public.privacy.section.choices.title',
    paragraphKeys: [
      'public.privacy.section.choices.body1',
      'public.privacy.section.choices.body2',
    ],
  },
] as const satisfies readonly LegalSection[]

/**
 * mukuroji が扱う情報、利用目的、保持、利用者の選択肢を説明します。
 */
export function PrivacyPage({ initialLocale }: PrivacyPageProps = {}) {
  return (
    <PublicLegalDocument
      eyebrowKey="public.privacy.eyebrow"
      initialLocale={initialLocale}
      introKey="public.privacy.intro"
      sections={privacySections}
      titleKey="public.privacy.title"
      updatedKey="public.privacy.updated"
    />
  )
}
