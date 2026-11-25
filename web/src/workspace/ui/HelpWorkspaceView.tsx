import { Link } from 'react-router'
import { readWebBuildInfo, type WebBuildInfo } from '../../shared/release/webBuild'
import type { MessageKey } from '../../shared/i18n/i18n'
import { CodingAgentGuide } from './CodingAgentGuide'

/**
 * A destination displayed by the Workspace help view.
 */
type HelpDestination = {
  /** Translation key for the destination description. */
  descriptionKey: MessageKey
  /** Translation key for the destination title. */
  titleKey: MessageKey
  /** Application route opened by the destination card. */
  to: string
}

const helpDestinations: readonly HelpDestination[] = [
  {
    descriptionKey: 'workspace.help.guideDescription',
    titleKey: 'workspace.help.guideTitle',
    to: '/home',
  },
  {
    descriptionKey: 'workspace.help.runbookDescription',
    titleKey: 'workspace.help.runbookTitle',
    to: '/reports',
  },
  {
    descriptionKey: 'workspace.help.supportDescription',
    titleKey: 'workspace.help.supportTitle',
    to: '/support',
  },
  {
    descriptionKey: 'workspace.help.statusDescription',
    titleKey: 'workspace.help.statusTitle',
    to: '/support?topic=work',
  },
]

/**
 * A role-specific user guide published in the repository's `docs/guide/` directory.
 */
type RoleGuide = {
  /** Translation key for the guide summary. */
  descriptionKey: MessageKey
  /** File name of the guide inside `docs/guide/`. */
  fileName: string
  /** Translation key for the guide title. */
  titleKey: MessageKey
}

/** Base URL of the user guides on the repository's default branch. */
const roleGuideBaseUrl = 'https://github.com/mnmn0/mukuroji/blob/main/docs/guide/'

const roleGuides: readonly RoleGuide[] = [
  {
    descriptionKey: 'workspace.help.pmGuideDescription',
    fileName: 'pm.md',
    titleKey: 'workspace.help.pmGuideTitle',
  },
  {
    descriptionKey: 'workspace.help.memberGuideDescription',
    fileName: 'member.md',
    titleKey: 'workspace.help.memberGuideTitle',
  },
  {
    descriptionKey: 'workspace.help.adminGuideDescription',
    fileName: 'admin.md',
    titleKey: 'workspace.help.adminGuideTitle',
  },
  {
    descriptionKey: 'workspace.help.agentGuideDescription',
    fileName: 'coding-agent.md',
    titleKey: 'workspace.help.agentGuideTitle',
  },
]

/**
 * A Workspace feature explained on the help view with a short summary, its screen, and its guide section.
 */
type FeatureGuide = {
  /** Translation key for the one-line feature summary. */
  descriptionKey: MessageKey
  /** Guide file and heading anchor inside `docs/guide/`, such as `member.md#フォーカス`. */
  guidePath: string
  /** Translation key for the feature name. */
  titleKey: MessageKey
  /** Application route that opens the feature. */
  to: string
}

const featureGuides: readonly FeatureGuide[] = [
  {
    descriptionKey: 'workspace.help.featureProjectsDescription',
    guidePath: 'pm.md#1-project-を作る',
    titleKey: 'workspace.help.featureProjectsTitle',
    to: '/projects',
  },
  {
    descriptionKey: 'workspace.help.featurePlanningDescription',
    guidePath: 'pm.md#5-計画phasemilestonecycleを置く',
    titleKey: 'workspace.help.featurePlanningTitle',
    to: '/planning',
  },
  {
    descriptionKey: 'workspace.help.featureUpdatesDescription',
    guidePath: 'pm.md#7-毎週近況を公開する',
    titleKey: 'workspace.help.featureUpdatesTitle',
    to: '/updates',
  },
  {
    descriptionKey: 'workspace.help.featureReportsDescription',
    guidePath: 'pm.md#8-レポートで振り返る',
    titleKey: 'workspace.help.featureReportsTitle',
    to: '/reports',
  },
  {
    descriptionKey: 'workspace.help.featureMyTasksDescription',
    guidePath: 'member.md#マイタスク',
    titleKey: 'workspace.help.featureMyTasksTitle',
    to: '/my-tasks',
  },
  {
    descriptionKey: 'workspace.help.featureFocusDescription',
    guidePath: 'member.md#フォーカス',
    titleKey: 'workspace.help.featureFocusTitle',
    to: '/focus',
  },
  {
    descriptionKey: 'workspace.help.featureInboxDescription',
    guidePath: 'member.md#受信箱と通知',
    titleKey: 'workspace.help.featureInboxTitle',
    to: '/inbox',
  },
  {
    descriptionKey: 'workspace.help.featureSettingsDescription',
    guidePath: 'admin.md#権限のしくみ',
    titleKey: 'workspace.help.featureSettingsTitle',
    to: '/settings',
  },
]

/**
 * Props for the Workspace help view.
 */
export type HelpWorkspaceViewProps = {
  /** Translator used for help destination labels. */
  t: (key: MessageKey) => string
  /** Identity of the running Web build. Defaults to the values embedded at build time. */
  webBuild?: WebBuildInfo
  /** Whether to show the coding-agent setup guide, which only Software factory deployments serve. */
  showCodingAgentGuide?: boolean
}

/**
 * Renders coding-agent setup, role-specific user guides, per-feature summaries linked to their
 * screens and guide sections, and Workspace support destinations.
 *
 * @param props - Translator, running build identity, and whether to show the coding-agent guide.
 * @returns The Workspace help navigation view.
 */
export function HelpWorkspaceView({
  t,
  webBuild = readWebBuildInfo(),
  showCodingAgentGuide = true,
}: HelpWorkspaceViewProps) {
  return (
    <div className="grid min-w-0 gap-6">
      {showCodingAgentGuide ? <CodingAgentGuide t={t} /> : null}
      <section aria-labelledby="role-guides-title" className="grid min-w-0 gap-4" id="role-guides">
        <header>
          <h2 className="text-xl font-semibold tracking-tight text-[var(--workbench-text)]" id="role-guides-title">
            {t('workspace.help.roleGuidesTitle')}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--workbench-muted)]">
            {t('workspace.help.roleGuidesDescription')}
          </p>
        </header>
        <ul className="grid list-none grid-cols-2 gap-4 p-0 max-[820px]:grid-cols-1">
          {roleGuides.map((guide) => (
            <li className="min-w-0" key={guide.fileName}>
              <a
                className="workbench-panel grid h-full gap-2 p-5 no-underline transition-[border-color,background-color] duration-150 hover:border-tone-99d7cf hover:bg-[var(--workbench-surface-muted)]"
                href={`${roleGuideBaseUrl}${guide.fileName}`}
                rel="noopener noreferrer"
                target="_blank"
              >
                <strong className="text-base font-semibold text-[var(--workbench-text)]">
                  {t(guide.titleKey)}
                  <span aria-hidden="true"> ↗</span>
                </strong>
                <span className="text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                  {t(guide.descriptionKey)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="feature-guides-title" className="grid min-w-0 gap-4" id="feature-guides">
        <header>
          <h2 className="text-xl font-semibold tracking-tight text-[var(--workbench-text)]" id="feature-guides-title">
            {t('workspace.help.featureGuidesTitle')}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--workbench-muted)]">
            {t('workspace.help.featureGuidesDescription')}
          </p>
        </header>
        <ul className="grid list-none grid-cols-2 gap-4 p-0 max-[820px]:grid-cols-1">
          {featureGuides.map((feature, index) => (
            <li className="workbench-panel grid min-w-0 gap-2 p-5" key={feature.to}>
              <strong className="text-base font-semibold text-[var(--workbench-text)]" id={`feature-guide-${index}`}>
                {t(feature.titleKey)}
              </strong>
              <span className="text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                {t(feature.descriptionKey)}
              </span>
              <span className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold">
                <Link
                  aria-describedby={`feature-guide-${index}`}
                  className="text-[var(--workbench-primary-text)]"
                  to={feature.to}
                >
                  {t('workspace.help.featureOpen')}
                </Link>
                <a
                  aria-describedby={`feature-guide-${index}`}
                  className="text-[var(--workbench-primary-text)]"
                  href={`${roleGuideBaseUrl}${feature.guidePath}`}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {t('workspace.help.featureGuide')}
                  <span aria-hidden="true"> ↗</span>
                </a>
              </span>
            </li>
          ))}
        </ul>
      </section>
      <nav
        aria-label={t('workspace.help.title')}
        className="grid grid-cols-2 gap-4 max-[820px]:grid-cols-1"
      >
        {helpDestinations.map((destination) => (
          <Link
            className="group workbench-panel grid min-h-[168px] grid-cols-[1fr_auto] gap-5 p-5 no-underline transition-[border-color,background-color,transform] duration-150 hover:-translate-y-0.5 hover:border-tone-99d7cf hover:bg-[var(--workbench-surface-muted)]"
            key={destination.titleKey}
            to={destination.to}
          >
            <span>
              <strong className="block text-lg font-semibold text-[var(--workbench-text)]">
                {t(destination.titleKey)}
              </strong>
              <span className="mt-3 block text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                {t(destination.descriptionKey)}
              </span>
            </span>
            <span
              aria-hidden="true"
              className="grid h-10 w-10 place-items-center self-end rounded-full border border-[var(--workbench-border-strong)] bg-surface text-lg text-[var(--workbench-primary-text)] transition-transform duration-150 group-hover:translate-x-0.5"
            >
              →
            </span>
          </Link>
        ))}
      </nav>
      <section
        aria-labelledby="web-build-title"
        className="workbench-panel grid gap-2 p-5"
        data-testid="web-build"
        id="web-build"
      >
        <h2 className="text-base font-semibold text-[var(--workbench-text)]" id="web-build-title">
          {t('workspace.help.buildTitle')}
        </h2>
        <p className="text-sm leading-6 text-[var(--workbench-muted)]">
          {t('workspace.help.buildDescription')}
        </p>
        {webBuild.commitSha === undefined ? (
          <p className="text-sm font-medium text-[var(--workbench-text)]">
            {t('workspace.help.buildUnknown')}
          </p>
        ) : (
          <code
            className="w-fit max-w-full select-all break-all rounded border border-[var(--workbench-border-strong)] px-2 py-1 font-mono text-sm text-[var(--workbench-text)]"
          >
            {webBuild.commitSha}
          </code>
        )}
      </section>
    </div>
  )
}
