import type { WorkflowDefinition } from './work-item-configuration'
import type { WorkItemSchedule } from './work-items'

/** Automation domain の現在の schema version です。 */
export const AUTOMATION_SCHEMA_VERSION = 1 as const

/** Work Item approval 一件に指定できる reviewer 上限です。 */
export const APPROVAL_MAX_REVIEWERS = 20

/** Automation rule が利用できる JSON scalar/value です。 */
export type AutomationValue = null | boolean | number | string | AutomationValue[] | {
  /** Object value の field です。 */
  [key: string]: AutomationValue
}

/** Audit event の workflow status 変更を検出する trigger です。 */
export type AutomationStatusTrigger = {
  /** Trigger discriminator です。 */
  type: 'status'
  /** 変更前 status ID の任意 filter です。 */
  fromStatusId?: string
  /** 変更後 status ID の任意 filter です。 */
  toStatusId?: string
}

/** Work Item の assignee 変更を検出する trigger です。 */
export type AutomationAssigneeTrigger = {
  /** Trigger discriminator です。 */
  type: 'assignee'
  /** 変更後 assignee member key の任意 filter です。 */
  assigneeMemberKey?: string
}

/** Work Item の due date 変更または到来を検出する trigger です。 */
export type AutomationDueTrigger = {
  /** Trigger discriminator です。 */
  type: 'due'
  /** Due event の理由です。 */
  reason?: 'changed' | 'due' | 'overdue'
}

/** Work Item の custom field 変更を検出する trigger です。 */
export type AutomationCustomFieldTrigger = {
  /** Trigger discriminator です。 */
  type: 'custom-field'
  /** 監視する custom field definition ID です。 */
  fieldId: string
}

/** Work Item Type changes trigger automation rules. */
export type AutomationWorkItemTypeTrigger = {
  /** Trigger discriminator. */
  type: 'work-item-type'
  /** Previous stable type identifier filter. */
  fromWorkItemTypeId?: string
  /** New stable type identifier filter. */
  toWorkItemTypeId?: string
}

/** Comment 作成を検出する trigger です。 */
export type AutomationCommentTrigger = {
  /** Trigger discriminator です。 */
  type: 'comment'
  /** Root comment と reply の任意 filter です。 */
  kind?: 'comment' | 'reply' | 'any'
}

/** Form submission を検出する trigger です。 */
export type AutomationFormTrigger = {
  /** Trigger discriminator です。 */
  type: 'form'
  /** 対象 form ID です。 */
  formId: string
}

/** Inbound webhook を検出する trigger です。 */
export type AutomationWebhookTrigger = {
  /** Trigger discriminator です。 */
  type: 'webhook'
  /** Server が発行する webhook endpoint ID です。 */
  webhookId: string
}

/** Scheduled occurrence を検出する trigger です。 */
export type AutomationScheduleTrigger = {
  /** Trigger discriminator です。 */
  type: 'schedule'
  /** IANA timezone と recurrence を含む schedule です。 */
  schedule: RecurringSchedule
}

/** Automation rule が扱える9種類の trigger です。 */
export type AutomationTrigger =
  | AutomationStatusTrigger
  | AutomationAssigneeTrigger
  | AutomationDueTrigger
  | AutomationCustomFieldTrigger
  | AutomationWorkItemTypeTrigger
  | AutomationCommentTrigger
  | AutomationFormTrigger
  | AutomationWebhookTrigger
  | AutomationScheduleTrigger

/** Field comparison condition が利用できる operator です。 */
export type AutomationConditionOperator =
  | 'equals'
  | 'not-equals'
  | 'contains'
  | 'greater-than'
  | 'greater-than-or-equal'
  | 'less-than'
  | 'less-than-or-equal'
  | 'exists'
  | 'not-exists'

/** Event/Work Item field を比較する condition です。 */
export type AutomationFieldCondition = {
  /** Condition discriminator です。 */
  type: 'field'
  /** `event.`、`workItem.`、`variables.` から始まる field path です。 */
  field: string
  /** Field value に適用する operator です。 */
  operator: AutomationConditionOperator
  /** 比較値です。exists 系では省略します。 */
  value?: AutomationValue
}

/** Child condition がすべて成立する condition です。 */
export type AutomationAllCondition = {
  /** Condition discriminator です。 */
  type: 'all'
  /** AND 評価する child conditions です。 */
  conditions: AutomationCondition[]
}

/** Child condition のいずれかが成立する condition です。 */
export type AutomationAnyCondition = {
  /** Condition discriminator です。 */
  type: 'any'
  /** OR 評価する child conditions です。 */
  conditions: AutomationCondition[]
}

/** Child condition の結果を反転する condition です。 */
export type AutomationNotCondition = {
  /** Condition discriminator です。 */
  type: 'not'
  /** 反転する child condition です。 */
  condition: AutomationCondition
}

/** Automation rule の再帰的 condition tree です。 */
export type AutomationCondition =
  | AutomationFieldCondition
  | AutomationAllCondition
  | AutomationAnyCondition
  | AutomationNotCondition

/** Work Item を担当者へ割り当てる action です。 */
export type AutomationAssignAction = {
  /** Action discriminator です。 */
  type: 'assign'
  /** 割り当てる Workspace member key です。 */
  assigneeMemberKey: string
}

/** Work Item を Project へ移動する action です。 */
export type AutomationMoveAction = {
  /** Action discriminator です。 */
  type: 'move'
  /** 移動先 Project ID です。null は Project 未割り当てを表します。 */
  targetProjectId: string | null
}

/** Work Item fields を更新する action です。 */
export type AutomationUpdateAction = {
  /** Action discriminator です。 */
  type: 'update'
  /** Work Item に適用する patch です。 */
  patch: Record<string, AutomationValue>
}

/** Template または inline values から Work Item を作成する action です。 */
export type AutomationCreateAction = {
  /** Action discriminator です。 */
  type: 'create'
  /** 利用する Work Item template ID です。 */
  templateId?: string
  /** Rule 保存時に server が固定した immutable template version です。 */
  templateVersion?: number
  /** Template に上書きする field values です。 */
  values?: Record<string, AutomationValue>
}

/** Work Item に comment を追加する action です。 */
export type AutomationCommentAction = {
  /** Action discriminator です。 */
  type: 'comment'
  /** Template variable を展開する comment body です。 */
  body: string
}

/** Workspace member へ notification を作る action です。 */
export type AutomationNotifyAction = {
  /** Action discriminator です。 */
  type: 'notify'
  /** Notification recipient の member keys です。 */
  recipientMemberKeys: string[]
  /** Notification title です。 */
  title: string
  /** Notification body です。 */
  body?: string
}

/** Approval request を作成する action です。 */
export type AutomationApprovalAction = {
  /** Action discriminator です。 */
  type: 'approval'
  /** Approval reviewer の member keys です。 */
  reviewerMemberKeys: string[]
  /** Approval 期限までの時間数です。 */
  dueInHours: number
  /** 全承認後の workflow status ID です。 */
  completionStatusId?: string
}

/** Outbound webhook を呼び出す action です。 */
export type AutomationWebhookAction = {
  /** Action discriminator です。 */
  type: 'webhook'
  /** HTTPS endpoint です。 */
  url: string
  /** Workspace-scoped Secrets Manager signing secret の alias です。 */
  secretReference?: string
  /** Webhook body template です。 */
  body?: Record<string, AutomationValue>
}

/** Automation rule が順次実行できる8種類の action です。 */
export type AutomationAction =
  | AutomationAssignAction
  | AutomationMoveAction
  | AutomationUpdateAction
  | AutomationCreateAction
  | AutomationCommentAction
  | AutomationNotifyAction
  | AutomationApprovalAction
  | AutomationWebhookAction

/** Automation action failure の retry policy です。 */
export type AutomationRetryPolicy = {
  /** 初回を含む最大試行回数です。 */
  maxAttempts: number
  /** 最初の retry までの待機 milliseconds です。 */
  initialDelayMs: number
  /** Exponential backoff の倍率です。 */
  backoffMultiplier: number
  /** Retry delay の上限 milliseconds です。 */
  maxDelayMs: number
}

/** Rule 単位の実行 rate limit です。 */
export type AutomationRateLimit = {
  /** Window 内で許可する execution 数です。 */
  maxExecutions: number
  /** Fixed window の秒数です。 */
  windowSeconds: number
}

/** 保存済み versioned automation rule です。 */
export type AutomationRule = {
  /** Automation schema version です。 */
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  /** Workspace 内の rule ID です。 */
  id: string
  /** Rule が属する Workspace ID です。 */
  workspaceId: string
  /** Rule の表示名です。 */
  name: string
  /** Rule を新しい event に適用するかどうかです。 */
  enabled: boolean
  /** Immutable definition version です。 */
  version: number
  /** Optimistic concurrency revision です。 */
  revision: number
  /** Rule を起動する trigger です。 */
  trigger: AutomationTrigger
  /** Trigger 後に評価する conditions です。 */
  conditions: AutomationCondition[]
  /** 成立時に順次実行する actions です。 */
  actions: AutomationAction[]
  /** Action failure の retry policy です。 */
  retryPolicy: AutomationRetryPolicy
  /** Rule 単位の rate limit です。 */
  rateLimit: AutomationRateLimit
  /** 同じ rule が自身の派生 event で再入できるかどうかです。 */
  allowReentry: boolean
  /** Automation lineage に許可する最大 chain depth です。 */
  maxChainDepth: number
  /** Schedule trigger の次回実行予定 UTC ISO 8601 timestamp です。 */
  nextRunAt?: string
  /** Schedule trigger の最後に完了した occurrence timestamp です。 */
  lastRunAt?: string
  /** 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
  /** 最終更新日時の ISO 8601 timestamp です。 */
  updatedAt: string
}

/** Automation rule 作成 API の入力です。 */
export type CreateAutomationRuleInput = {
  /** Rule の表示名です。 */
  name: string
  /** 作成直後から有効にするかどうかです。 */
  enabled: boolean
  /** Rule を起動する trigger です。 */
  trigger: AutomationTrigger
  /** Trigger 後に評価する conditions です。 */
  conditions?: AutomationCondition[]
  /** 成立時に順次実行する actions です。 */
  actions: AutomationAction[]
  /** Action failure の retry policy です。 */
  retryPolicy?: AutomationRetryPolicy
  /** Rule 単位の rate limit です。 */
  rateLimit?: AutomationRateLimit
  /** 同じ rule が自身の派生 event で再入できるかどうかです。 */
  allowReentry?: boolean
  /** Automation lineage に許可する最大 chain depth です。 */
  maxChainDepth?: number
}

/** Automation rule 更新 API の入力です。 */
export type UpdateAutomationRuleInput = Partial<CreateAutomationRuleInput> & {
  /** 読み込み時点の optimistic revision です。 */
  expectedRevision: number
}

/** Automation template の3種類です。 */
export type AutomationTemplateKind = 'work-item' | 'project' | 'workflow'

/** Project template で利用できる表示色です。 */
export type AutomationProjectTemplateTone = 'blue' | 'purple' | 'green' | 'yellow'

/** Work Item template の作成 payload です。 */
export type AutomationWorkItemTemplatePayload = {
  /** Work Item を割り当てる Project ID です。 */
  assignedProjectId?: string | null
  /** Work Item の担当者 user ID です。 */
  assigneeUserId?: string
  /** Custom field ID ごとの初期値です。 */
  customFieldValues?: Record<string, AutomationValue>
  /** Work Item の説明です。 */
  description?: string
  /** Work Item の stable type identifier です。 */
  workItemTypeId?: string
  /** Work Item に保存する complete canonical schedule です。 */
  schedule: WorkItemSchedule
  /** Work Item の優先度です。 */
  priority?: 'low' | 'medium' | 'high'
  /** Recurring/create action が利用する owner Team ID です。 */
  teamId?: string
  /** Work Item のタイトルです。 */
  title: string
  /** 初期 Workflow status ID です。 */
  workflowStatusId?: string
}

/** Project template の作成 payload です。 */
export type AutomationProjectTemplatePayload = {
  /** Locale 非依存の Project 名です。 */
  name?: string
  /** 日本語の Project 名です。 */
  nameJa?: string
  /** 英語の Project 名です。 */
  nameEn?: string
  /** Project の表示色です。 */
  tone?: AutomationProjectTemplateTone
}

/** Workflow template の payload です。 */
export type AutomationWorkflowTemplatePayload = WorkflowDefinition

/** Template kind と payload の対応です。 */
export type AutomationTemplatePayloadByKind = {
  /** Work Item template payload です。 */
  'work-item': AutomationWorkItemTemplatePayload
  /** Project template payload です。 */
  project: AutomationProjectTemplatePayload
  /** Workflow template payload です。 */
  workflow: AutomationWorkflowTemplatePayload
}

/** Kind ごとの versioned Automation template 共通形です。 */
export type AutomationTemplateForKind<TKind extends AutomationTemplateKind> = {
  /** Automation schema version です。 */
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  /** Workspace 内の template ID です。 */
  id: string
  /** Template が属する Workspace ID です。 */
  workspaceId: string
  /** Template discriminator です。 */
  kind: TKind
  /** Template の表示名です。 */
  name: string
  /** Template を clone/recurring から利用できるかどうかです。 */
  enabled: boolean
  /** Immutable template version です。 */
  version: number
  /** Optimistic concurrency revision です。 */
  revision: number
  /** Clone 時に展開する payload です。 */
  payload: AutomationTemplatePayloadByKind[TKind]
  /** 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
  /** 最終更新日時の ISO 8601 timestamp です。 */
  updatedAt: string
}

/** Work Item、Project、Workflow の versioned template です。 */
export type AutomationTemplate = {
  /** Template kind ごとの型を生成します。 */
  [TKind in AutomationTemplateKind]: AutomationTemplateForKind<TKind>
}[AutomationTemplateKind]

/** Kind ごとの Automation template 作成入力です。 */
export type CreateAutomationTemplateInputForKind<TKind extends AutomationTemplateKind> = {
  /** Template discriminator です。 */
  kind: TKind
  /** Template の表示名です。 */
  name: string
  /** 作成直後から利用できるかどうかです。 */
  enabled: boolean
  /** Clone 時に展開する payload です。 */
  payload: AutomationTemplatePayloadByKind[TKind]
}

/** Automation template 作成 API の入力です。 */
export type CreateAutomationTemplateInput = {
  /** Template kind ごとの作成入力を生成します。 */
  [TKind in AutomationTemplateKind]: CreateAutomationTemplateInputForKind<TKind>
}[AutomationTemplateKind]

/** Automation template 更新 API の入力です。 */
export type UpdateAutomationTemplateInput = {
  /** 読み込み時点の optimistic revision です。 */
  expectedRevision: number
  /** Template の表示名です。 */
  name?: string
  /** Template を利用可能にするかどうかです。 */
  enabled?: boolean
  /** Current kind に対応する更新 payload です。 */
  payload?: AutomationTemplatePayloadByKind[AutomationTemplateKind]
}

/** Template application の適用先です。 */
export type AutomationTemplateApplicationTarget =
  | {
      /** Project 作成 target です。 */
      kind: 'project'
      /** Project を追加する Team ID です。 */
      teamId: string
    }
  | {
      /** Workflow 設定 target です。 */
      kind: 'workflow'
      /** Workflow を保存する scope です。 */
      scopeType: 'workspace' | 'team'
      /** Workspace ID または Team ID です。 */
      scopeId: string
      /** Target row の読み込み時 revision です。 */
      expectedRevision: number
    }

/** Template application の成功結果です。 */
export type AutomationTemplateApplicationResult =
  | {
      /** Project 作成結果です。 */
      kind: 'project'
      /** Project を追加した Team ID です。 */
      teamId: string
      /** 作成した Project ID です。 */
      projectId: string
      /** 作成した Project 名です。 */
      name: string
    }
  | {
      /** Workflow 保存結果です。 */
      kind: 'workflow'
      /** 保存した scope です。 */
      scopeType: 'workspace' | 'team'
      /** 保存した scope ID です。 */
      scopeId: string
      /** 保存後の configuration revision です。 */
      revision: number
    }

/** Durable template application receipt です。 */
export type AutomationTemplateApplication = {
  /** Automation schema version です。 */
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  /** Application ID です。 */
  id: string
  /** Workspace ID です。 */
  workspaceId: string
  /** Application を開始した actor ID です。 */
  actorId: string
  /** 適用した template ID です。 */
  templateId: string
  /** 予約時に固定した immutable template version です。 */
  templateVersion: number
  /** Template kind です。 */
  kind: 'project' | 'workflow'
  /** 適用先です。 */
  target: AutomationTemplateApplicationTarget
  /** Application 状態です。 */
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  /** Application の optimistic revision です。 */
  revision: number
  /** Running worker lease の失効日時です。 */
  runnerLeaseExpiresAt?: string
  /** 成功結果です。 */
  result?: AutomationTemplateApplicationResult
  /** Stable error code です。 */
  errorCode?: string
  /** Redacted error message です。 */
  errorMessage?: string
  /** 作成日時です。 */
  createdAt: string
  /** 最終更新日時です。 */
  updatedAt: string
}

/** Template application 作成 API 入力です。 */
export type ApplyAutomationTemplateInput = {
  /** Project または Workflow の適用先です。 */
  target: AutomationTemplateApplicationTarget
}

/** Server-issued inbound webhook endpoint の lifecycle status です。 */
export type AutomationInboundWebhookEndpointStatus =
  | 'provisioning'
  | 'active'
  | 'paused'
  | 'revoked'

/** Workspace に属する server-issued inbound webhook endpoint です。 */
export type AutomationInboundWebhookEndpoint = {
  /** Automation schema version です。 */
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  /** Rule trigger が参照する Workspace 内 endpoint ID です。 */
  id: string
  /** Endpoint が属する Workspace ID です。 */
  workspaceId: string
  /** Public URL にだけ現れる推測困難な endpoint ID です。 */
  opaqueEndpointId: string
  /** 管理 UI に表示する endpoint 名です。 */
  name: string
  /** 現在の lifecycle status です。 */
  status: AutomationInboundWebhookEndpointStatus
  /** Lifecycle または表示設定が変わるたびに増える endpoint version です。 */
  version: number
  /** Secrets Manager の signing secret generation です。 */
  secretGeneration: number
  /** Optimistic concurrency revision です。 */
  revision: number
  /** External sender が POST する public URL です。 */
  endpointUrl: string
  /** Endpoint 作成日時です。 */
  createdAt: string
  /** Endpoint 最終更新日時です。 */
  updatedAt: string
  /** 最後に signing secret を rotate した日時です。 */
  rotatedAt?: string
  /** Endpoint を revoke した日時です。 */
  revokedAt?: string
}

/** Inbound webhook endpoint 作成入力です。 */
export type CreateAutomationInboundWebhookEndpointInput = {
  /** 管理 UI に表示する endpoint 名です。 */
  name: string
}

/** Inbound webhook endpoint 表示設定の更新入力です。 */
export type UpdateAutomationInboundWebhookEndpointInput = {
  /** 読み込み時点の optimistic revision です。 */
  expectedRevision: number
  /** 更新後の endpoint 名です。 */
  name: string
}

/** Pause、resume、rotate、revoke の lifecycle 入力です。 */
export type AutomationInboundWebhookLifecycleInput = {
  /** 読み込み時点の optimistic revision です。 */
  expectedRevision: number
}

/** Create/rotate の一回限り signing secret response です。 */
export type AutomationInboundWebhookSecretResponse = {
  /** 作成または rotate 済み endpoint です。 */
  endpoint: AutomationInboundWebhookEndpoint
  /** Sender に一回だけ保存させる HMAC signing secret です。 */
  signingSecret: string
}

/** Public inbound webhook delivery response です。 */
export type AutomationInboundWebhookDeliveryResponse = {
  /** Audit outbox に保存した deterministic event ID です。 */
  eventId: string
}

/** Missed recurrence の扱いです。 */
export type RecurringCatchUpPolicy = 'skip' | 'latest' | 'all'

/** Daily/weekly/monthly recurring schedule です。 */
export type RecurringSchedule = {
  /** Recurrence cadence です。 */
  frequency: 'daily' | 'weekly' | 'monthly'
  /** Cadence の間隔です。 */
  interval: number
  /** IANA timezone ID です。 */
  timeZone: string
  /** `HH:mm` 形式の local wall-clock time です。 */
  localTime: string
  /** `YYYY-MM-DD` 形式の開始 local date です。 */
  startDate: string
  /** Weekly cadence の曜日です。0 が Sunday です。 */
  daysOfWeek?: number[]
  /** Monthly cadence の日です。 */
  dayOfMonth?: number
  /** Missed occurrence の catch-up policy です。 */
  catchUpPolicy: RecurringCatchUpPolicy
  /** 一回の catch-up で生成する最大 occurrence 数です。 */
  maxCatchUpOccurrences?: number
}

/** Template から繰り返し Work Item を作成する定義です。 */
export type RecurringWork = {
  /** Automation schema version です。 */
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  /** Workspace 内の recurring definition ID です。 */
  id: string
  /** Definition が属する Workspace ID です。 */
  workspaceId: string
  /** 作成する Work Item の owner Team ID です。 */
  teamId: string
  /** 表示名です。 */
  name: string
  /** 新しい occurrence を生成するかどうかです。 */
  enabled: boolean
  /** Immutable definition version です。 */
  version: number
  /** Optimistic concurrency revision です。 */
  revision: number
  /** Work Item template ID です。 */
  templateId: string
  /** Definition 保存時に server が固定した immutable template version です。 */
  templateVersion: number
  /** Recurring schedule です。 */
  schedule: RecurringSchedule
  /** 次回実行予定の UTC ISO 8601 timestamp です。 */
  nextRunAt: string
  /** 最後に materialize した occurrence timestamp です。 */
  lastRunAt?: string
  /** 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
  /** 最終更新日時の ISO 8601 timestamp です。 */
  updatedAt: string
}

/** Recurring Work 作成 API の入力です。 */
export type CreateRecurringWorkInput = {
  /** 表示名です。 */
  name: string
  /** 作成する Work Item の owner Team ID です。 */
  teamId: string
  /** 作成直後から有効にするかどうかです。 */
  enabled: boolean
  /** Work Item template ID です。 */
  templateId: string
  /** Recurring schedule です。 */
  schedule: RecurringSchedule
}

/** Recurring Work 更新 API の入力です。 */
export type UpdateRecurringWorkInput = Partial<CreateRecurringWorkInput> & {
  /** 読み込み時点の optimistic revision です。 */
  expectedRevision: number
}

/** 個別 action execution の状態です。 */
export type AutomationActionExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'

/** Automation execution 内の action result です。 */
export type AutomationActionExecution = {
  /** Action の0始まり index です。 */
  actionIndex: number
  /** Rule version と index から決定する action ID です。 */
  actionId: string
  /** Action execution の状態です。 */
  status: AutomationActionExecutionStatus
  /** 実行を試みた回数です。 */
  attempts: number
  /** 最初の開始日時です。 */
  startedAt?: string
  /** 完了日時です。 */
  completedAt?: string
  /** Stable failure code です。 */
  errorCode?: string
  /** Safe failure message です。 */
  errorMessage?: string
}

/** Automation execution の状態です。 */
export type AutomationExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead-letter' | 'skipped'

/** Rule と trigger event の一つの deterministic execution です。 */
export type AutomationExecution = {
  /** Automation schema version です。 */
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  /** Deterministic execution ID です。 */
  id: string
  /** Workspace ID です。 */
  workspaceId: string
  /** 実行した rule ID です。 */
  ruleId: string
  /** 実行した immutable rule version です。 */
  ruleVersion: number
  /** Trigger にした durable event ID です。 */
  triggerEventId: string
  /** Execution state です。 */
  status: AutomationExecutionStatus
  /** Execution 全体の試行回数です。 */
  attempts: number
  /** Action ごとの execution state です。 */
  actions: AutomationActionExecution[]
  /** 実行開始日時です。 */
  startedAt: string
  /** 完了日時です。 */
  completedAt?: string
  /** 次回 retry 可能日時です。 */
  nextRetryAt?: string
  /** Stable failure code です。 */
  errorCode?: string
  /** Safe failure message です。 */
  errorMessage?: string
  /** UI から retry できるかどうかです。 */
  retryable: boolean
}

/** Bulk operation が対象にする Work Item snapshot です。 */
export type BulkOperationTarget = {
  /** Work Item owner Team ID です。 */
  teamId: string
  /** Work Item ID です。 */
  workItemId: string
  /** Preview 時点の optimistic revision です。 */
  expectedRevision: number
}

/** 複数 Work Item fields を編集する bulk action です。 */
export type BulkEditAction = {
  /** Action discriminator です。 */
  type: 'edit'
  /** 各 Work Item に適用する patch です。 */
  patch: Record<string, AutomationValue>
}

/** 複数 Work Item を Project へ移動する bulk action です。 */
export type BulkMoveAction = {
  /** Action discriminator です。 */
  type: 'move'
  /** 移動先 Project ID です。null は未割り当てです。 */
  targetProjectId: string | null
}

/** 複数 Work Item を archive する bulk action です。 */
export type BulkArchiveAction = {
  /** Action discriminator です。 */
  type: 'archive'
  /** false の場合は archive を解除します。 */
  archived: boolean
}

/** Bulk operation で適用できる action です。 */
export type BulkOperationAction = BulkEditAction | BulkMoveAction | BulkArchiveAction

/** Bulk preview/apply の共通 request です。 */
export type BulkOperationRequest = {
  /** 対象 Workspace ID です。 */
  workspaceId: string
  /** Selection 時点の Work Item snapshots です。 */
  items: BulkOperationTarget[]
  /** 全対象へ適用する action です。 */
  action: BulkOperationAction
  /** Apply 時に preview から受け渡す token です。 */
  operationToken?: string
}

/** Bulk item の preview/apply/undo 状態です。 */
export type BulkOperationItemStatus = 'ready' | 'succeeded' | 'failed' | 'skipped' | 'undone'

/** Bulk operation の Work Item 単位 result です。 */
export type BulkOperationItemResult = BulkOperationTarget & {
  /** Item 単位の状態です。 */
  status: BulkOperationItemStatus
  /** Apply 後の Work Item revision です。 */
  resultingRevision?: number
  /** Stable failure code です。 */
  errorCode?: string
  /** Safe failure message です。 */
  errorMessage?: string
  /** Retry-failed の対象にできるかどうかです。 */
  retryable: boolean
  /** Undo の対象にできるかどうかです。 */
  undoable: boolean
  /** Adapter が保持する opaque undo payload です。 */
  undoPayload?: Record<string, AutomationValue>
}

/** Bulk operation dry-run の結果です。 */
export type BulkOperationPreview = {
  /** Request 内容へ束縛した apply token です。 */
  operationToken: string
  /** Preview 対象 action です。 */
  action: BulkOperationAction
  /** Item 単位の validation result です。 */
  items: BulkOperationItemResult[]
  /** 全 item が apply 可能かどうかです。 */
  canApply: boolean
}

/** Durable bulk operation の状態です。 */
export type BulkOperationStatus = 'pending' | 'running' | 'partial' | 'succeeded' | 'failed' | 'undoing' | 'undone'

/** Apply/retry/undo の durable bulk operation です。 */
export type BulkOperation = {
  /** Automation schema version です。 */
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  /** Bulk operation ID です。 */
  id: string
  /** 対象 Workspace ID です。 */
  workspaceId: string
  /** Operation を開始し、retry/undo を所有する Workspace member key です。 */
  actorMemberKey: string
  /** Durable checkpoint の optimistic concurrency revision です。 */
  revision: number
  /** Bulk operation state です。 */
  status: BulkOperationStatus
  /** 適用した action です。 */
  action: BulkOperationAction
  /** Item 単位の result です。 */
  items: BulkOperationItemResult[]
  /** 作成日時です。 */
  createdAt: string
  /** 最終更新日時です。 */
  updatedAt: string
}
