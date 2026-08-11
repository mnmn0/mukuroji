import type { Meta, StoryObj } from '@storybook/react-vite'
import type { PlanningUpdateTargetSummary } from '@mukuroji/contracts'
import { useState, type ReactElement } from 'react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router'
import { expect, fn, userEvent, within } from 'storybook/test'
import {
  WorkspaceCommandMenuContext,
  type WorkspaceCommandMenuContextValue,
} from '../../commands/ui/WorkspaceCommandMenuContext'
import { notificationInboxControllerFixture } from '../../notifications/fixtures'
import { WorkspaceInboxView } from '../../notifications/ui/WorkspaceInboxView'
import { projectDirectoryFixtures } from '../../projects/fixtures'
import type { TeamProjectMemberAccess } from '../../projects/model/teamInsights'
import { TeamMembersView } from '../../projects/ui/TeamMembersView'
import { TeamOverviewView } from '../../projects/ui/TeamOverviewView'
import { enterpriseSecuritySnapshotFixture } from '../../security/fixtures'
import { createWorkspaceSecurityScopeOptions } from '../../security/model/workspaceSecurityScopes'
import { EnterpriseSecurityPanel } from '../../security/ui/EnterpriseSecurityPanel'
import { createTranslator } from '../../shared/i18n/i18n'
import type { ProjectTask } from '../../tasks/api'
import { referoTaskFixtures } from '../../tasks/fixtures'
import { inheritedWorkItemConfigurationFixture } from '../../work-items/fixtures'
import { createTaskViewItemKey } from '../../task-views/model/taskViewSelection'
import type { WorkspaceSummary } from '../../work-items/model/workspaceWorkItems'
import { DashboardWorkspaceView } from '../../workspace/ui/DashboardWorkspaceView'
import { HelpWorkspaceView } from '../../workspace/ui/HelpWorkspaceView'
import { HomeWorkspaceView } from '../../workspace/ui/HomeWorkspaceView'
import { MyTasksWorkspaceView } from '../../workspace/ui/MyTasksWorkspaceView'
import {
  WorkspaceRoute,
  WorkspaceRouteContent,
} from '../../workspace/ui/WorkspaceRoute'
import type { WorkspaceRouteContextValue } from '../../workspace/ui/WorkspaceRouteProvider'
import { WorkspaceSettingsView } from '../../workspace/ui/WorkspaceSettingsView'

const t = createTranslator('ja')
const englishTranslator = createTranslator('en')
const coreTeam = projectDirectoryFixtures[0]
const storyTasks: ProjectTask[] = referoTaskFixtures.map((task) => ({
  ...task,
  workflowStatusId: task.workflowStatusId === 'todo'
    ? 'ready'
    : task.workflowStatusId === 'in-progress'
      ? 'active'
      : task.workflowStatusId,
}))
const onOpenMyTaskAction = fn()
const onOpenMyTaskActionMenu = fn()

const storySummary: WorkspaceSummary = {
  blocked: 2,
  projects: 5,
  tasks: storyTasks.length,
}

const storyPlanningUpdateTargets: PlanningUpdateTargetSummary[] = [{
  target: { type: 'project', teamId: 'core-team', projectId: 'refero' },
  cadence: {
    updateOwnerMemberKey: 'demo@example.com',
    cadence: { unit: 'week', count: 1 },
    timeZone: 'Asia/Tokyo',
    nextDueAt: '2026-08-14T08:00:00.000Z',
    reminderHoursBefore: 24,
  },
  updateState: 'overdue',
  latestVersion: 3,
  latestUpdate: {
    id: 'story-project-update-3',
    version: 3,
    health: 'on-track',
    risk: 'low',
    summary: 'Release scope is stable; final evidence review remains.',
    progressSnapshot: { percent: 78, linkedWorkItemCount: 6 },
    authorMemberKey: 'demo@example.com',
    coveredDueAt: '2026-08-07T08:00:00.000Z',
    createdAt: '2026-08-07T07:30:00.000Z',
  },
  updatedAt: '2026-08-07T07:30:00.000Z',
}]

const storyWorkItemConfigurations = {
  'core-team': inheritedWorkItemConfigurationFixture,
  'design-team': inheritedWorkItemConfigurationFixture,
}

const storyTeamProjectMembers: TeamProjectMemberAccess[] = [
  {
    member: {
      email: 'demo@example.com',
      id: 'demo@example.com',
      name: 'Demo User',
      role: 'manager',
      updatedAt: '2026-07-12T00:00:00.000Z',
    },
    projectId: 'refero',
    projectName: 'Refero',
  },
  {
    member: {
      email: 'sato@example.com',
      id: 'sato@example.com',
      name: '佐藤 花子',
      role: 'member',
      updatedAt: '2026-07-12T00:00:00.000Z',
    },
    projectId: 'refero',
    projectName: 'Refero',
  },
  {
    member: {
      email: 'suzuki@example.com',
      id: 'suzuki@example.com',
      name: '鈴木 大輔',
      role: 'viewer',
      updatedAt: '2026-07-12T00:00:00.000Z',
    },
    projectId: 'product-roadmap',
    projectName: 'プロダクトロードマップ',
  },
]

const storySecurityScopeOptions = createWorkspaceSecurityScopeOptions(
  projectDirectoryFixtures,
  t('security.scope.workspace'),
)

const storyWorkspaceCommandMenuContext: WorkspaceCommandMenuContextValue = {
  open: () => undefined,
}

const storyWorkspaceRouteContext: WorkspaceRouteContextValue = {
  accessToken: 'storybook-access-token',
  canLoadWorkspaceData: true,
  canManageWorkspaceConfiguration: true,
  canMutateTeamConfiguration: true,
  fontSizePreference: 'standard',
  guardEnterpriseSession: (request) => request,
  hasQuickAccessLoadError: false,
  inboxCount: 3,
  isProjectQuickAccess: () => false,
  isLoading: false,
  isQuickAccessLoading: false,
  isQuickAccessSaving: false,
  locale: 'ja',
  onArchiveProject: () => Promise.resolve(),
  onArchiveTeam: () => Promise.resolve(),
  onCreateProject: () => Promise.resolve(),
  onCreateTeam: () => Promise.resolve(),
  onDismissProjectQuickAccessFeedback: () => undefined,
  onFontSizePreferenceChange: () => undefined,
  onLocaleChange: () => undefined,
  onLogout: () => undefined,
  onOpenNotification: () => undefined,
  onOpenTask: () => undefined,
  onMoveProjectQuickAccess: () => Promise.resolve(),
  onRemoveProjectQuickAccess: () => Promise.resolve(),
  onRetryCommonData: () => Promise.resolve(),
  onRetryProjectQuickAccess: () => Promise.resolve(),
  onSelectNav: () => undefined,
  onSelectProject: () => undefined,
  onSelectTeamView: () => undefined,
  onSessionErrorAction: () => undefined,
  onToggleProjectQuickAccess: () => Promise.resolve(),
  onUndoProjectQuickAccess: () => Promise.resolve(),
  quickAccessItems: [],
  quickAccessProjects: [],
  reportNotificationPreferencesError: () => undefined,
  resolveSessionErrors: () => undefined,
  teams: projectDirectoryFixtures,
  userIdentityAliases: ['demo@example.com'],
  userInitial: 'D',
  userLabel: 'demo@example.com',
}

/**
 * Props for the Storybook-only outlet that supplies Workspace route context.
 */
type WorkspaceRouteStoryOutletProps = {
  /** Fake authenticated Workspace state exposed through React Router outlet context. */
  context: WorkspaceRouteContextValue
}

/**
 * Supplies the same outlet context boundary used by authenticated Workspace routes.
 *
 * @param props - Fake authenticated Workspace state.
 * @returns A React Router outlet carrying the supplied Workspace context.
 */
function WorkspaceRouteStoryOutlet({
  context,
}: WorkspaceRouteStoryOutletProps) {
  return <Outlet context={context} />
}

/**
 * Props for a Storybook route mounted inside the shared Workspace shell.
 */
type WorkspaceRouteStoryHarnessProps = {
  /** Shared Workspace route and its static story content. */
  children: ReactElement
  /** Fake authenticated Workspace state used by the shell. */
  context: WorkspaceRouteContextValue
  /** Absolute route path matched by the story. */
  path: string
}

/**
 * Mounts a Workspace route with Router outlet and command-menu context boundaries.
 *
 * @param props - Route path, shell content, and fake authenticated context.
 * @returns A full-viewport Workspace shell story without HTTP or session dependencies.
 */
function WorkspaceRouteStoryHarness({
  children,
  context,
  path,
}: WorkspaceRouteStoryHarnessProps) {
  return (
    <div className="fixed inset-0 bg-[var(--workbench-bg)]">
      <WorkspaceCommandMenuContext.Provider value={storyWorkspaceCommandMenuContext}>
        <Routes location={path}>
          <Route element={<WorkspaceRouteStoryOutlet context={context} />}>
            <Route element={<WorkspaceRoute />}>
              <Route element={children} path={path} />
            </Route>
          </Route>
        </Routes>
      </WorkspaceCommandMenuContext.Provider>
    </div>
  )
}

/**
 * Renders the shared Home shell with a retryable common-data error boundary.
 *
 * @returns An interactive shell story whose retry action restores route content.
 */
function WorkspaceCommonErrorShellStory() {
  const [hasCommonError, setHasCommonError] = useState(true)
  const context: WorkspaceRouteContextValue = {
    ...storyWorkspaceRouteContext,
    commonErrorKey: hasCommonError ? 'dashboard.loadError' : undefined,
    onRetryCommonData: () => {
      setHasCommonError(false)
      return Promise.resolve()
    },
    resolveSessionErrors: () => hasCommonError
      ? {
          clearSession: false,
          kind: 'stay',
        }
      : undefined,
  }

  return (
    <WorkspaceRouteStoryHarness context={context} path="/home">
      <WorkspaceRouteContent>
        <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
          <HomeWorkspaceView
            summary={storySummary}
            t={t}
            tasks={storyTasks}
            teams={projectDirectoryFixtures}
            workItemConfigurationsByTeam={storyWorkItemConfigurations}
          />
        </div>
      </WorkspaceRouteContent>
    </WorkspaceRouteStoryHarness>
  )
}

const meta = {
  title: 'Application/Pages/WorkspaceRoutes',
  parameters: {
    controls: {
      disable: true,
    },
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <MemoryRouter initialEntries={['/home']}>
        <div className="min-h-screen bg-[var(--workbench-bg)] px-[clamp(20px,3vw,34px)] py-6">
          <Story />
        </div>
      </MemoryRouter>
    ),
  ],
} satisfies Meta

/** Storybook metadata for the URL-specific Workspace route views. */
export default meta

/** Story definitions for the URL-specific Workspace views. */
type Story = StoryObj<typeof meta>

/** The `/home` route overview with focus and attention queues. */
export const HomeRoute: Story = {
  render: () => (
    <HomeWorkspaceView
      summary={storySummary}
      t={t}
      tasks={storyTasks}
      teams={projectDirectoryFixtures}
      workItemConfigurationsByTeam={storyWorkItemConfigurations}
    />
  ),
}

/** The `/my-tasks` route with Team-scoped workflow columns. */
export const MyTasksRoute: Story = {
  render: () => (
    <MyTasksWorkspaceView
      configurationFailedTeamIds={[]}
      configurationsByTeam={storyWorkItemConfigurations}
      onMoveTaskStatus={async () => undefined}
      t={t}
      tasks={storyTasks}
      teams={projectDirectoryFixtures}
    />
  ),
}

/** The personal board reflects shared keyboard focus/selection and keeps click Open actionable. */
export const MyTasksFocusedSelection: Story = {
  render: () => {
    const firstTask = storyTasks[0]
    if (!firstTask) throw new Error('Expected a personal-task story fixture.')
    const firstTaskKey = createTaskViewItemKey(firstTask.teamId, firstTask.id)
    return (
      <MyTasksWorkspaceView
        configurationFailedTeamIds={[]}
        configurationsByTeam={storyWorkItemConfigurations}
        focusedTaskKey={firstTaskKey}
        onOpenTask={onOpenMyTaskAction}
        onTaskActionMenuOpen={onOpenMyTaskActionMenu}
        selectedTaskKeys={[firstTaskKey]}
        t={t}
        tasks={storyTasks}
        teams={projectDirectoryFixtures}
      />
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const card = canvas.getByTestId('my-tasks-card-refero-wireframe')
    const openButton = canvas.getByTestId('my-tasks-card-refero-wireframe-open')
    const actionButton = canvas.getByTestId('my-tasks-card-refero-wireframe-actions')
    onOpenMyTaskAction.mockClear()
    onOpenMyTaskActionMenu.mockClear()

    await expect(card).toHaveAttribute('data-task-view-focused', 'true')
    await expect(card).toHaveAttribute('data-task-view-selected', 'true')
    await expect(card).toHaveAttribute('aria-current', 'true')
    await userEvent.click(openButton)
    await expect(onOpenMyTaskAction).toHaveBeenCalledTimes(1)
    await userEvent.click(actionButton)
    await expect(onOpenMyTaskActionMenu).toHaveBeenCalledTimes(1)
  },
}

/** The `/my-tasks` route with compact cards and priority subgroups from a saved view. */
export const MyTasksSavedViewPresentation: Story = {
  render: () => (
    <MyTasksWorkspaceView
      configurationFailedTeamIds={[]}
      configurationsByTeam={storyWorkItemConfigurations}
      presentation={{
        columns: [{ field: 'title' }, { field: 'project' }, { field: 'team' }],
        density: 'compact',
        display: {
          showArchived: false,
          showAssigneeAvatars: true,
          showCompleted: true,
          showEmptyGroups: false,
          showSubtasks: true,
          wrapTitles: true,
        },
        groupBy: 'status',
        subgroupBy: 'priority',
      }}
      t={t}
      tasks={storyTasks}
      teams={projectDirectoryFixtures}
    />
  ),
}

/** The `/my-tasks` route after a workflow mutation fails. */
export const MyTasksMoveError: Story = {
  render: () => (
    <MyTasksWorkspaceView
      configurationFailedTeamIds={[]}
      configurationsByTeam={storyWorkItemConfigurations}
      onMoveTaskStatus={async () => undefined}
      t={t}
      taskMoveErrorMessage="タスクの状態を更新できませんでした。"
      tasks={storyTasks}
      teams={projectDirectoryFixtures}
    />
  ),
}

/** The `/inbox` route with attention Work Items and durable notifications. */
export const InboxRoute: Story = {
  render: () => (
    <WorkspaceInboxView
      locale="ja"
      notificationInbox={notificationInboxControllerFixture}
      t={t}
      tasks={storyTasks}
      teams={projectDirectoryFixtures}
      workItemConfigurationsByTeam={storyWorkItemConfigurations}
    />
  ),
}

/** The `/inbox` route when the notification stream is empty. */
export const InboxWithoutNotifications: Story = {
  render: () => (
    <WorkspaceInboxView
      locale="ja"
      notificationInbox={{
        ...notificationInboxControllerFixture,
        hasMore: false,
        notifications: [],
        unreadCount: 0,
      }}
      t={t}
      tasks={storyTasks}
      teams={projectDirectoryFixtures}
      workItemConfigurationsByTeam={storyWorkItemConfigurations}
    />
  ),
}

/** The `/dashboard` route portfolio and decision queue. */
export const DashboardRoute: Story = {
  render: () => (
    <DashboardWorkspaceView
      planningUpdateTargets={storyPlanningUpdateTargets}
      summary={storySummary}
      t={t}
      tasks={storyTasks}
      teams={projectDirectoryFixtures}
      workItemConfigurationsByTeam={storyWorkItemConfigurations}
    />
  ),
}

/** The dashboard preserves separate health and reporting freshness on a narrow viewport. */
export const DashboardRouteMobile: Story = {
  globals: {
    viewport: { isRotated: false, value: 'mobile1' },
  },
  render: () => (
    <DashboardWorkspaceView
      planningUpdateTargets={storyPlanningUpdateTargets}
      summary={storySummary}
      t={t}
      tasks={storyTasks}
      teams={projectDirectoryFixtures}
      workItemConfigurationsByTeam={storyWorkItemConfigurations}
    />
  ),
}

/** The `/help` route navigation cards. */
export const HelpRoute: Story = {
  render: () => <HelpWorkspaceView t={t} />,
}

/** The `/settings` route display preferences without authenticated feature requests. */
export const SettingsRoute: Story = {
  render: () => (
    <WorkspaceSettingsView
      fontSizePreference="standard"
      locale="ja"
      onFontSizePreferenceChange={() => undefined}
      onLocaleChange={() => undefined}
      t={t}
      userLabel="demo@example.com"
    />
  ),
}

/** The shared `/home` shell with its actual common error and retry boundary. */
export const CommonDataErrorShell: Story = {
  render: () => <WorkspaceCommonErrorShellStory />,
}

/** The shared shell keeps route content usable while Quick Access is unavailable. */
export const QuickAccessErrorShell: Story = {
  render: () => (
    <WorkspaceRouteStoryHarness
      context={{
        ...storyWorkspaceRouteContext,
        hasQuickAccessLoadError: true,
      }}
      path="/home"
    >
      <WorkspaceRouteContent>
        <div className="px-[clamp(20px,3vw,34px)] py-5">
          <p className="text-sm text-[var(--workbench-muted)]">
            Route content remains available.
          </p>
        </div>
      </WorkspaceRouteContent>
    </WorkspaceRouteStoryHarness>
  ),
}

/** The `/settings/security` feature inside the real Workspace sidebar and header shell. */
export const EnterpriseSecurityShellRoute: Story = {
  render: () => (
    <WorkspaceRouteStoryHarness
      context={storyWorkspaceRouteContext}
      path="/settings/security"
    >
      <WorkspaceRouteContent>
        <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
          <EnterpriseSecurityPanel
            locale="ja"
            scopeOptions={storySecurityScopeOptions}
            snapshot={enterpriseSecuritySnapshotFixture}
          />
        </div>
      </WorkspaceRouteContent>
    </WorkspaceRouteStoryHarness>
  ),
}

/** The `/teams/:teamId/overview` route with Project-level delivery summaries. */
export const TeamOverviewRoute: Story = {
  render: () => (
    <TeamOverviewView
      isTeamProjectMembersLoading={false}
      team={coreTeam}
      teamProjectMembers={storyTeamProjectMembers}
      teamProjectMembersFailedProjectIds={[]}
      t={t}
      tasks={storyTasks}
      workItemConfigurationsByTeam={storyWorkItemConfigurations}
    />
  ),
}

/** The `/teams/:teamId/members` route with searchable member workload rows. */
export const TeamMembersRoute: Story = {
  render: () => (
    <TeamMembersView
      isTeamProjectMembersLoading={false}
      team={coreTeam}
      teamProjectMembers={storyTeamProjectMembers}
      teamProjectMembersFailedProjectIds={[]}
      t={t}
      tasks={storyTasks}
    />
  ),
}

/** The Team members route when one Project membership request fails. */
export const TeamMembersPartialFailure: Story = {
  render: () => (
    <TeamMembersView
      isTeamProjectMembersLoading={false}
      team={coreTeam}
      teamProjectMembers={storyTeamProjectMembers.filter(
        (access) => access.projectId !== 'product-roadmap',
      )}
      teamProjectMembersFailedProjectIds={['product-roadmap']}
      t={t}
      tasks={storyTasks}
    />
  ),
}

/** The Team members route with the English message dictionary. */
export const EnglishTeamMembersRoute: Story = {
  render: () => (
    <TeamMembersView
      isTeamProjectMembersLoading={false}
      team={coreTeam}
      teamProjectMembers={storyTeamProjectMembers}
      teamProjectMembersFailedProjectIds={[]}
      t={englishTranslator}
      tasks={storyTasks}
    />
  ),
}
