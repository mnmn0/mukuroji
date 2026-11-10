import type {
  PlanningSnapshot,
  ResolvedWorkItemConfiguration,
  TaskViewDefinition,
  WorkItemRelation,
  WorkItemDependencyEndpoint,
  WorkItemScheduleDependency,
  WorkItemScheduleDependencyPatch,
  WorkItemTypeChangePreview,
} from '@mukuroji/contracts'
import { type ReactNode } from 'react'
import { type FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import { type Locale } from '../../shared/i18n/i18n'
import { type CreateTeamIssueInput, type TeamIssue, type UpdateTeamIssueInput } from '../api'
import { type IssueCollaborationController } from '../mutations/useIssueCollaboration'
import { type IssueCollaborationRoute } from '../model/collaborationTabs'
import { type ProjectDirectoryTeam, type ProjectMember } from '../../projects/api'
import type { WorkspaceMember } from '../../workspace/api'
import { type WorkItemDependencyCreateDraft } from '../../work-items/model/workItemDependencies'
import { type WorkItemRelationEditorInput } from '../../work-items/ui/WorkItemRelationsEditor'
import { type TeamIssueViewState } from '../../task-views/model/taskViewSurfaceState'
import { type TaskViewPresentationSettings } from '../../task-views/model/taskViewPresentation'
import type { TaskActionContextMenuAnchorPoint } from '../../task-views/model/taskActionContextMenu'

/** Stable empty Workspace member list used before the member query resolves. */
export const emptyWorkspaceMembers: WorkspaceMember[] = []

/**
 * TeamIssueScreen で切り替える Issue 表示モードです。
 */
export type IssueViewMode = 'table' | 'board'

/** DOM ID of the panel that hosts the Team Work Item table or board. */
export const issueViewPanelId = 'team-issue-view-panel'

/**
 * Opens the canonical action menu for one Team Issue row or card.
 *
 * @param issue - Team Issue represented by the triggering row or card.
 * @param anchorPoint - Viewport coordinates used to anchor the menu.
 * @param returnFocusElement - Trigger element that regains focus after dismissal.
 * @returns Nothing.
 */
export type TeamIssueActionMenuOpenHandler = (
  issue: TeamIssue,
  anchorPoint: TaskActionContextMenuAnchorPoint,
  returnFocusElement: HTMLElement,
) => void

/**
 * Evaluates whether the current user may manage one dependency endpoint.
 *
 * @param endpoint - Canonical dependency endpoint under evaluation.
 * @returns Whether the current user may manage the endpoint.
 */
export type CanManageWorkItemDependencyEndpoint = (endpoint: WorkItemDependencyEndpoint) => boolean

/** Persisted Team Create outcome returned by the route-level mutation. */
type CreatedTeamIssueMutation = {
  /** Canonical Work Item created by persistence. */
  issue: TeamIssue
  /** Application-relative route opened after creation, including retained view state. */
  navigationPath: string
}

/** Local state used to review a Team Issue Work Item Type change. */
export type TeamIssueTypeChangeState = {
  /** Field IDs whose removal has been acknowledged by the operator. */
  acknowledgedLostCustomFieldIds: string[]
  /** Exact Issue revision and Project selection represented by this preview. */
  identity: string
  /** Whether the latest preview request is in flight. */
  isPreviewing: boolean
  /** Server-authoritative preview result. */
  preview?: WorkItemTypeChangePreview
  /** Replacement status selected for an invalid current status. */
  replacementWorkflowStatusId?: string
  /** Error from the latest preview request. */
  errorMessage?: string
  /** Type currently being reviewed. */
  targetWorkItemTypeId: string
}

/**
 * チーム所有 Issue 画面を描画する props です。
 */
export type TeamIssueScreenProps = {
  /** Whether the saved Workspace AI policy permits the Summary workflow. */
  aiAssistanceEnabled?: boolean
  /** Saved task view active when canonical Team actions are invoked. */
  activeTaskViewId?: string
  /** Shared saved-view lifecycle and display controls. */
  taskViewToolbar?: ReactNode
  /** Complete effective definition used for multi-value filtering and sorting. */
  taskViewDefinition?: TaskViewDefinition
  /** Presentation settings rendered by Team table and board layouts. */
  taskViewPresentation?: TaskViewPresentationSettings
  /** Optional route-controlled Team Issue view state. */
  viewState?: TeamIssueViewState
  /** Persists one complete next route-controlled Team Issue view state. */
  onViewStateChange?: (state: TeamIssueViewState) => void
  /** Checks whether one visible Team Issue belongs to a server-authorized write scope. */
  canMutateIssue?: (issue: TeamIssue) => boolean
  /** Whether the current viewer may create an unassigned Work Item in the Team scope. */
  canCreateUnassignedIssue?: boolean
  /** Project destinations where the current viewer may create a Team Issue. */
  createIssueProjects?: ProjectDirectoryTeam['projects'][number][]
  /**
   * Related Documents を取得する access token です。
   */
  accessToken?: string
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * 表示中のチーム ID です。
   */
  teamId: string
  /**
   * サイドバーとプロジェクト selector に表示するチーム一覧です。
   */
  teams: ProjectDirectoryTeam[]
  /**
   * 表示中のチーム名です。
   */
  teamName?: string
  /**
   * Issue 一覧です。
   */
  issues?: TeamIssue[]
  /**
   * Team / Workspace から解決した workflow と custom field configuration です。
   */
  resolvedConfiguration?: ResolvedWorkItemConfiguration
  /**
   * 選択中 Work Item から見た relation 一覧です。
   */
  relations?: readonly WorkItemRelation[]
  /** Authoritative Planning snapshot used by every canonical dependency surface. */
  planningSnapshot?: PlanningSnapshot
  /** Whether canonical Planning dependency data is loading. */
  isPlanningLoading?: boolean
  /** Planning dependency load error shown without hiding Team Issues. */
  planningErrorMessage?: string
  /** Retries the canonical Planning dependency query. */
  onRetryPlanning?: () => void
  /** Determines whether the current user may manage one canonical dependency endpoint. */
  canManageDependencyEndpoint?: CanManageWorkItemDependencyEndpoint
  /** Creates a canonical Work Item schedule dependency. */
  onCreateScheduleDependency?: (input: WorkItemDependencyCreateDraft) => void | Promise<void>
  /** Deletes a canonical Work Item schedule dependency. */
  onDeleteScheduleDependency?: (dependency: WorkItemScheduleDependency) => void | Promise<void>
  /** Updates a canonical Work Item schedule dependency. */
  onUpdateScheduleDependency?: (
    dependency: WorkItemScheduleDependency,
    patch: WorkItemScheduleDependencyPatch,
  ) => void | Promise<void>
  /**
   * 選択中 Issue の comment thread、watcher、presence です。
   */
  collaboration?: IssueCollaborationController
  /**
   * 選択中 Work Item の file/version/annotation/approval controller です。
   */
  artifacts?: FileArtifactsController
  /**
   * mention 候補と actor 表示に使う Workspace member 一覧です。
   */
  workspaceMembers?: WorkspaceMember[]
  /**
   * 現在の Workspace member key です。
   */
  currentWorkspaceMemberKey?: string
  /**
   * External link read API の Bearer token です。
   */
  externalLinksAccessToken?: string
  /**
   * External link の作成、更新、解除が許可されているかどうかです。
   */
  canManageExternalLinks?: boolean
  /**
   * notification deep link から focus する comment ID です。
   */
  focusedCommentId?: string
  /**
   * notification deep link の reply が属する root comment ID です。
   */
  focusedRootCommentId?: string
  /** Route-owned collaboration section and deep-link state. */
  collaborationRoute?: IssueCollaborationRoute
  /** Reports an authenticated AI API failure to the route-level session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /** Reports retained comment input with the Team-local Issue owner to the navigation guard. */
  onCommentDraftDirtyChange?: (isDirty: boolean, issueId?: string) => void
  /** Confirms a destructive Issue selection before action focus or ownership changes. */
  onBeforeSelectIssue?: (issueId: string) => boolean
  /**
   * タスク担当者として選択できる project member 一覧です。
   */
  assigneeOptions?: ProjectMember[]
  /**
   * ログインユーザーのアバター頭文字です。
   */
  userInitial: string
  /**
   * 認証または API 確認中の loading 表示に切り替えるかどうかです。
   */
  isLoading?: boolean
  /**
   * Issue 一覧の取得失敗時に表示するエラーメッセージです。
   */
  issueErrorMessage?: string
  /**
   * Issue 詳細の取得失敗時に表示するエラーメッセージです。
   */
  detailErrorMessage?: string
  /**
   * Work Item configuration の取得失敗時に表示するエラーメッセージです。
   */
  configurationErrorMessage?: string
  /**
   * Relation 候補の取得中かどうかです。
   */
  isRelationsLoading?: boolean
  /**
   * Storybook などで初期表示に使う Issue 一覧モードです。
   */
  initialViewMode?: IssueViewMode
  /**
   * 初期表示時に Issue 作成フォームを開くかどうかです。
   */
  defaultCreateIssueOpen?: boolean
  /**
   * 現在選択中の Issue ID です。
   */
  selectedIssueId?: string
  /**
   * Issue を選択したときの callback です。
   */
  onSelectIssue?: (issueId: string) => void
  /**
   * Issue 作成時の callback です。
   */
  onCreateIssue?: (input: CreateTeamIssueInput) => Promise<CreatedTeamIssueMutation | void>
  /**
   * Issue 更新時の callback です。
   */
  onUpdateIssue?: (
    issueId: string,
    input: UpdateTeamIssueInput,
  ) => Promise<TeamIssue | void>
  /**
   * 選択中 Work Item へ relation を追加する callback です。
   */
  onAddRelation?: (issueId: string, input: WorkItemRelationEditorInput) => Promise<void>
  /**
   * 選択中 Work Item の relation を解除する callback です。
   */
  onDeleteRelation?: (issueId: string, relation: WorkItemRelation) => Promise<void>
}
