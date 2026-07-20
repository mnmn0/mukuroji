import { Link } from 'react-router'
import type { MessageKey } from '../../i18n'

const helpDestinations = [
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
] as const satisfies ReadonlyArray<{
  descriptionKey: MessageKey
  titleKey: MessageKey
  to: string
}>

/**
 * Workspace のヘルプ遷移先を描画します。
 */
export function HelpView({ t }: { t: (key: MessageKey) => string }) {
  return (
    <nav
      aria-label={t('workspace.help.title')}
      className="grid grid-cols-2 gap-4 max-[820px]:grid-cols-1"
    >
      {helpDestinations.map((destination) => (
        <Link
          className="group workbench-panel grid min-h-[168px] grid-cols-[1fr_auto] gap-5 p-5 no-underline transition-[border-color,background-color,transform] duration-150 hover:-translate-y-0.5 hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)]"
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
            className="grid h-10 w-10 place-items-center self-end rounded-full border border-[var(--workbench-border-strong)] bg-white text-lg text-[var(--workbench-primary)] transition-transform duration-150 group-hover:translate-x-0.5"
          >
            →
          </span>
        </Link>
      ))}
    </nav>
  )
}
