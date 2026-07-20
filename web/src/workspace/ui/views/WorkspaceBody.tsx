import type { DashboardSummary } from '../../../auth/api'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import { NotificationInbox } from '../../../notifications/ui/NotificationInbox'
import type { InboxNotification } from '../../../notifications/api'
import type {
  NotificationInboxController,
  NotificationPreferencesController,
} from '../../../notifications/mutations/useNotifications'
import type { ProjectDirectoryTeam } from '../../../projects/api'
import type { FontSizePreference } from '../../../shared/lib/preferences/fontSize'
import type { ProjectTask, TaskStatus } from '../../../tasks/api'
import { workspacePresentation } from '../presentation'
import type {
  TeamProjectMemberAccess,
  WorkspaceView,
} from '../types'
import { DashboardWorkspaceView } from './DashboardWorkspaceView'
import { HelpView } from './HelpView'
import { HomeView } from './HomeView'
import { MyTasksView } from './MyTasksView'
import { ReportsView } from './ReportsView'
import { SettingsView } from './SettingsView'
import { TeamMembersView } from './TeamMembersView'
import { TeamOverviewView } from './TeamOverviewView'

const emptyProjectTasks: ProjectTask[] = []

/**
 * 選択中の Workspace view に対応する本文を描画します。
 */
export function WorkspaceBody({
  accessToken,
  activeTeam,
  fontSizePreference,
  locale,
  notificationInbox,
  notificationPreferences,
  summary,
  t,
  taskMoveErrorMessage,
  taskLoadFailedProjectIds,
  tasks,
  teamProjectMembers,
  teamProjectMembersFailedProjectIds,
  teams,
  isTeamProjectMembersLoading,
  onFontSizePreferenceChange,
  onLocaleChange,
  onMoveTaskStatus,
  onOpenNotification,
  onOpenTask,
  onSelectProject,
  userLabel,
  userIdentityAliases,
  view,
}: {
  accessToken?: string
  activeTeam?: ProjectDirectoryTeam
  fontSizePreference: FontSizePreference
  locale: Locale
  notificationInbox?: NotificationInboxController
  notificationPreferences?: NotificationPreferencesController
  summary: DashboardSummary
  t: (key: MessageKey) => string
  taskMoveErrorMessage?: string
  taskLoadFailedProjectIds: string[]
  tasks: ProjectTask[]
  teamProjectMembers: TeamProjectMemberAccess[]
  teamProjectMembersFailedProjectIds: string[]
  teams: ProjectDirectoryTeam[]
  isTeamProjectMembersLoading: boolean
  onFontSizePreferenceChange: (preference: FontSizePreference) => void
  onLocaleChange?: (locale: Locale) => void
  onMoveTaskStatus?: (task: ProjectTask, status: TaskStatus) => Promise<void>
  onOpenNotification?: (notification: InboxNotification) => void
  onOpenTask?: (task: ProjectTask) => void
  onSelectProject?: (projectId: string, teamId: string) => void
  userLabel: string
  userIdentityAliases: string[]
  view: WorkspaceView
}) {
  const myTasks = userIdentityAliases.length === 0
    ? emptyProjectTasks
    : tasks.filter((task) =>
        workspacePresentation.isWorkspaceTaskAssignedToUser(task, userIdentityAliases),
      )

  return (
    <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
      {taskLoadFailedProjectIds.length > 0 ? (
        <p
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800"
          data-testid="workspace-task-partial-error"
          role="alert"
        >
          {t('tasks.error.loadingCount').replace('{count}', String(taskLoadFailedProjectIds.length))}
        </p>
      ) : null}
      {view === 'home' ? (
        <HomeView
          summary={summary}
          t={t}
          tasks={tasks}
          teams={teams}
          onOpenTask={onOpenTask}
        />
      ) : null}
      {view === 'my-tasks' ? (
        <MyTasksView
          onOpenTask={onOpenTask}
          t={t}
          taskMoveErrorMessage={taskMoveErrorMessage}
          tasks={myTasks}
          onMoveTaskStatus={onMoveTaskStatus}
        />
      ) : null}
      {view === 'inbox' ? (
        notificationInbox ? (
          <NotificationInbox
            controller={notificationInbox}
            locale={locale}
            onOpenNotification={onOpenNotification}
          />
        ) : null
      ) : null}
      {view === 'dashboard' ? (
        <DashboardWorkspaceView
          summary={summary}
          t={t}
          tasks={tasks}
          teams={teams}
          onOpenTask={onOpenTask}
        />
      ) : null}
      {view === 'reports' ? (
        <ReportsView
          onSelectProject={onSelectProject}
          t={t}
          tasks={tasks}
          teams={teams}
          onOpenTask={onOpenTask}
        />
      ) : null}
      {view === 'help' ? <HelpView t={t} /> : null}
      {view === 'settings' ? (
        <SettingsView
          accessToken={accessToken}
          fontSizePreference={fontSizePreference}
          locale={locale}
          notificationPreferences={notificationPreferences}
          t={t}
          userLabel={userLabel}
          onFontSizePreferenceChange={onFontSizePreferenceChange}
          onLocaleChange={onLocaleChange}
        />
      ) : null}
      {view === 'team-overview' ? (
        <TeamOverviewView
          isTeamProjectMembersLoading={isTeamProjectMembersLoading}
          t={t}
          tasks={tasks}
          team={activeTeam}
          teamProjectMembers={teamProjectMembers}
          teamProjectMembersFailedProjectIds={teamProjectMembersFailedProjectIds}
          onOpenTask={onOpenTask}
          onSelectProject={onSelectProject}
        />
      ) : null}
      {view === 'team-members' ? (
        <TeamMembersView
          isTeamProjectMembersLoading={isTeamProjectMembersLoading}
          t={t}
          tasks={tasks}
          team={activeTeam}
          teamProjectMembers={teamProjectMembers}
          teamProjectMembersFailedProjectIds={teamProjectMembersFailedProjectIds}
          onSelectProject={onSelectProject}
        />
      ) : null}
    </div>
  )
}
