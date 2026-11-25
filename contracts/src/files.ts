import type { FileScanStatus } from './request-intake'

/**
 * File を関連付ける resource 種別です。
 */
export type FileAttachmentTargetType = 'work-item' | 'comment' | 'project'

/**
 * Browser で位置付き preview を提供できる media 種別です。
 */
export type FilePreviewKind = 'image' | 'pdf' | 'video' | 'none'

/**
 * File version の API 表現です。
 */
export type FileVersion = {
  /**
   * File version ID です。
   */
  id: string
  /**
   * 同一 File 内で単調増加する version 番号です。
   */
  number: number
  /**
   * 利用者へ表示する file 名です。
   */
  fileName: string
  /**
   * Upload 時に検証した media type です。
   */
  contentType: string
  /**
   * Object の byte 数です。
   */
  sizeBytes: number
  /**
   * Object scan の現在状態です。
   */
  scanStatus: FileScanStatus
  /**
   * Browser preview の種別です。
   */
  previewKind: FilePreviewKind
  /**
   * Version を作成した Workspace member key です。
   */
  createdByMemberKey: string
  /**
   * Version 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * S3 upload を検証した日時です。
   */
  verifiedAt?: string
}

/**
 * File 単位で現在 user に許可された操作です。
 */
export type FileAttachmentCapabilities = {
  /**
   * Clean な version の download URL を発行できるかどうかです。
   */
  canDownload: boolean
  /**
   * 新しい version を upload できるかどうかです。
   */
  canUploadVersion: boolean
  /**
   * File を soft delete できるかどうかです。
   */
  canDelete: boolean
  /**
   * Version に位置付き annotation を追加できるかどうかです。
   */
  canAnnotate: boolean
  /**
   * Version の approval を依頼できるかどうかです。
   */
  canRequestApproval: boolean
}

/**
 * Work Item、comment、project に関連付けた File です。
 */
export type FileAttachment = {
  /**
   * File ID です。
   */
  id: string
  /**
   * File の表示名です。
   */
  name: string
  /**
   * File を関連付けた resource 種別です。
   */
  targetType: FileAttachmentTargetType
  /**
   * Work Item、comment、project の公開 ID です。
   */
  targetId: string
  /**
   * 保存済み version 数です。
   */
  versionCount: number
  /**
   * 新しい順に並べた version 一覧です。
   */
  versions: FileVersion[]
  /**
   * 現在の version です。
   */
  currentVersion: FileVersion
  /**
   * File 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * File 最終更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
  /**
   * Soft delete された日時です。
   */
  deletedAt?: string
  /**
   * 認証済み Workspace guest への read が明示的に許可されているかどうかです。
   */
  guestAccess?: boolean
  /**
   * Retention 後に物理削除できる日時です。
   */
  retentionUntil?: string
  /**
   * 現在 version に残る未解決 annotation の件数です。一覧 API だけが返します。
   */
  unresolvedAnnotationCount?: number
  /**
   * 現在 user に許可された操作です。
   */
  capabilities: FileAttachmentCapabilities
}

/**
 * Preview 上の annotation 位置です。
 */
export type AnnotationAnchor = {
  /**
   * Anchor を解釈する preview 種別です。
   */
  kind: 'image' | 'pdf' | 'video'
  /**
   * Image/PDF 幅に対する 0..1 の X 座標です。
   */
  x?: number
  /**
   * Image/PDF 高さに対する 0..1 の Y 座標です。
   */
  y?: number
  /**
   * PDF の 1 始まり page 番号です。
   */
  pageNumber?: number
  /**
   * Video 内の millisecond 単位の位置です。
   */
  timecodeMs?: number
}

/**
 * Annotation 単位で現在 user に許可された操作です。
 */
export type FileAnnotationCapabilities = {
  /**
   * Annotation を resolve / reopen できるかどうかです。
   */
  canResolve: boolean
  /**
   * Annotation を削除できるかどうかです。作成者だけに許可します。
   */
  canDelete: boolean
}

/**
 * File version preview 上の位置付き review comment です。
 */
export type FileAnnotation = {
  /**
   * Annotation ID です。
   */
  id: string
  /**
   * 対象 File ID です。
   */
  fileId: string
  /**
   * 対象 version ID です。
   */
  versionId: string
  /**
   * Preview 上の位置です。
   */
  anchor: AnnotationAnchor
  /**
   * Markdown source の review comment です。
   */
  bodyMarkdown: string
  /**
   * 作成者の Workspace member key です。
   */
  authorMemberKey: string
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * Resolve された日時です。
   */
  resolvedAt?: string
  /**
   * Resolve した Workspace member key です。
   */
  resolvedByMemberKey?: string
  /**
   * 現在 user に許可された操作です。
   */
  capabilities: FileAnnotationCapabilities
}

/**
 * Reviewer 個人の判断状態です。
 */
export type ApprovalReviewerStatus = 'pending' | 'approved' | 'rejected' | 'changes-requested'

/**
 * Approval request 全体の状態です。
 */
export type ApprovalRequestStatus = ApprovalReviewerStatus | 'cancelled'

/**
 * Approval が判断対象にする resource の種別です。
 */
export type ApprovalSubjectType = 'file-version' | 'work-item'

/**
 * Approval request を作成した主体の種別です。
 */
export type ApprovalRequesterKind = 'member' | 'service'

/**
 * Approval reviewer の現在状態です。
 */
export type ApprovalReviewer = {
  /**
   * Reviewer の Workspace member key です。
   */
  memberKey: string
  /**
   * Reviewer の判断状態です。
   */
  status: ApprovalReviewerStatus
  /**
   * 最後に判断した日時です。
   */
  decidedAt?: string
  /**
   * 判断時に添えた comment です。
   */
  comment?: string
}

/**
 * Approval 単位で現在 user に許可された操作です。
 */
export type ApprovalCapabilities = {
  /**
   * 現在 user が reviewer decision を保存できるかどうかです。
   */
  canDecide: boolean
  /**
   * Approval request を cancel できるかどうかです。
   */
  canCancel: boolean
}

/**
 * Approval request が判断対象にする resource です。
 */
type ApprovalSubject =
  | {
      /**
       * File version approval を示します。
       */
      subjectType: Extract<ApprovalSubjectType, 'file-version'>
      /**
       * 対象 File ID です。
       */
      fileId: string
      /**
       * 対象 version ID です。
       */
      versionId: string
    }
  | {
      /**
       * Work Item approval を示します。
       */
      subjectType: Extract<ApprovalSubjectType, 'work-item'>
      /**
       * Work Item subject では指定しません。
       */
      fileId?: never
      /**
       * Work Item subject では指定しません。
       */
      versionId?: never
    }

/**
 * Work Item 自体または特定 File version に対する approval request です。
 */
export type ApprovalRequest = ApprovalSubject & {
  /**
   * Approval ID です。
   */
  id: string
  /**
   * Reviewer Inbox から遷移する Team ID です。
   */
  teamId?: string
  /**
   * Reviewer Inbox から遷移する Work Item ID です。
   */
  issueId?: string
  /**
   * 現在の認可を再検証する assigned Project ID です。
   */
  projectId?: string
  /**
   * Optimistic concurrency に使う revision です。
   */
  revision: number
  /**
   * Approval 全体の状態です。
   */
  status: ApprovalRequestStatus
  /**
   * Reviewer と個別判断です。
   */
  reviewers: ApprovalReviewer[]
  /**
   * 判断期限の ISO 8601 timestamp です。
   */
  dueAt: string
  /**
   * Request 作成者の Workspace member key です。
   */
  requestedByMemberKey: string
  /**
   * Requester が Workspace member か automation などの service かを示します。
   */
  requestedByKind: ApprovalRequesterKind
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * 最終更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
  /**
   * Approval 完了日時です。
   */
  completedAt?: string
  /**
   * File version subject に残る未解決 annotation の件数です。scope の一覧 API だけが返します。
   */
  unresolvedAnnotationCount?: number
  /**
   * 現在 user に許可された操作です。
   */
  capabilities: ApprovalCapabilities
}

/**
 * Project の成果物一覧で表示する、現在 version の承認状態です。
 * `none` は現在 version に承認依頼がない（または取り消された）ことを表します。
 */
export type ProjectDeliverableApprovalState =
  | 'none'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'changes-requested'

/**
 * Project の成果物一覧の承認状態による絞り込みです。`unapproved` は `approved` 以外を返します。
 */
export type ProjectDeliverableApprovalFilter =
  | 'all'
  | 'unapproved'
  | 'pending'
  | 'approved'

/**
 * 成果物一覧の 1 page で読む Work Item 数の既定値です。
 */
export const PROJECT_DELIVERABLE_PAGE_DEFAULT_LIMIT = 50

/**
 * 成果物一覧の 1 page で読む Work Item 数の上限です。
 */
export const PROJECT_DELIVERABLE_PAGE_MAX_LIMIT = 100

/**
 * 成果物を所有する resource です。
 */
export type ProjectDeliverableOwner =
  | {
      /**
       * Project に直接添付した file を示します。
       */
      kind: 'project'
      /**
       * Project を所有する Team ID です。
       */
      teamId: string
      /**
       * Project ID です。
       */
      projectId: string
    }
  | {
      /**
       * Work Item（またはその comment）に添付した file を示します。
       */
      kind: 'work-item'
      /**
       * Work Item を所有する Team ID です。
       */
      teamId: string
      /**
       * Work Item ID です。
       */
      issueId: string
      /**
       * 表示用の Work Item key です。
       */
      key?: string
      /**
       * Work Item のタイトルです。
       */
      title: string
    }

/**
 * Project の成果物一覧の 1 行です。
 */
export type ProjectDeliverable = {
  /**
   * 成果物の file です。`unresolvedAnnotationCount` を含みます。
   */
  file: FileAttachment
  /**
   * File を所有する Project または Work Item です。
   */
  owner: ProjectDeliverableOwner
  /**
   * 現在 version の承認状態です。
   */
  approvalState: ProjectDeliverableApprovalState
  /**
   * 承認状態を決めた approval request の ID です。
   */
  approvalId?: string
  /**
   * 現在 version に残る未解決 annotation の件数です。
   */
  unresolvedAnnotationCount: number
}

/**
 * Project の成果物一覧の page です。
 */
export type ProjectDeliverablePage = {
  /**
   * この page の成果物です。更新日の新しい順に並びます。
   */
  deliverables: ProjectDeliverable[]
  /**
   * 続きの page を読む opaque cursor です。
   */
  nextCursor?: string
}
