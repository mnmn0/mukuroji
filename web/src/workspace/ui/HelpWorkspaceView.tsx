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
 * Props for the Workspace help view.
 */
export type HelpWorkspaceViewProps = {
  /** Translator used for help destination labels. */
  t: (key: MessageKey) => string
  /** Identity of the running Web build. Defaults to the values embedded at build time. */
  webBuild?: WebBuildInfo
}

/**
 * Renders coding-agent setup followed by Workspace guidance and support destinations.
 *
 * @param props - Translator used to label each destination and the running build identity.
 * @returns The Workspace help navigation view.
 */
export function HelpWorkspaceView({ t, webBuild = readWebBuildInfo() }: HelpWorkspaceViewProps) {
  return (
    <div className="grid min-w-0 gap-6">
      <CodingAgentGuide t={t} />
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
