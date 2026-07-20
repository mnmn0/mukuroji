import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useCurrentUser } from '../../auth/queries/useCurrentUser'
import {
  clearAuthSession,
  getAuthSession,
} from '../../auth/session'
import { useWorkspaceCommandMenu } from '../../commands/ui/WorkspaceCommandMenuContext'
import { RelatedDocuments } from '../../documents/ui/RelatedDocuments'
import {
  MobileSidebarButton,
  WorkspaceSidebar,
} from '../../shared/ui/sidebar'
import {
  createSidebarLabels,
  createTranslator,
  getInitialLocale,
  type Locale,
} from '../../shared/i18n/i18n'
import type { ProjectDirectoryTeam } from '../../projects/api'
import { useProjectDirectory } from '../../projects/queries/useProjectDirectory'
import { useNotificationUnreadCount } from '../../notifications/queries/useNotificationUnreadCount'
import {
  createProjectIssuesPath,
  createTeamViewPath,
  workspaceNavPaths,
} from '../../shared/routing/paths'

const emptyTeams: ProjectDirectoryTeam[] = []

/**
 * Goal から関連 Documents へ戻る軽量 context page です。
 */
export function GoalDocumentsPage() {
  const navigate = useNavigate()
  const { goalId } = useParams()
  const [session] = useState(() => getAuthSession())
  const [locale] = useState<Locale>(() =>
    getInitialLocale(),
  )
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const t = useMemo(
    () => createTranslator(locale),
    [locale],
  )
  const sidebarLabels = useMemo(
    () => createSidebarLabels(locale),
    [locale],
  )
  const commandMenu = useWorkspaceCommandMenu()
  const accessToken = session?.accessToken
  const { data: user } = useCurrentUser(accessToken)
  const { data: teams = emptyTeams } = useProjectDirectory({
    accessToken,
    enabled: Boolean(user),
    locale,
  })
  const { data: inboxCount = 0 } = useNotificationUnreadCount(
    accessToken,
    Boolean(user),
  )

  useEffect(() => {
    if (!session) {
      clearAuthSession()
      navigate('/', { replace: true })
    }
  }, [navigate, session])

  return (
    <main className="workbench-shell flex h-svh min-h-0 overflow-hidden">
      <WorkspaceSidebar
        activeNavId="documents"
        inboxCount={inboxCount}
        isMobileOpen={isMobileSidebarOpen}
        labels={sidebarLabels}
        mobileCloseLabel={t('sidebar.mobileClose')}
        mobileDialogLabel={t('sidebar.mobileDialog')}
        onMobileClose={() => setIsMobileSidebarOpen(false)}
        onOpenSearch={commandMenu.open}
        onSelectNav={(navId) => navigate(workspaceNavPaths[navId])}
        onSelectProject={(projectId, teamId) =>
          navigate(createProjectIssuesPath(projectId, teamId))}
        onSelectTeamView={(teamId, viewId) =>
          navigate(createTeamViewPath(teamId, viewId))}
        teams={teams}
      />
      <section className="workbench-main flex min-w-0 flex-1 flex-col overflow-auto">
        <header className="flex min-h-16 items-center justify-between gap-4 border-b border-[var(--workbench-border)] bg-white px-5">
          <div className="flex min-w-0 items-center gap-3">
            <MobileSidebarButton
              label={t('sidebar.mobileOpen')}
              onClick={() => setIsMobileSidebarOpen(true)}
            />
            <div className="min-w-0">
              <p className="workbench-eyebrow">
                {t('documents.backlinks.goal')}
              </p>
              <h1 className="truncate text-lg font-semibold text-[var(--workbench-text)]">
                {goalId}
              </h1>
            </div>
          </div>
          <button
            className="workbench-button-secondary min-h-9 px-3"
            onClick={() =>
              navigate(workspaceNavPaths.documents)
            }
            type="button"
          >
            {t('documents.related.openDocuments')}
          </button>
        </header>
        <div className="mx-auto w-full max-w-3xl py-8">
          <section className="workbench-panel overflow-hidden">
            <RelatedDocuments
              accessToken={session?.accessToken}
              t={t}
              targetId={goalId}
              targetKind="goal"
            />
          </section>
        </div>
      </section>
    </main>
  )
}
