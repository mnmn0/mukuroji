import type { WorkItemPriority } from './work-items'
import type { CustomFieldValue } from './work-item-configuration'

/** 現在の Request Form schema version です。 */
export const REQUEST_FORM_SCHEMA_VERSION = 1 as const

/** 現在の Request Submission schema version です。 */
export const REQUEST_SUBMISSION_SCHEMA_VERSION = 1 as const

/**
 * Object scan と利用可否をまとめた状態です。
 */
export type FileScanStatus =
  | 'pending'
  | 'scanning'
  | 'available'
  | 'blocked'
  | 'failed'

/** Request form と confirmation で利用できる locale です。 */
export type RequestLocale = 'ja' | 'en'

/** 管理者が入力する locale 別表示文言です。 */
export type RequestLocalizedText = {
  /** 日本語の表示文言です。 */
  ja?: string
  /** 英語の表示文言です。 */
  en?: string
}

/** Request link が要求する access 境界です。 */
export type RequestFormAccessMode = 'public' | 'auth-required' | 'internal'

/** Request form の公開 lifecycle です。 */
export type RequestFormStatus = 'draft' | 'published' | 'archived'

/** Request form の管理 scope です。 */
export type RequestFormScope = {
  /** Workspace 全体または一つの Team に限定した scope です。 */
  type: 'workspace' | 'team'
  /** Team scope の場合に対象となる Team ID です。 */
  teamId?: string
}

/** Form builder が扱う field 種別です。 */
export type RequestFormFieldType =
  | 'short-text'
  | 'long-text'
  | 'email'
  | 'url'
  | 'number'
  | 'boolean'
  | 'date'
  | 'single-select'
  | 'multi-select'
  | 'attachment'

/** Select field の一つの選択肢です。 */
export type RequestFormOption = {
  /** Form version 内で安定した option ID です。 */
  id: string
  /** Locale 別の option label です。 */
  label: RequestLocalizedText
}

/** Field value に適用する server/client 共通 validation です。 */
export type RequestFormFieldValidation = {
  /** Field が表示されている場合に回答を必須にするかどうかです。 */
  required?: boolean
  /** Text value の最小文字数です。 */
  minLength?: number
  /** Text value の最大文字数です。 */
  maxLength?: number
  /** Text value に適用する安全性検証済み regular expression です。 */
  pattern?: string
  /** Number value の最小値です。 */
  min?: number
  /** Number value の最大値です。 */
  max?: number
}

/** Conditional visibility の比較演算子です。 */
export type RequestFormConditionOperator =
  | 'equals'
  | 'not-equals'
  | 'contains'
  | 'is-empty'
  | 'is-not-empty'

/** 先行 field の回答に対する一つの表示条件です。 */
export type RequestFormCondition = {
  /** 参照する先行 field ID です。 */
  fieldId: string
  /** 回答に適用する比較演算子です。 */
  operator: RequestFormConditionOperator
  /** Empty 判定以外の演算子が比較する値です。 */
  value?: string | number | boolean
}

/** 複数の表示条件を結合する group です。 */
export type RequestFormConditionGroup = {
  /** 全条件またはいずれかの条件を要求する結合方法です。 */
  mode: 'all' | 'any'
  /** 前方参照だけで構成された条件一覧です。 */
  conditions: RequestFormCondition[]
}

/** Form section に配置する一つの field 定義です。 */
export type RequestFormField = {
  /** Form version 内で一意な field ID です。 */
  id: string
  /** 回答 value の種別です。 */
  type: RequestFormFieldType
  /** Locale 別の field label です。 */
  label: RequestLocalizedText
  /** Locale 別の補足説明です。 */
  helpText?: RequestLocalizedText
  /** Locale 別の入力 placeholder です。 */
  placeholder?: RequestLocalizedText
  /** Select field が許可する選択肢です。 */
  options?: RequestFormOption[]
  /** Field value に適用する validation rule です。 */
  validation?: RequestFormFieldValidation
  /** Field を表示する条件です。 */
  visibleWhen?: RequestFormConditionGroup
}

/** Form builder の一つの section です。 */
export type RequestFormSection = {
  /** Form version 内で一意な section ID です。 */
  id: string
  /** Locale 別の section title です。 */
  title: RequestLocalizedText
  /** Locale 別の section description です。 */
  description?: RequestLocalizedText
  /** Section 全体を表示する先行 field 条件です。 */
  visibleWhen?: RequestFormConditionGroup
  /** 表示順を保持する field 一覧です。 */
  fields: RequestFormField[]
}

/** Submit 時に記録する consent 定義です。 */
export type RequestFormConsent = {
  /** Submit に consent を必須とするかどうかです。 */
  required: boolean
  /** Version とともに保存する locale 別 consent 文面です。 */
  label: RequestLocalizedText
  /** Consent に対応する same-origin path または HTTPS URL です。 */
  privacyUrl?: string
}

/** Request attachment の upload 制約です。 */
export type RequestAttachmentPolicy = {
  /** Anonymous/authenticated intake upload を許可するかどうかです。 */
  enabled: boolean
  /** 一つの submission に添付できる最大 file 数です。 */
  maxFiles: number
  /** 一つの file に許可する最大 byte 数です。 */
  maxSizeBytes: number
  /** 許可する MIME type 一覧です。 */
  allowedMediaTypes: string[]
}

/** Submit 完了後に外部 requester へ返す表示設定です。 */
export type RequestFormConfirmation = {
  /** Locale 別の confirmation message です。 */
  message: RequestLocalizedText
  /** Confirmation 後に表示できる same-origin path または HTTPS URL です。 */
  redirectUrl?: string
}

/** 公開 Request Form の versioned 表示定義です。 */
export type RequestFormDefinition = {
  /** Form の既定 locale です。 */
  defaultLocale: RequestLocale
  /** Submitter が選択できる locale 一覧です。 */
  supportedLocales: RequestLocale[]
  /** Locale 別の form title です。 */
  title: RequestLocalizedText
  /** Locale 別の form description です。 */
  description?: RequestLocalizedText
  /** 表示順を保持する section 一覧です。 */
  sections: RequestFormSection[]
  /** Submit 時に保存する consent 定義です。 */
  consent?: RequestFormConsent
  /** Request 専用 attachment policy です。 */
  attachments?: RequestAttachmentPolicy
  /** Submit 完了後の表示設定です。 */
  confirmation: RequestFormConfirmation
}

/** Routing rule が選ぶ Work Item 作成先です。 */
export type RequestFormRoutingTarget = {
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Work Item の作成に利用する Work Item Type ID です。省略時は built-in type です。 */
  workItemTypeId?: string
  /** Work Item の遂行先 Project ID です。 */
  projectId?: string
  /** Team workflow 内の status ID です。 */
  workflowStatusId?: string
  /** Work Item の担当 Workspace member ID です。 */
  assigneeUserId: string
  /** 作成する Work Item の既定 priority です。 */
  priority: WorkItemPriority
  /** Submission 日から期限日までの日数です。 */
  dueDateOffsetDays: number
}

/** 条件に一致した submission を routing する ordered rule です。 */
export type RequestFormRoutingRule = {
  /** Form 内で安定した rule ID です。 */
  id: string
  /** 管理画面で表示する rule 名です。 */
  name: string
  /** Rule を適用する回答条件です。 */
  when: RequestFormConditionGroup
  /** 条件一致時に利用する routing target です。 */
  target: RequestFormRoutingTarget
}

/** Form response を Work Item field へ写像する定義です。 */
export type RequestWorkItemMapping = {
  /** Work Item title に利用する form field ID です。 */
  titleFieldId: string
  /** Work Item description を順に構成する form field ID 一覧です。 */
  descriptionFieldIds?: string[]
  /** Form field ID から custom field ID への対応です。 */
  customFieldMappings?: Record<string, string>
}

/** Form version とともに固定する private routing 設定です。 */
export type RequestFormRoutingConfiguration = {
  /** どの rule にも一致しない場合の routing target です。 */
  defaultTarget: RequestFormRoutingTarget
  /** 最初に一致した rule を採用する ordered rule 一覧です。 */
  rules: RequestFormRoutingRule[]
  /** Submission から Work Item を作成する mapping です。 */
  mapping: RequestWorkItemMapping
}

/** 編集中の form 内容と private routing 設定です。 */
export type RequestFormDraft = {
  /** 外部へ公開できる form 表示定義です。 */
  definition: RequestFormDefinition
  /** 外部へ返さない routing 設定です。 */
  routing: RequestFormRoutingConfiguration
}

/** 管理者が配布する capability link です。 */
export type RequestFormLink = {
  /** Form 内で link を識別する ID です。 */
  linkId: string
  /** URL に埋め込む high-entropy capability token です。 */
  token: string
  /** Link の access 境界です。 */
  accessMode: RequestFormAccessMode
  /** Link が利用できなくなる ISO 8601 timestamp です。 */
  expiresAt?: string
  /** Link を失効した ISO 8601 timestamp です。 */
  revokedAt?: string
}

/** Form の immutable published version です。 */
export type RequestFormVersion = {
  /** Request Form schema version です。 */
  schemaVersion: typeof REQUEST_FORM_SCHEMA_VERSION
  /** Form ID です。 */
  formId: string
  /** Form ごとの単調増加 version です。 */
  version: number
  /** 公開時点の表示/routing snapshot です。 */
  snapshot: RequestFormDraft
  /** Version を作成した Workspace member ID です。 */
  createdBy: string
  /** Version を作成した ISO 8601 timestamp です。 */
  createdAt: string
}

/** Current principal に対する form 管理 capability です。 */
export type RequestFormCapabilities = {
  /** Draft を編集できるかどうかです。 */
  canEdit: boolean
  /** 新しい immutable version を公開できるかどうかです。 */
  canPublish: boolean
  /** Link を配布または更新できるかどうかです。 */
  canManageLink: boolean
}

/** 管理 API が返す Request Form です。 */
export type RequestForm = {
  /** Form ID です。 */
  id: string
  /** 管理画面で使う form 名です。 */
  name: string
  /** Form の管理/認可 scope です。 */
  scope: RequestFormScope
  /** Form の公開 lifecycle です。 */
  status: RequestFormStatus
  /** Optimistic concurrency に使う単調増加 revision です。 */
  revision: number
  /** 次回 publish 対象の編集内容です。 */
  draft: RequestFormDraft
  /** 現在 link が参照する published version です。 */
  currentPublishedVersion?: number
  /** 作成済み immutable version の昇順一覧です。 */
  publishedVersions: number[]
  /** Form の capability link です。 */
  link: RequestFormLink
  /** Form を作成した ISO 8601 timestamp です。 */
  createdAt: string
  /** Form を最後に更新した ISO 8601 timestamp です。 */
  updatedAt: string
  /** Current principal に許可された操作です。 */
  capabilities: RequestFormCapabilities
}

/** Request Form を新規作成する入力です。 */
export type CreateRequestFormInput = {
  /** 管理画面で使う form 名です。 */
  name: string
  /** Form の管理/認可 scope です。 */
  scope: RequestFormScope
  /** Capability link の access 境界です。 */
  accessMode: RequestFormAccessMode
  /** Capability link の任意有効期限です。 */
  expiresAt?: string
  /** 最初の draft 内容です。 */
  draft: RequestFormDraft
}

/** Request Form draft/link を更新する入力です。 */
export type UpdateRequestFormInput = {
  /** 読み込み時点の form revision です。 */
  expectedRevision: number
  /** 更新後の管理用 form 名です。 */
  name?: string
  /** 更新後の form scope です。 */
  scope?: RequestFormScope
  /** 更新後の lifecycle です。 */
  status?: 'draft' | 'archived'
  /** 更新後の capability access 境界です。 */
  accessMode?: RequestFormAccessMode
  /** 更新後の link 有効期限です。null で解除します。 */
  expiresAt?: string | null
  /** 更新後の draft 内容です。 */
  draft?: RequestFormDraft
  /** Capability token を安全に入れ替えるかどうかです。 */
  rotateLinkToken?: boolean
}

/** Current draft を immutable version として公開する入力です。 */
export type PublishRequestFormInput = {
  /** 読み込み時点の form revision です。 */
  expectedRevision: number
}

/** Public form GET が発行する one-time submission session です。 */
export type RequestSubmissionSession = {
  /** Submit/upload endpoint へ送る capability token です。 */
  token: string
  /** Session が失効する ISO 8601 timestamp です。 */
  expiresAt: string
  /** Bot 対策として submit を受け付け始める timestamp です。 */
  minimumSubmitAt: string
}

/** 外部 requester に返せる allowlist 済み form DTO です。 */
export type PublicRequestForm = {
  /** Request Form schema version です。 */
  schemaVersion: typeof REQUEST_FORM_SCHEMA_VERSION
  /** 外部 receipt と関連付ける form ID です。 */
  formId: string
  /** 表示に利用する immutable published version です。 */
  version: number
  /** Link が要求する access 境界です。 */
  accessMode: RequestFormAccessMode
  /** Routing/permission 情報を含まない form 表示定義です。 */
  definition: RequestFormDefinition
  /** Upload と submit を一つの published version に固定する session です。 */
  submissionSession: RequestSubmissionSession
}

/** Request field answer に保存できる値です。 */
export type RequestAnswerValue = string | number | boolean | string[]

/** Request 専用 attachment upload session を作成する入力です。 */
export type RequestAttachmentUploadInput = {
  /** Public form GET で発行された submission session token です。 */
  sessionToken: string
  /** Attachment field ID です。 */
  fieldId: string
  /** Submitter が選択した file 名です。 */
  fileName: string
  /** Browser が報告した MIME type です。 */
  contentType: string
  /** Browser が報告した byte 数です。 */
  sizeBytes: number
}

/** Direct PUT upload の短命接続情報です。 */
export type RequestPresignedUpload = {
  /** Object storage の短命 URL です。 */
  url: string
  /** Upload に使う HTTP method です。 */
  method: 'PUT'
  /** 署名対象の request header です。 */
  headers: Record<string, string>
  /** Upload URL が失効する ISO 8601 timestamp です。 */
  expiresAt: string
  /** Session が許可する最大 byte 数です。 */
  maxSizeBytes: number
}

/** Request attachment の direct upload session です。 */
export type RequestAttachmentUploadSession = {
  /** Submission answer から参照する attachment ID です。 */
  attachmentId: string
  /** Attachment field ID です。 */
  fieldId: string
  /** Session 更新後もこの attachment の所有を証明する one-time claim token です。 */
  claimToken: string
  /** 署名付き direct upload 情報です。 */
  upload: RequestPresignedUpload
}

/** External requester が送る submission 入力です。 */
export type SubmitRequestInput = {
  /** Public form GET で発行された one-time session token です。 */
  sessionToken: string
  /** 回答時に選択した locale です。 */
  locale: RequestLocale
  /** Field ID ごとの typed answer です。 */
  answers: Record<string, RequestAnswerValue>
  /** Attachment ID ごとの upload claim token です。 */
  attachmentClaims?: Record<string, string>
  /** Versioned consent 文面への同意状態です。 */
  consentAccepted?: boolean
  /** Bot が入力した場合だけ値を持つ不可視 field です。 */
  honeypot?: string
}

/** External requester に返す submission receipt です。 */
export type RequestSubmissionReceipt = {
  /** 内部 submission ID と分離した opaque receipt ID です。 */
  receiptId: string
  /** Submission を受理した ISO 8601 timestamp です。 */
  submittedAt: string
  /** 選択 locale の confirmation message です。 */
  confirmationMessage: string
  /** Requester reply を同じ thread に関連付ける capability token です。 */
  threadToken: string
}

/** Intake queue 上の submission lifecycle です。 */
export type RequestSubmissionStatus =
  | 'received'
  | 'triaging'
  | 'needs-more-info'
  | 'rejected'
  | 'duplicate'
  | 'converted'

/** Submission が到着した channel です。 */
export type RequestSubmissionSource = 'web' | 'email'

/** Submission に固定する consent receipt です。 */
export type RequestConsentReceipt = {
  /** Submitter が同意したかどうかです。 */
  accepted: boolean
  /** 同意対象となった versioned 文面です。 */
  label: RequestLocalizedText
  /** 同意した ISO 8601 timestamp です。 */
  acceptedAt?: string
}

/** Submission に関連付けた request attachment metadata です。 */
export type RequestAttachment = {
  /** Attachment ID です。 */
  id: string
  /** Attachment field ID です。 */
  fieldId: string
  /** Submitter が指定した file 名です。 */
  fileName: string
  /** 検証対象の MIME type です。 */
  contentType: string
  /** 検証対象の byte 数です。 */
  sizeBytes: number
  /** Malware scan と download gate の状態です。 */
  scanStatus: FileScanStatus
}

/** Request submission から作成した Work Item 参照です。 */
export type RequestWorkItemReference = {
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Work Item ID です。 */
  workItemId: string
  /** Work Item の遂行先 Project ID です。 */
  projectId?: string
}

/** Request thread に保存する message です。 */
export type RequestSubmissionMessage = {
  /** Message ID です。 */
  id: string
  /** Requester または内部 triager から見た方向です。 */
  direction: 'requester' | 'internal'
  /** Message が到着した channel です。 */
  source: 'web' | 'email' | 'internal'
  /** Plain text message 本文です。 */
  body: string
  /** Message 作成日時です。 */
  createdAt: string
}

/** Request submission に対する append-only activity です。 */
export type RequestSubmissionEvent = {
  /** Event ID です。 */
  id: string
  /** 安定した event type です。 */
  type:
    | 'submitted'
    | 'assigned'
    | 'more-info-requested'
    | 'requester-replied'
    | 'rejected'
    | 'duplicate-marked'
    | 'converted'
  /** Event を発生させた actor 表示 ID です。 */
  actorId: string
  /** Answer 本文を含まない安全な概要です。 */
  summary: string
  /** Event 発生日時です。 */
  createdAt: string
}

/** Current principal に対する submission 操作 capability です。 */
export type RequestSubmissionCapabilities = {
  /** Queue assignee を変更できるかどうかです。 */
  canAssign: boolean
  /** Requester に追加情報を求められるかどうかです。 */
  canRequestMoreInfo: boolean
  /** Submission を reject できるかどうかです。 */
  canReject: boolean
  /** Duplicate として確定できるかどうかです。 */
  canMarkDuplicate: boolean
  /** Canonical Work Item へ変換できるかどうかです。 */
  canConvert: boolean
}

/** Internal intake queue が返す versioned submission です。 */
export type RequestSubmission = {
  /** Request Submission schema version です。 */
  schemaVersion: typeof REQUEST_SUBMISSION_SCHEMA_VERSION
  /** 内部 submission ID です。 */
  id: string
  /** 外部へ返した receipt ID です。 */
  receiptId: string
  /** Submission 元 form ID です。 */
  formId: string
  /** Submission が参照する immutable form version です。 */
  formVersion: number
  /** Historical response 表示に使う immutable form snapshot です。 */
  formSnapshot: RequestFormVersion
  /** Intake lifecycle の現在状態です。 */
  status: RequestSubmissionStatus
  /** Submission が到着した channel です。 */
  source: RequestSubmissionSource
  /** Optimistic concurrency に使う revision です。 */
  revision: number
  /** Submitter が選択した locale です。 */
  locale: RequestLocale
  /** Visible field だけを含む typed answer map です。 */
  answers: Record<string, RequestAnswerValue>
  /** Versioned consent receipt です。 */
  consent?: RequestConsentReceipt
  /** Request 専用 attachment metadata です。 */
  attachments: RequestAttachment[]
  /** Submit 時点で解決済みの private routing target です。 */
  routingTarget: RequestFormRoutingTarget
  /** Submit 時点で固定した Work Item mapping です。 */
  workItemMapping: RequestWorkItemMapping
  /** Exact duplicate 検出で候補になった submission ID です。 */
  duplicateCandidateIds: string[]
  /** Queue を担当する Workspace member ID です。 */
  triageAssigneeUserId?: string
  /** Duplicate として確定した対象 submission ID です。 */
  duplicateOfSubmissionId?: string
  /** 変換済み canonical Work Item 参照です。 */
  workItem?: RequestWorkItemReference
  /** Thread に保存された bounded plain text message です。 */
  messages: RequestSubmissionMessage[]
  /**
   * Submission activity です。Detail/action response は完全な append-only 履歴、
   * queue page は submission root の bounded projection を返します。
   */
  events: RequestSubmissionEvent[]
  /** Submission を受理した ISO 8601 timestamp です。 */
  createdAt: string
  /** Submission を最後に更新した ISO 8601 timestamp です。 */
  updatedAt: string
  /** Current principal に許可された操作です。 */
  capabilities: RequestSubmissionCapabilities
}

/** Cursor pagination された intake queue です。 */
export type RequestSubmissionPage = {
  /** Current scope で参照できる bounded event projection 付き submission 一覧です。 */
  submissions: RequestSubmission[]
  /** 次 page を指す scope-bound opaque cursor です。 */
  nextCursor?: string
}

/** Queue assignee を変更する action です。 */
export type AssignRequestSubmissionAction = {
  /** Action discriminator です。 */
  action: 'assign'
  /** 読み込み時点の submission revision です。 */
  expectedRevision: number
  /** New queue assignee member ID, or null to leave the Triage entry unowned. */
  assigneeUserId: string | null
}

/** Requester へ追加情報を求める action です。 */
export type RequestMoreInfoSubmissionAction = {
  /** Action discriminator です。 */
  action: 'request-more-info'
  /** 読み込み時点の submission revision です。 */
  expectedRevision: number
  /** Requester へ送る plain text message です。 */
  message: string
}

/** Submission を reject する action です。 */
export type RejectRequestSubmissionAction = {
  /** Action discriminator です。 */
  action: 'reject'
  /** 読み込み時点の submission revision です。 */
  expectedRevision: number
  /** Internal timeline に残す reject 理由です。 */
  reason: string
}

/** Submission を duplicate として確定する action です。 */
export type MarkDuplicateRequestSubmissionAction = {
  /** Action discriminator です。 */
  action: 'mark-duplicate'
  /** 読み込み時点の submission revision です。 */
  expectedRevision: number
  /** Duplicate 元となる同一 Workspace submission ID です。 */
  duplicateOfSubmissionId: string
}

/** Submission を Work Item へ変換する action です。 */
export type ConvertRequestSubmissionAction = {
  /** Action discriminator です。 */
  action: 'convert'
  /** 読み込み時点の submission revision です。 */
  expectedRevision: number
  /** Work Item creation に利用する active Work Item Type ID です。 */
  workItemTypeId?: string
  /** 保存済み routing target を上書きする値です。 */
  target?: Partial<RequestFormRoutingTarget>
  /** Mapping から生成した title を上書きする値です。 */
  title?: string
  /** Mapping から生成した description を上書きする値です。 */
  description?: string
  /** Selected Work Item Type の custom field values; null explicitly clears a mapped value. */
  customFieldValues?: Record<string, CustomFieldValue | null>
}

/** Intake queue で許可する明示的な state transition input です。 */
export type RequestSubmissionActionInput =
  | AssignRequestSubmissionAction
  | RequestMoreInfoSubmissionAction
  | RejectRequestSubmissionAction
  | MarkDuplicateRequestSubmissionAction
  | ConvertRequestSubmissionAction

/** Requester capability thread へ reply する入力です。 */
export type RequestRequesterReplyInput = {
  /** Plain text reply 本文です。 */
  body: string
}

/** Requester reply を受理した最小 receipt です。 */
export type RequestRequesterReplyReceipt = {
  /** Reply を識別する opaque ID です。 */
  replyId: string
  /** Reply を受理した ISO 8601 timestamp です。 */
  receivedAt: string
}

/** External requester に公開できる thread message です。 */
export type RequestRequesterThreadMessage = {
  /** Opaque message ID です。 */
  id: string
  /** Message を送信した側です。 */
  direction: 'requester' | 'staff'
  /** Bounded plain text message 本文です。 */
  body: string
  /** Message を受理または作成した ISO 8601 timestamp です。 */
  createdAt: string
}

/** Opaque capability で requester に返す allowlist 済み thread view です。 */
export type RequestRequesterThread = {
  /** Reply を受け付けられるかどうかです。 */
  status: 'open' | 'closed'
  /** Internal routing/event metadata を除いた時系列 message です。 */
  messages: RequestRequesterThreadMessage[]
  /** Thread が最後に更新された ISO 8601 timestamp です。 */
  updatedAt: string
}

/** 署名検証済み email adapter が ingestion Lambda へ渡す envelope です。 */
export type RequestEmailEnvelope = {
  /** Reply capability local-part から復元した thread token です。 */
  threadToken: string
  /** Provider が保証する一意な email Message-ID です。 */
  messageId: string
  /** Normalized sender email address です。 */
  fromAddress: string
  /** 命令として解釈しない bounded subject です。 */
  subject?: string
  /** HTML/quoted content を除去した plain text 本文です。 */
  textBody: string
  /** Provider が message を受信した ISO 8601 timestamp です。 */
  receivedAt: string
}
