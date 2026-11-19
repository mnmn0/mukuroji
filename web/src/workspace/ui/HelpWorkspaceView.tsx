import { Link } from 'react-router'
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
 * Props for the Workspace help view.
 */
export type HelpWorkspaceViewProps = {
  /** Translator used for help destination labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders coding-agent setup, role-specific user guides, and Workspace support destinations.
 *
 * @param props - Translator used to label each destination.
 * @returns The Workspace help navigation view.
 */
export function HelpWorkspaceView({ t }: HelpWorkspaceViewProps) {
  return (
    <div className="grid min-w-0 gap-6">
      <CodingAgentGuide t={t} />
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
    </div>
  )
}
