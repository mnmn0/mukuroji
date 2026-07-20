import { useMemo, useState } from 'react'
import {
  MobileSidebarButton,
  MobileSidebarDrawer,
  Sidebar,
} from '../components/sidebar'
import {
  createSidebarLabels,
  createTranslator,
} from '../i18n'
import { useWorkspaceCommandMenu } from '../commands/WorkspaceCommandMenuContext'
import { WorkspaceBody } from './views/WorkspaceBody'
import { workspaceViewMetadata } from './workspaceViewMetadata'
import { workspacePresentation } from './workspacePresentation'
import type {
  TeamProjectMemberAccess,
  WorkspaceScreenProps,
} from './workspaceTypes'

const emptyProjectTaskFailures: string[] = []
const emptyTeamProjectMembers: TeamProjectMemberAccess[] = []
const emptyTeamProjectMemberFailures: string[] = []
const emptyUserIdentityAliases: string[] = []

/**
 * 認証済みワークスペース UI を描画する Storybook 兼用 screen です。
 */
export function WorkspaceScreen({
  accessToken,
  locale,
  view,
  userLabel,
  userIdentityAliases = emptyUserIdentityAliases,
  userInitial,
  summary,
  teams,
  activeTeamId,
  tasks,
  inboxCount = 0,
  notificationInbox,
  notificationPreferences,
  taskLoadFailedProjectIds = emptyProjectTaskFailures,
  teamProjectMembers = emptyTeamProjectMembers,
  teamProjectMembersFailedProjectIds = emptyTeamProjectMemberFailures,
  isTeamProjectMembersLoading = false,
  fontSizePreference,
  isLoading = false,
  onLogout,
  onSelectNav,
  onSelectTeamView,
  onSelectProject,
  onCreateProject,
  onCreateTeam,
  onArchiveProject,
  onArchiveTeam,
  onMoveTaskStatus,
  onOpenNotification,
  onOpenTask,
  onFontSizePreferenceChange,
  onLocaleChange,
  taskMoveErrorMessage,
}: WorkspaceScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const sidebarLabels = useMemo(() => createSidebarLabels(locale), [locale])
  const metadata = workspaceViewMetadata[view]
  const activeTeam = workspacePresentation.findActiveTeam(teams, activeTeamId)
  const activeTeamLabel = activeTeam?.name ?? t('workspace.team.missing')
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const commandMenu = useWorkspaceCommandMenu()

  return (
    <main className="workbench-shell flex h-svh min-h-0 overflow-hidden">
      <Sidebar
        activeNavId={metadata.activeNavId}
        activeTeamId={metadata.activeTeamViewId ? activeTeam?.id : undefined}
        activeTeamViewId={metadata.activeTeamViewId}
        className="max-[980px]:hidden"
        inboxCount={inboxCount}
        labels={sidebarLabels}
        onArchiveProject={onArchiveProject}
        onArchiveTeam={onArchiveTeam}
        onCreateProject={onCreateProject}
        onCreateTeam={onCreateTeam}
        onOpenSearch={commandMenu.open}
        onSelectNav={onSelectNav}
        onSelectProject={onSelectProject}
        onSelectTeamView={onSelectTeamView}
        teams={teams}
      />

      <MobileSidebarDrawer
        closeLabel={t('sidebar.mobileClose')}
        dialogLabel={t('sidebar.mobileDialog')}
        isOpen={isMobileSidebarOpen}
        onClose={() => setIsMobileSidebarOpen(false)}
      >
        <Sidebar
          activeNavId={metadata.activeNavId}
          activeTeamId={metadata.activeTeamViewId ? activeTeam?.id : undefined}
          activeTeamViewId={metadata.activeTeamViewId}
          inboxCount={inboxCount}
          labels={sidebarLabels}
          onArchiveProject={onArchiveProject}
          onArchiveTeam={onArchiveTeam}
          onCreateProject={onCreateProject}
          onCreateTeam={onCreateTeam}
          onOpenSearch={() => {
            setIsMobileSidebarOpen(false)
            commandMenu.open?.()
          }}
          onSelectNav={(navId) => {
            setIsMobileSidebarOpen(false)
            onSelectNav?.(navId)
          }}
          onSelectProject={(projectId, teamId) => {
            setIsMobileSidebarOpen(false)
            onSelectProject?.(projectId, teamId)
          }}
          onSelectTeamView={(teamId, viewId) => {
            setIsMobileSidebarOpen(false)
            onSelectTeamView?.(teamId, viewId)
          }}
          teams={teams}
        />
      </MobileSidebarDrawer>

      <section className="workbench-main flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="workbench-header flex-none px-[clamp(20px,3vw,34px)] py-4">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <MobileSidebarButton
                label={t('sidebar.mobileOpen')}
                onClick={() => setIsMobileSidebarOpen(true)}
              />
              <div className="min-w-0">
                <p className="workbench-eyebrow">
                  {t(metadata.eyebrowKey)}
                </p>
                <h1 className="workbench-title mt-2 text-page-title">
                  {workspacePresentation.formatTeamText(t(metadata.titleKey), activeTeamLabel)}
                </h1>
                <p className="workbench-description mt-2 max-w-[760px]">
                  {workspacePresentation.formatTeamText(
                    t(metadata.descriptionKey),
                    activeTeamLabel,
                  )}
                </p>
              </div>
            </div>

            <div className="flex flex-none items-center gap-3">
              <div className="hidden text-right max-[720px]:sr-only min-[721px]:block">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                  {t('workspace.user.label')}
                </p>
                <p className="mt-1 max-w-[220px] truncate text-sm font-semibold text-[var(--workbench-text)]">
                  {userLabel}
                </p>
              </div>
              <div className="grid h-10 w-10 place-items-center rounded-full border border-[#99d7cf] bg-[#e5f7f4] text-sm font-semibold text-[var(--workbench-primary)]">
                {userInitial}
              </div>
              <button
                className="workbench-button-secondary min-h-10 px-4"
                type="button"
                onClick={onLogout}
              >
                {t('dashboard.logout')}
              </button>
            </div>
          </div>
        </header>

        {isLoading ? (
          <div className="grid min-h-0 flex-1 place-items-center px-6 text-sm font-medium text-[var(--workbench-muted)]">
            {t('workspace.loading')}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
            <WorkspaceBody
              accessToken={accessToken}
              activeTeam={activeTeam}
              fontSizePreference={fontSizePreference}
              locale={locale}
              notificationInbox={notificationInbox}
              notificationPreferences={notificationPreferences}
              summary={summary}
              t={t}
              taskMoveErrorMessage={taskMoveErrorMessage}
              taskLoadFailedProjectIds={taskLoadFailedProjectIds}
              tasks={tasks}
              teamProjectMembers={teamProjectMembers}
              teamProjectMembersFailedProjectIds={teamProjectMembersFailedProjectIds}
              teams={teams}
              isTeamProjectMembersLoading={isTeamProjectMembersLoading}
              onFontSizePreferenceChange={onFontSizePreferenceChange}
              onLocaleChange={onLocaleChange}
              onMoveTaskStatus={onMoveTaskStatus}
              onOpenNotification={onOpenNotification}
              onOpenTask={onOpenTask}
              onSelectProject={onSelectProject}
              userLabel={userLabel}
              userIdentityAliases={userIdentityAliases}
              view={view}
            />
          </div>
        )}
      </section>
    </main>
  )
}
