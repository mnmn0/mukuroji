import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectAttributesCommand,
  GetObjectTaggingCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
  type Tag,
} from '@aws-sdk/client-s3'
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createHash } from 'node:crypto'
import type {
  AnnotationAnchor,
  ApprovalRequest,
  ApprovalRequestStatus,
  ApprovalReviewer,
  ApprovalReviewerStatus,
  ApprovalSummary,
  FileAnnotation,
  FileAttachment,
  FileAttachmentCapabilities,
  FileAttachmentTargetType,
  FilePreviewKind,
  FileScanStatus,
  FileVersion,
  WorkItemStatus,
} from '@mukuroji/contracts'
import {
  createMutationAuditEventPut,
  getConfiguredAuditTableName,
  getConfiguredDynamoDbEndpoint,
  type MutationAuditContext,
} from './audit'
import { isMissingFileObjectVersionError } from './file-object-errors'

/** Browser から直接 upload できる既定の最大 byte 数です。 */
export const FILE_UPLOAD_MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024

/** 一つの approval request に指定できる reviewer 上限です。 */
export const FILE_APPROVAL_MAX_REVIEWERS = 20

/** Approval decision comment 一件の最大文字数です。 */
export const FILE_APPROVAL_COMMENT_MAX_LENGTH = 2_000

/** GuardDuty が object tag に保存する malware scan status key です。 */
export const GUARDDUTY_SCAN_STATUS_TAG = 'GuardDutyMalwareScanStatus'

/** File proofing API が扱う安定 error です。 */
export class FileProofingError extends Error {
  /** HTTP response に対応する status code です。 */
  readonly status: number

  /** Client が分岐できる安定 error code です。 */
  readonly code: string

  /** File proofing error を作成します。 */
  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FileProofingError'
    this.status = status
    this.code = code
  }
}

/** File attachment を保存する Team scoped resource です。 */
export type FileProofingScope = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Resource を所有する Team ID です。 */
  teamId: string
  /** Scope 種別です。 */
  kind: 'work-item' | 'project'
  /** Work Item scope の ID です。 */
  issueId?: string
  /** Project scope の ID です。 */
  projectId?: string
  /** 保存済み comment へ直接添付する場合の comment ID です。 */
  commentId?: string
}

/** File API で認可済みの actor context です。 */
export type FileProofingActor = {
  /** Workspace member key です。 */
  memberKey: string
  /** Guest role かどうかです。 */
  guest: boolean
  /** Scope へ content を追加・review できるかどうかです。 */
  canWrite: boolean
  /** Scope の file を削除・外部共有できるかどうかです。 */
  canManage: boolean
}

/** 新規 file または version upload session の入力です。 */
export type CreateFileUploadInput = {
  /** Browser が送信する file 名です。 */
  fileName: string
  /** Browser が送信する MIME type です。 */
  contentType: string
  /** Browser が送信する byte 数です。 */
  sizeBytes: number
  /** 認証済み guest にも read を許可するかどうかです。 */
  guestAccess?: boolean
}

/** Object storage へ直接 PUT するための短命接続情報です。 */
export type PresignedPutUpload = {
  /** 署名付き upload URL です。 */
  url: string
  /** Upload に使う HTTP method です。 */
  method: 'PUT'
  /** 署名対象になった allowlist header です。 */
  headers: Record<string, string>
  /** URL 有効期限の ISO 8601 timestamp です。 */
  expiresAt: string
  /** Session が許可する最大 byte 数です。 */
  maxSizeBytes: number
}

/** File metadata と direct upload URL をまとめた session です。 */
export type FileUploadSession = {
  /** 作成または更新対象の file です。 */
  file: FileAttachment
  /** 今回 upload する version です。 */
  version: FileVersion
  /** Object storage の direct upload 情報です。 */
  upload: PresignedPutUpload
}

/** Preview/download 用の短命 URL です。 */
export type FileVersionAccess = {
  /** 署名付き object URL です。 */
  url: string
  /** URL 有効期限の ISO 8601 timestamp です。 */
  expiresAt: string
}

/** File/approval 一覧と scope capability です。 */
export type FileProofingCollection = {
  /** Scope に添付された file 一覧です。 */
  files: FileAttachment[]
  /** Scope に作成された approval request 一覧です。 */
  approvals: ApprovalRequest[]
  /** Scope 全体の現在 actor capability です。 */
  capabilities: {
    /** 新規 file を upload できるかどうかです。 */
    canUpload: boolean
    /** Approval request を作成できるかどうかです。 */
    canRequestApproval: boolean
    /** 新規 file を Workspace guest と共有できるかどうかです。 */
    canGrantGuestAccess: boolean
  }
}

/** Annotation 作成入力です。 */
export type CreateFileAnnotationInput = {
  /** Preview 内の位置です。 */
  anchor: AnnotationAnchor
  /** Markdown review comment です。 */
  bodyMarkdown: string
}

/** Approval request 作成入力です。 */
export type CreateFileApprovalInput = {
  /** Approval 対象 file ID です。 */
  fileId: string
  /** Approval 対象 version ID です。 */
  versionId: string
  /** Reviewer の Workspace member key 一覧です。 */
  reviewerMemberKeys: string[]
  /** 判断期限の ISO 8601 timestamp です。 */
  dueAt: string
  /** 全員承認後に workflow consumer へ通知する遷移先です。 */
  completionTransition?: WorkItemStatus
}

/** Reviewer decision の入力です。 */
export type CreateFileApprovalDecisionInput = {
  /** Reviewer の判断です。 */
  decision: 'approve' | 'reject' | 'request-changes'
  /** 判断理由として保存する comment です。 */
  comment?: string
  /** Optimistic concurrency に使う approval revision です。 */
  expectedRevision: number
  /** Decision 直前に強整合 read した Work Item revision です。 */
  workItemRevision?: number
}

/** Approval request cancel の入力です。 */
export type CancelFileApprovalInput = {
  /** Optimistic concurrency に使う approval revision です。 */
  expectedRevision: number
}

/** Object storage に保存した version の内部参照です。 */
type StoredFileVersion = FileVersion & {
  /** Object storage key です。 */
  objectKey: string
  /** Versioned object storage が返した immutable version ID です。 */
  objectVersionId?: string
  /** Version 作成 request の idempotency fingerprint です。 */
  requestFingerprint?: string
}

/** DynamoDB に保存する file metadata row です。 */
type StoredFileItem = {
  /** DynamoDB partition key です。 */
  scopeKey: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'file'
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Team ID です。 */
  teamId: string
  /** Work Item ID です。 */
  issueId?: string
  /** Project ID です。 */
  projectId?: string
  /** File ID です。 */
  fileId: string
  /** File 作成 request の idempotency fingerprint です。 */
  creationRequestFingerprint?: string
  /** File metadata mutation の optimistic revision です。 */
  revision: number
  /** 現在判断待ちの approval request 数です。 */
  pendingApprovalCount: number
  /** 表示名です。 */
  name: string
  /** Attachment target 種別です。 */
  targetType: FileAttachmentTargetType
  /** Attachment target ID です。 */
  targetId: string
  /** Version 一覧です。 */
  versions: StoredFileVersion[]
  /** Current version ID です。 */
  currentVersionId: string
  /** File 作成者です。 */
  createdByMemberKey: string
  /** Guest read を許可するかどうかです。 */
  guestAccess: boolean
  /** 作成日時です。 */
  createdAt: string
  /** 更新日時です。 */
  updatedAt: string
  /** Soft delete timestamp です。 */
  deletedAt?: string
  /** Retention 終了 timestamp です。 */
  retentionUntil?: string
  /** DynamoDB TTL epoch seconds です。 */
  expiresAt?: number
}

/** DynamoDB に保存する annotation row です。 */
type StoredAnnotationItem = FileAnnotation & {
  /** DynamoDB partition key です。 */
  scopeKey: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'annotation'
  /** Annotation 作成 request の idempotency fingerprint です。 */
  requestFingerprint?: string
}

/** DynamoDB に保存する approval row です。 */
type StoredApprovalItem = ApprovalRequest & {
  /** DynamoDB partition key です。 */
  scopeKey: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'approval'
  /** Approval が属する Workspace ID です。 */
  workspaceId: string
  /** Approval が属する Team ID です。 */
  teamId: string
  /** Approval が属する Work Item ID です。 */
  issueId: string
  /** Approval が属する assigned Project ID です。 */
  projectId?: string
  /** 全員承認後に consumer が行う workflow transition です。 */
  completionTransition?: WorkItemStatus
  /** Approval 作成 request の idempotency fingerprint です。 */
  requestFingerprint?: string
}

/** File ID から approval metadata を直接列挙する逆引き projection row です。 */
type StoredFileApprovalIndexItem = {
  /** DynamoDB partition key です。 */
  scopeKey: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'file-approval-index'
  /** 対象 file ID です。 */
  fileId: string
  /** Main approval row の ID です。 */
  approvalId: string
  /** Reviewer projection の sort key に使う期限です。 */
  dueAt: string
  /** Reviewer projection の partition keys に使う member keys です。 */
  reviewerMemberKeys: string[]
  /** Soft delete retention 終了 timestamp です。 */
  retentionUntil?: string
  /** DynamoDB TTL epoch seconds です。 */
  expiresAt?: number
}

/** Reviewer 別 Inbox query 用の approval projection row です。 */
type StoredReviewerApprovalItem = {
  /** DynamoDB partition key です。 */
  scopeKey: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'reviewer-approval'
  /** Main approval row の ID です。 */
  approvalId: string
  /** Reviewer Inbox の sort に使う期限です。 */
  dueAt: string
  /** Projection 所有 reviewer です。 */
  reviewerMemberKey: string
  /** Reviewer 自身の判断状態です。 */
  reviewerStatus: ApprovalReviewerStatus
  /** Approval 全体の状態です。 */
  approvalStatus: ApprovalRequestStatus
  /** 元の Work Item scope key です。 */
  sourceScopeKey: string
  /** Projection の TTL です。 */
  expiresAt?: number
}

/** Work Item 一覧向け approval 集計 projection row です。 */
type StoredApprovalSummaryItem = {
  /** DynamoDB partition key です。 */
  scopeKey: string
  /** DynamoDB sort key です。 */
  recordKey: 'APPROVAL_SUMMARY'
  /** Row discriminator です。 */
  entryType: 'approval-summary'
  /** Pending approval 数です。 */
  pendingCount: number
  /** Approved approval 数です。 */
  approvedCount: number
  /** Rejected approval 数です。 */
  rejectedCount: number
  /** Changes requested approval 数です。 */
  changesRequestedCount: number
  /** Pending approval の dueAt set です。 */
  pendingDueAt?: Set<string>
  /** 最終集計日時です。 */
  updatedAt: string
}

/** Approval summary projection の増減値です。 */
type ApprovalSummaryDelta = {
  /** 増減対象 approval ID です。 */
  approvalId: string
  /** Pending count の増減です。 */
  pending: 1 | -1
  /** Approved count の増分です。 */
  approved?: 1
  /** Rejected count の増分です。 */
  rejected?: 1
  /** Changes requested count の増分です。 */
  changesRequested?: 1
  /** 増減対象 approval の期限です。 */
  dueAt: string
}

/** Reviewer Inbox の bounded page です。 */
export type ReviewerApprovalPage = {
  /** 現在 page の未判断 approval です。 */
  approvals: ApprovalRequest[]
  /** 次 page がある場合の scope-bound opaque cursor です。 */
  nextCursor?: string
}

/** Reviewer Inbox page query です。 */
export type ListReviewerApprovalsOptions = {
  /** 1 page の最大件数です。 */
  limit?: number
  /** 前 page が返した opaque cursor です。 */
  cursor?: string
}

/** Download URL 発行履歴 row です。 */
type StoredDownloadItem = {
  /** DynamoDB partition key です。 */
  scopeKey: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'download'
  /** File ID です。 */
  fileId: string
  /** Version ID です。 */
  versionId: string
  /** URL を発行した member key です。 */
  memberKey: string
  /** URL を発行した日時です。 */
  createdAt: string
  /** DynamoDB TTL です。 */
  expiresAt: number
  /** Access request の idempotency fingerprint です。 */
  requestFingerprint?: string
}

/** Object storage adapter が返す verified object metadata です。 */
export type VerifiedFileObject = {
  /** Object の byte 数です。 */
  sizeBytes: number
  /** Object の MIME type です。 */
  contentType: string
  /** GuardDuty scan 状態です。 */
  scanStatus: FileScanStatus
  /** Versioned object storage が返した immutable version ID です。 */
  objectVersionId: string
}

/** File body を扱う object storage adapter です。 */
export interface FileObjectClient {
  /** Direct PUT 用の短命 URL を作成します。 */
  createUpload(input: {
    /** Object key です。 */
    objectKey: string
    /** MIME type です。 */
    contentType: string
    /** Byte 数です。 */
    sizeBytes: number
  }): Promise<PresignedPutUpload>
  /** Upload 済み object の metadata と scan tag を検証します。 */
  verifyUpload(
    objectKey: string,
    expected: { contentType: string; sizeBytes: number },
  ): Promise<VerifiedFileObject>
  /** Object の最新 scan status を取得します。 */
  getScanStatus(objectKey: string, objectVersionId?: string): Promise<FileScanStatus>
  /** GuardDuty clean tag を保持したまま abandoned-upload lifecycle 対象から外します。 */
  markCompleted(objectKey: string, objectVersionId?: string): Promise<void>
  /** Clean object の preview/download URL を発行します。 */
  createAccess(input: {
    /** Object key です。 */
    objectKey: string
    /** Immutable object version ID です。 */
    objectVersionId?: string
    /** Download 時の file 名です。 */
    fileName: string
    /** Inline または attachment です。 */
    disposition: 'inline' | 'attachment'
  }): Promise<FileVersionAccess>
  /** Immutable object version を deleted quarantine tag で即時無効化します。 */
  quarantineDeletedVersion(objectKey: string, objectVersionId: string): Promise<void>
  /** Versioned object へ delete marker を作成して retention lifecycle を開始します。 */
  softDelete(objectKey: string): Promise<void>
}

/** File metadata、annotation、approval を保存する公開 contract です。 */
export interface FileProofingClient {
  /** Scope の file と approval を取得します。 */
  list(scope: FileProofingScope, actor: FileProofingActor): Promise<FileProofingCollection>
  /** 新規 file upload session を作成します。 */
  createUpload(
    scope: FileProofingScope,
    actor: FileProofingActor,
    input: CreateFileUploadInput,
    auditContext?: MutationAuditContext,
  ): Promise<FileUploadSession>
  /** 既存 file の新 version upload session を作成します。 */
  createVersionUpload(
    scope: FileProofingScope,
    actor: FileProofingActor,
    fileId: string,
    input: CreateFileUploadInput,
    auditContext?: MutationAuditContext,
  ): Promise<FileUploadSession>
  /** Object upload 完了後に size/type/scan status を検証します。 */
  completeUpload(
    scope: FileProofingScope,
    actor: FileProofingActor,
    fileId: string,
    versionId: string,
    auditContext?: MutationAuditContext,
  ): Promise<{ file: FileAttachment; version: FileVersion }>
  /** Clean version の download/preview URL を発行し履歴を残します。 */
  createAccess(
    scope: FileProofingScope,
    actor: FileProofingActor,
    fileId: string,
    versionId: string,
    disposition: 'inline' | 'attachment',
    auditContext?: MutationAuditContext,
  ): Promise<FileVersionAccess>
  /** Version の annotation 一覧を取得します。 */
  listAnnotations(
    scope: FileProofingScope,
    actor: FileProofingActor,
    fileId: string,
    versionId: string,
  ): Promise<FileAnnotation[]>
  /** Version に位置 annotation を作成します。 */
  createAnnotation(
    scope: FileProofingScope,
    actor: FileProofingActor,
    fileId: string,
    versionId: string,
    input: CreateFileAnnotationInput,
    auditContext?: MutationAuditContext,
  ): Promise<FileAnnotation>
  /** File を retention 付きで soft delete します。 */
  deleteFile(
    scope: FileProofingScope,
    actor: FileProofingActor,
    fileId: string,
    auditContext?: MutationAuditContext,
  ): Promise<void>
  /** File version に approval request を作成します。 */
  createApproval(
    scope: FileProofingScope,
    actor: FileProofingActor,
    input: CreateFileApprovalInput,
    auditContext?: MutationAuditContext,
  ): Promise<ApprovalRequest>
  /** Reviewer decision を revision 条件付きで保存します。 */
  decideApproval(
    scope: FileProofingScope,
    actor: FileProofingActor,
    approvalId: string,
    input: CreateFileApprovalDecisionInput,
    auditContext?: MutationAuditContext,
  ): Promise<ApprovalRequest>
  /** Requester または manager が pending approval を取り消します。 */
  cancelApproval(
    scope: FileProofingScope,
    actor: FileProofingActor,
    approvalId: string,
    input: CancelFileApprovalInput,
    auditContext?: MutationAuditContext,
  ): Promise<ApprovalRequest>
  /** Work Item の approval summary を返します。 */
  getApprovalSummary(scope: FileProofingScope): Promise<ApprovalSummary>
  /** 複数 Work Item の approval summary projection を batch read します。 */
  getApprovalSummaries(
    scopes: readonly FileProofingScope[],
  ): Promise<ReadonlyMap<string, ApprovalSummary>>
  /** Reviewer の未完了 approval を Workspace 横断で返します。 */
  listReviewerApprovals(
    workspaceId: string,
    actor: FileProofingActor,
    options?: ListReviewerApprovalsOptions,
  ): Promise<ReviewerApprovalPage>
}

/** S3 の署名付き URL と GuardDuty tag を扱う adapter です。 */
export class S3FileObjectClient implements FileObjectClient {
  /** AWS SDK S3 client です。 */
  private readonly client: S3Client

  /** File bucket 名です。 */
  private readonly bucketName: string

  /** Upload URL の有効秒数です。 */
  private readonly uploadTtlSeconds: number

  /** Download URL の有効秒数です。 */
  private readonly downloadTtlSeconds: number

  /** S3 adapter を作成します。 */
  constructor(
    client: S3Client,
    bucketName: string,
    uploadTtlSeconds = 600,
    downloadTtlSeconds = 300,
  ) {
    this.client = client
    this.bucketName = requireText(bucketName, 'File bucket name')
    this.uploadTtlSeconds = requirePositiveInteger(uploadTtlSeconds, 'Upload URL TTL')
    this.downloadTtlSeconds = requirePositiveInteger(downloadTtlSeconds, 'Download URL TTL')
  }

  /** Direct PUT 用の短命 URL を作成します。 */
  async createUpload(input: {
    /** Object key です。 */
    objectKey: string
    /** MIME type です。 */
    contentType: string
    /** Byte 数です。 */
    sizeBytes: number
  }): Promise<PresignedPutUpload> {
    const tagging = 'mukuroji-upload=pending'
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: input.objectKey,
      ContentLength: input.sizeBytes,
      ContentType: input.contentType,
      IfNoneMatch: '*',
      ServerSideEncryption: 'AES256',
      Tagging: tagging,
    })
    const url = await getSignedUrl(this.client, command, {
      expiresIn: this.uploadTtlSeconds,
      signableHeaders: new Set(['content-type']),
      unhoistableHeaders: new Set(['x-amz-tagging']),
    })

    return {
      url,
      method: 'PUT',
      headers: {
        'content-type': input.contentType,
        'if-none-match': '*',
        'x-amz-server-side-encryption': 'AES256',
        'x-amz-tagging': tagging,
      },
      expiresAt: new Date(Date.now() + this.uploadTtlSeconds * 1_000).toISOString(),
      maxSizeBytes: FILE_UPLOAD_MAX_SIZE_BYTES,
    }
  }

  /** Upload 済み object の metadata と scan tag を検証します。 */
  async verifyUpload(
    objectKey: string,
    expected: { contentType: string; sizeBytes: number },
  ): Promise<VerifiedFileObject> {
    const metadata = await this.client.send(new GetObjectAttributesCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ObjectAttributes: ['ObjectSize'],
    }))

    if (!Number.isSafeInteger(metadata.ObjectSize) || (metadata.ObjectSize ?? 0) <= 0) {
      throw new FileProofingError(422, 'FileUploadIncomplete', 'Uploaded file is empty or unavailable.')
    }
    if (!metadata.VersionId) {
      throw new FileProofingError(
        503,
        'FileObjectVersionUnavailable',
        'Uploaded file storage did not return an immutable object version.',
      )
    }

    return {
      sizeBytes: metadata.ObjectSize!,
      contentType: expected.contentType,
      scanStatus: await this.getScanStatus(objectKey, metadata.VersionId),
      objectVersionId: metadata.VersionId,
    }
  }

  /** GuardDuty object tag を canonical scan status へ変換します。 */
  async getScanStatus(objectKey: string, objectVersionId?: string): Promise<FileScanStatus> {
    const response = await this.client.send(new GetObjectTaggingCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ...(objectVersionId ? { VersionId: objectVersionId } : {}),
    }))

    return mapGuardDutyScanStatus(response.TagSet)
  }

  /** Scan 済み object を abandoned-upload lifecycle 対象から外します。 */
  async markCompleted(objectKey: string, objectVersionId?: string): Promise<void> {
    const response = await this.client.send(new GetObjectTaggingCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ...(objectVersionId ? { VersionId: objectVersionId } : {}),
    }))
    requireAvailableScanStatus(mapGuardDutyScanStatus(response.TagSet))
    const tagSet = (response.TagSet ?? [])
      .filter((tag): tag is Required<Pick<Tag, 'Key' | 'Value'>> =>
        typeof tag.Key === 'string' && typeof tag.Value === 'string' && tag.Key !== 'mukuroji-upload'
      )
    tagSet.push({ Key: 'mukuroji-upload', Value: 'completed' })
    await this.client.send(new PutObjectTaggingCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ...(objectVersionId ? { VersionId: objectVersionId } : {}),
      Tagging: { TagSet: tagSet },
    }))
  }

  /** Clean object の preview/download URL を発行します。 */
  async createAccess(input: {
    /** Object key です。 */
    objectKey: string
    /** Immutable object version ID です。 */
    objectVersionId?: string
    /** Download 時の file 名です。 */
    fileName: string
    /** Inline または attachment です。 */
    disposition: 'inline' | 'attachment'
  }): Promise<FileVersionAccess> {
    const status = await this.getScanStatus(input.objectKey, input.objectVersionId)
    requireAvailableScanStatus(status)
    const disposition = `${input.disposition}; filename*=UTF-8''${encodeURIComponent(input.fileName)}`
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: input.objectKey,
      ...(input.objectVersionId ? { VersionId: input.objectVersionId } : {}),
      ResponseContentDisposition: disposition,
    })

    return {
      url: await getSignedUrl(this.client, command, { expiresIn: this.downloadTtlSeconds }),
      expiresAt: new Date(Date.now() + this.downloadTtlSeconds * 1_000).toISOString(),
    }
  }

  /** Immutable object version を deleted quarantine tag で即時無効化します。 */
  async quarantineDeletedVersion(objectKey: string, objectVersionId: string): Promise<void> {
    try {
      const response = await this.client.send(new GetObjectTaggingCommand({
        Bucket: this.bucketName,
        Key: objectKey,
        VersionId: objectVersionId,
      }))
      if (response.TagSet?.some((tag) => tag.Key === 'mukuroji-deleted' && tag.Value === 'true')) {
        return
      }
      const tagSet = (response.TagSet ?? [])
        .filter((tag): tag is Required<Pick<Tag, 'Key' | 'Value'>> =>
          typeof tag.Key === 'string' && typeof tag.Value === 'string' && tag.Key !== 'mukuroji-deleted'
        )
      tagSet.push({ Key: 'mukuroji-deleted', Value: 'true' })
      await this.client.send(new PutObjectTaggingCommand({
        Bucket: this.bucketName,
        Key: objectKey,
        VersionId: objectVersionId,
        Tagging: { TagSet: tagSet },
      }))
    } catch (error) {
      if (!isMissingFileObjectVersionError(error)) {
        throw error
      }
    }
  }

  /** Versioned object へ delete marker を作成して retention lifecycle を開始します。 */
  async softDelete(objectKey: string) {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
    }))
  }
}

/** DynamoDB と object storage を組み合わせた file proofing client です。 */
export class DynamoDbFileProofingClient implements FileProofingClient {
  /** File metadata table を操作する DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient

  /** File metadata table 名です。 */
  private readonly tableName: string

  /** File body を扱う object storage client です。 */
  private readonly objectClient: FileObjectClient

  /** Immutable audit event table 名です。 */
  private readonly auditTableName?: string

  /** Approval 完了時に transition する canonical Work Item table 名です。 */
  private readonly workItemsTableName?: string

  /** Soft delete 後の保持日数です。 */
  private readonly retentionDays: number

  /** Local table bootstrap 用の low-level client です。 */
  private readonly dynamoDbClient?: DynamoDBClient

  /** Local table を必要時に作成するかどうかです。 */
  private readonly bootstrapLocalTable: boolean

  /** 同時 bootstrap を一つにまとめる promise です。 */
  private tableReady?: Promise<void>

  /** DynamoDB file proofing client を作成します。 */
  constructor(
    documentClient: DynamoDBDocumentClient,
    tableName: string,
    objectClient: FileObjectClient,
    options: {
      /** Immutable audit event table 名です。 */
      auditTableName?: string
      /** Soft delete 後の保持日数です。 */
      retentionDays?: number
      /** Canonical Work Item table 名です。 */
      workItemsTableName?: string
      /** Local bootstrap 用の DynamoDB client です。 */
      dynamoDbClient?: DynamoDBClient
      /** Local table を自動作成するかどうかです。 */
      bootstrapLocalTable?: boolean
    } = {},
  ) {
    this.documentClient = documentClient
    this.tableName = requireText(tableName, 'File proofing table name')
    this.objectClient = objectClient
    this.auditTableName = options.auditTableName?.trim() || undefined
    this.workItemsTableName = options.workItemsTableName?.trim() || undefined
    this.retentionDays = requirePositiveInteger(options.retentionDays ?? 30, 'File retention days')
    this.dynamoDbClient = options.dynamoDbClient
    this.bootstrapLocalTable = options.bootstrapLocalTable === true
  }

  /** Scope の file と approval を取得します。 */
  async list(scope: FileProofingScope, actor: FileProofingActor): Promise<FileProofingCollection> {
    await this.ensureReady()
    const scopeKey = createFileProofingScopeKey(scope)
    const [fileItems, approvalItems] = await Promise.all([
      this.queryScope(scopeKey, 'FILE#'),
      this.queryScope(scopeKey, 'APPROVAL#'),
    ])
    const storedFiles = fileItems.filter(isStoredFileItem)
    const refreshedFiles = await Promise.all(storedFiles.map((file) => this.refreshScanStatuses(file)))
    const files = refreshedFiles
      .filter((file) => !file.deletedAt)
      .filter((file) => !actor.guest || file.guestAccess)
      .map((file) => toFileAttachment(file, actor))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    const visibleFileIds = new Set(files.map((file) => file.id))
    const approvals = approvalItems.filter(isStoredApprovalItem)
      .filter((approval) => visibleFileIds.has(approval.fileId))
      .map((approval) => toApprovalRequest(approval, actor))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

    return {
      files,
      approvals,
      capabilities: {
        canUpload: actor.canWrite,
        canRequestApproval: scope.kind === 'work-item' && actor.canWrite,
        canGrantGuestAccess: actor.canManage,
      },
    }
  }

  /** 新規 file upload session を作成します。 */
  async createUpload(
    scope: FileProofingScope,
    actor: FileProofingActor,
    input: CreateFileUploadInput,
    auditContext?: MutationAuditContext,
  ): Promise<FileUploadSession> {
    requireFileWrite(actor)
    await this.ensureReady()
    const normalized = normalizeUploadInput(input)
    const now = auditContext?.occurredAt ?? new Date().toISOString()
    const scopeKey = createFileProofingScopeKey(scope)
    const fileId = createMutationResourceId('file', auditContext, scopeKey)
    const versionId = createMutationResourceId('version', auditContext, scopeKey)
    const target = resolveAttachmentTarget(scope)
    const objectKey = createFileObjectKey(scope.workspaceId, fileId, versionId, normalized.fileName)
    const version = createStoredVersion(
      versionId,
      1,
      normalized,
      actor.memberKey,
      now,
      objectKey,
      auditContext?.requestFingerprint,
    )
    const item: StoredFileItem = {
      scopeKey,
      recordKey: createFileRecordKey(fileId),
      entryType: 'file',
      workspaceId: scope.workspaceId,
      teamId: scope.teamId,
      ...(scope.issueId ? { issueId: scope.issueId } : {}),
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
      fileId,
      ...(auditContext ? { creationRequestFingerprint: auditContext.requestFingerprint } : {}),
      revision: 1,
      pendingApprovalCount: 0,
      name: normalized.fileName,
      targetType: target.type,
      targetId: target.id,
      versions: [version],
      currentVersionId: versionId,
      createdByMemberKey: actor.memberKey,
      guestAccess: input.guestAccess === true && actor.canManage,
      createdAt: now,
      updatedAt: now,
    }
    const existing = await this.getFile(scopeKey, fileId, false)
    if (existing) {
      requireFileNotDeleted(existing)
      requireMatchingIdempotencyFingerprint(existing.creationRequestFingerprint, auditContext)
    }
    const stored = existing ?? await this.putNewFile(item, auditContext)
    const storedVersion = requireStoredVersion(stored, versionId)

    return {
      file: toFileAttachment(stored, actor),
      version: toFileVersion(storedVersion),
      upload: await this.objectClient.createUpload({
        objectKey: storedVersion.objectKey,
        contentType: storedVersion.contentType,
        sizeBytes: storedVersion.sizeBytes,
      }),
    }
  }

  /** 既存 file の新 version upload session を作成します。 */
  async createVersionUpload(
    scope: FileProofingScope,
    actor: FileProofingActor,
    fileId: string,
    input: CreateFileUploadInput,
    auditContext?: MutationAuditContext,
  ): Promise<FileUploadSession> {
    requireFileWrite(actor)
    await this.ensureReady()
    const scopeKey = createFileProofingScopeKey(scope)
    const current = await this.getFile(scopeKey, fileId)
    requireFileNotDeleted(current)
    if (current.pendingApprovalCount > 0) {
      throw new FileProofingError(
        409,
        'FileApprovalPending',
        'A new version cannot replace a file while approval is pending.',
      )
    }
    const normalized = normalizeUploadInput(input)
    const now = auditContext?.occurredAt ?? new Date().toISOString()
    const versionId = createMutationResourceId(
      'version',
      auditContext,
      `${scopeKey}#FILE#${fileId}`,
    )
    const existingVersion = current.versions.find((version) => version.id === versionId)

    if (existingVersion) {
      requireMatchingIdempotencyFingerprint(existingVersion.requestFingerprint, auditContext)
      return {
        file: toFileAttachment(current, actor),
        version: toFileVersion(existingVersion),
        upload: await this.objectClient.createUpload({
          objectKey: existingVersion.objectKey,
          contentType: existingVersion.contentType,
          sizeBytes: existingVersion.sizeBytes,
        }),
      }
    }

    const version = createStoredVersion(
      versionId,
      current.versions.length + 1,
      normalized,
      actor.memberKey,
      now,
      createFileObjectKey(scope.workspaceId, current.fileId, versionId, normalized.fileName),
      auditContext?.requestFingerprint,
    )
    const next: StoredFileItem = {
      ...current,
      revision: current.revision + 1,
      versions: [...current.versions, version],
      updatedAt: now,
    }
    await this.putFileWithAudit(next, current.revision, auditContext, {
      eventType: 'file.version-created',
      action: 'version-created',
      metadata: createFileAuditMetadata(scope, actor, current.fileId, versionId),
    })

    return {
      file: toFileAttachment(next, actor),
      version: toFileVersion(version),
      upload: await this.objectClient.createUpload({
        objectKey: version.objectKey,
        contentType: version.contentType,
        sizeBytes: version.sizeBytes,
      }),
    }
  }

  /** Object upload 完了後に size/type/scan status を検証します。 */
  async completeUpload(
    scope: FileProofingScope,
    actor: FileProofingActor,
    fileId: string,
    versionId: string,
    auditContext?: MutationAuditContext,
  ): Promise<{ file: FileAttachment; version: FileVersion }> {
    requireFileWrite(actor)
    await this.ensureReady()
    const current = await this.getFile(createFileProofingScopeKey(scope), fileId)
    requireFileNotDeleted(current)
    const version = requireStoredVersion(current, versionId)
    if (version.objectVersionId && version.verifiedAt) {
      return { file: toFileAttachment(current, actor), version: toFileVersion(version) }
    }
    const promotesReplacement = current.currentVersionId !== versionId
    if (promotesReplacement && current.pendingApprovalCount !== 0) {
      throw new FileProofingError(
        409,
        'FileApprovalPending',
        'A new version cannot replace a file while approval is pending.',
      )
    }
    const verified = await this.objectClient.verifyUpload(version.objectKey, {
      contentType: version.contentType,
      sizeBytes: version.sizeBytes,
    })

    if (verified.sizeBytes !== version.sizeBytes || verified.contentType !== version.contentType) {
      throw new FileProofingError(
        422,
        'FileUploadMismatch',
        'Uploaded file size or media type does not match the signed upload session.',
      )
    }

    const stagedVersion: StoredFileVersion = {
      ...version,
      objectVersionId: verified.objectVersionId,
      scanStatus: verified.scanStatus === 'available' || verified.scanStatus === 'pending'
        ? 'scanning'
        : verified.scanStatus,
      verifiedAt: auditContext?.occurredAt ?? new Date().toISOString(),
    }
    const staged = {
      ...replaceStoredVersion(current, stagedVersion),
      currentVersionId: versionId,
    }
    await this.putFileWithAudit(staged, current.revision, auditContext, {
      eventType: 'file.upload-completed',
      action: 'upload-completed',
      metadata: createFileAuditMetadata(scope, actor, fileId, versionId),
    }, promotesReplacement ? 0 : undefined)
    if (verified.scanStatus !== 'available') {
      return { file: toFileAttachment(staged, actor), version: toFileVersion(stagedVersion) }
    }

    await this.objectClient.markCompleted(version.objectKey, verified.objectVersionId)
    const available = await this.persistVerifiedScanStatus(staged, versionId, 'available')
    const availableVersion = requireStoredVersion(available, versionId)

    return {
      file: toFileAttachment(available, actor),
      version: toFileVersion(availableVersion),
    }
  }

  /** Clean version の download/preview URL を発行し履歴を残します。 */
  async createAccess(
    scope: FileProofingScope,
    actor: FileProofingActor,
    fileId: string,
    versionId: string,
    disposition: 'inline' | 'attachment',
    auditContext?: MutationAuditContext,
  ): Promise<FileVersionAccess> {
    await this.ensureReady()
    const scopeKey = createFileProofingScopeKey(scope)
    const file = await this.getFile(scopeKey, fileId)
    requireFileNotDeleted(file)
    requireFileRead(file, actor)
    const version = requireStoredVersion(file, versionId)
    const objectVersionId = requireStoredObjectVersionId(version)
    requireAvailableScanStatus(version.scanStatus)
    const scanStatus = await this.objectClient.getScanStatus(
      version.objectKey,
      objectVersionId,
    )
    requireAvailableScanStatus(scanStatus)
    const now = auditContext?.occurredAt ?? new Date().toISOString()
    const historyId = createMutationResourceId(
      'download',
      auditContext,
      `${scopeKey}#FILE#${fileId}#VERSION#${versionId}#${disposition}`,
    )
    const expiresAt = epochSecondsAfterDays(now, this.retentionDays)
    const history: StoredDownloadItem = {
      scopeKey,
      recordKey: `DOWNLOAD#${historyId}`,
      entryType: 'download',
      fileId,
      versionId,
      memberKey: actor.memberKey,
      createdAt: now,
      expiresAt,
      ...(auditContext ? { requestFingerprint: auditContext.requestFingerprint } : {}),
    }
    const transactionItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      createFileRevisionConditionCheck(this.tableName, file),
      {
        Put: {
          TableName: this.tableName,
          Item: history,
          ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
        },
      },
    ]
    addAuditItem(transactionItems, this.auditTableName, auditContext, {
      directoryId: scope.workspaceId,
      eventType: disposition === 'attachment' ? 'file.download-accessed' : 'file.preview-accessed',
      ...resolveFileAuditEntity(scope),
      target: { type: 'file', id: fileId },
      action: disposition === 'attachment' ? 'download-accessed' : 'preview-accessed',
      metadata: {
        ...createFileAuditMetadata(scope, actor, fileId, versionId),
        disposition,
      },
    })

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactionItems }))
    } catch (error) {
      if (!isConditionalTransactionError(error)) {
        throw error
      }
      const existing = await this.getItem<StoredDownloadItem>(scopeKey, history.recordKey)
      if (existing) {
        requireMatchingIdempotencyFingerprint(existing.requestFingerprint, auditContext)
      } else {
        throw new FileProofingError(
          409,
          auditContext ? 'IdempotencyKeyReused' : 'FileVersionConflict',
          'File access state changed. Reload and try again.',
          { cause: error },
        )
      }
    }

    return this.objectClient.createAccess({
      objectKey: version.objectKey,
      objectVersionId,
      fileName: version.fileName,
      disposition,
    })
  }

  /** Version の annotation 一覧を取得します。 */
  async listAnnotations(
    scope: FileProofingScope,
    actor: FileProofingActor,
    fileId: string,
    versionId: string,
  ): Promise<FileAnnotation[]> {
    await this.ensureReady()
    const scopeKey = createFileProofingScopeKey(scope)
    const file = await this.getFile(scopeKey, fileId)
    requireFileNotDeleted(file)
    requireFileRead(file, actor)
    requireStoredVersion(file, versionId)
    const items = await this.queryScope(scopeKey, createAnnotationRecordPrefix(fileId, versionId))

    return items.filter(isStoredAnnotationItem)
      .map((item) => toFileAnnotation(item, actor))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  /** Version に位置 annotation を作成します。 */
  async createAnnotation(
    scope: FileProofingScope,
    actor: FileProofingActor,
    fileId: string,
    versionId: string,
    input: CreateFileAnnotationInput,
    auditContext?: MutationAuditContext,
  ): Promise<FileAnnotation> {
    requireFileWrite(actor)
    await this.ensureReady()
    const scopeKey = createFileProofingScopeKey(scope)
    const file = await this.getFile(scopeKey, fileId)
    requireFileNotDeleted(file)
    const version = requireStoredVersion(file, versionId)
    const objectVersionId = requireStoredObjectVersionId(version)
    requireAvailableScanStatus(version.scanStatus)
    const scanStatus = await this.objectClient.getScanStatus(
      version.objectKey,
      objectVersionId,
    )
    requireAvailableScanStatus(scanStatus)
    if (version.previewKind === 'none') {
      throw new FileProofingError(415, 'FilePreviewUnsupported', 'This media type cannot be annotated.')
    }
    const anchor = normalizeAnnotationAnchor(input.anchor, version.previewKind)
    const bodyMarkdown = requireLimitedText(input.bodyMarkdown, 'Annotation body', 10_000)
    const now = auditContext?.occurredAt ?? new Date().toISOString()
    const annotationId = createMutationResourceId(
      'annotation',
      auditContext,
      `${scopeKey}#FILE#${fileId}#VERSION#${versionId}`,
    )
    const item: StoredAnnotationItem = {
      scopeKey,
      recordKey: `${createAnnotationRecordPrefix(fileId, versionId)}${annotationId}`,
      entryType: 'annotation',
      id: annotationId,
      fileId,
      versionId,
      anchor,
      bodyMarkdown,
      authorMemberKey: actor.memberKey,
      createdAt: now,
      capabilities: { canResolve: false },
      ...(auditContext ? { requestFingerprint: auditContext.requestFingerprint } : {}),
    }
    const transactionItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      createFileRevisionConditionCheck(this.tableName, file),
      {
        Put: {
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
        },
      },
    ]
    addAuditItem(transactionItems, this.auditTableName, auditContext, {
      directoryId: scope.workspaceId,
      eventType: 'annotation.created',
      ...resolveFileAuditEntity(scope),
      target: { type: 'comment', id: annotationId },
      action: 'annotation-created',
      metadata: createFileAuditMetadata(scope, actor, fileId, versionId),
    })

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactionItems }))
    } catch (error) {
      if (!isConditionalTransactionError(error)) {
        throw error
      }
      const existing = await this.getItem<StoredAnnotationItem>(scopeKey, item.recordKey)
      if (existing) {
        requireMatchingIdempotencyFingerprint(existing.requestFingerprint, auditContext)
        return toFileAnnotation(existing, actor)
      }
      throw new FileProofingError(
        409,
        auditContext ? 'IdempotencyKeyReused' : 'FileVersionConflict',
        'File annotation state changed. Reload and try again.',
        { cause: error },
      )
    }

    return toFileAnnotation(item, actor)
  }

  /** File を retention 付きで soft delete します。 */
  async deleteFile(
    scope: FileProofingScope,
    actor: FileProofingActor,
    fileId: string,
    auditContext?: MutationAuditContext,
  ): Promise<void> {
    if (actor.guest) {
      throw new FileProofingError(403, 'FileDeleteDenied', 'File manager or uploader access is required.')
    }
    await this.ensureReady()
    const current = await this.getFile(createFileProofingScopeKey(scope), fileId)
    if (!actor.canManage && current.createdByMemberKey !== actor.memberKey) {
      throw new FileProofingError(403, 'FileDeleteDenied', 'File manager or uploader access is required.')
    }
    if (current.deletedAt) {
      await this.quarantineDeletedVersions(current)
      await Promise.all(current.versions.map((version) => this.objectClient.softDelete(version.objectKey)))
      if (current.expiresAt && current.retentionUntil) {
        await this.scheduleRelatedMetadataExpiry(
          current,
          current.expiresAt,
          current.retentionUntil,
        )
      }
      return
    }
    if (current.pendingApprovalCount > 0) {
      throw new FileProofingError(
        409,
        'FileApprovalPending',
        'A file cannot be deleted while approval is pending.',
      )
    }
    const deletedAt = auditContext?.occurredAt ?? new Date().toISOString()
    const retentionUntil = new Date(
      Date.parse(deletedAt) + this.retentionDays * 86_400_000,
    ).toISOString()
    const next: StoredFileItem = {
      ...current,
      revision: current.revision + 1,
      deletedAt,
      retentionUntil,
      expiresAt: Math.floor(Date.parse(retentionUntil) / 1_000),
      updatedAt: deletedAt,
    }
    await this.putFileWithAudit(next, current.revision, auditContext, {
      eventType: 'file.deleted',
      action: 'deleted',
      metadata: createFileAuditMetadata(scope, actor, fileId, current.currentVersionId),
    })
    await this.quarantineDeletedVersions(next)
    await Promise.all(current.versions.map((version) => this.objectClient.softDelete(version.objectKey)))
    await this.scheduleRelatedMetadataExpiry(next, next.expiresAt!, next.retentionUntil!)
  }

  /** File version に approval request を作成します。 */
  async createApproval(
    scope: FileProofingScope,
    actor: FileProofingActor,
    input: CreateFileApprovalInput,
    auditContext?: MutationAuditContext,
  ): Promise<ApprovalRequest> {
    requireFileWrite(actor)
    requireWorkItemScope(scope)
    await this.ensureReady()
    const scopeKey = createFileProofingScopeKey(scope)
    const file = await this.getFile(scopeKey, input.fileId)
    requireFileNotDeleted(file)
    const version = requireStoredVersion(file, input.versionId)
    if (file.currentVersionId !== version.id) {
      throw new FileProofingError(
        409,
        'ApprovalVersionStale',
        'Approval must target the current file version.',
      )
    }
    requireAvailableScanStatus(version.scanStatus)
    if (!Array.isArray(input.reviewerMemberKeys)) {
      throw new FileProofingError(400, 'InvalidApprovalReviewers', 'Approval reviewers are required.')
    }
    const reviewerMemberKeys = [...new Set(input.reviewerMemberKeys.map(normalizeReviewerMemberKey))]
    if (reviewerMemberKeys.length === 0 || reviewerMemberKeys.length > FILE_APPROVAL_MAX_REVIEWERS) {
      throw new FileProofingError(
        400,
        'InvalidApprovalReviewers',
        `Approval requires 1-${FILE_APPROVAL_MAX_REVIEWERS} unique reviewers.`,
      )
    }
    const dueAt = normalizeFutureTimestamp(input.dueAt, 'Approval due date')
    const now = auditContext?.occurredAt ?? new Date().toISOString()
    const approvalId = createMutationResourceId('approval', auditContext, scopeKey)
    const completionTransition = input.completionTransition === undefined
      ? undefined
      : normalizeWorkItemStatus(input.completionTransition)
    const reviewers: ApprovalReviewer[] = reviewerMemberKeys.map((memberKey) => ({
      memberKey,
      status: 'pending',
    }))
    const item: StoredApprovalItem = {
      scopeKey,
      recordKey: createApprovalRecordKey(approvalId),
      entryType: 'approval',
      workspaceId: scope.workspaceId,
      teamId: scope.teamId,
      issueId: scope.issueId!,
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
      id: approvalId,
      revision: 1,
      fileId: file.fileId,
      versionId: version.id,
      status: 'pending',
      reviewers,
      dueAt,
      requestedByMemberKey: actor.memberKey,
      createdAt: now,
      updatedAt: now,
      capabilities: { canCancel: false, canDecide: false },
      ...(completionTransition ? { completionTransition } : {}),
      ...(auditContext ? { requestFingerprint: auditContext.requestFingerprint } : {}),
    }
    const transactionItems = createApprovalProjectionPutItems(this.tableName, item)
    transactionItems.push(createFilePendingApprovalUpdate(
      this.tableName,
      file,
      version.id,
      now,
      'increment',
    ))
    transactionItems.push(createApprovalSummaryUpdate(
      this.tableName,
      scopeKey,
      now,
      { approvalId, dueAt, pending: 1 },
    ))
    addAuditItem(transactionItems, this.auditTableName, auditContext, {
      directoryId: scope.workspaceId,
      eventType: 'approval.requested',
      entityType: 'work-item',
      entityId: createWorkItemAuditEntityId(scope),
      target: { type: 'approval', id: approvalId },
      action: 'requested',
      metadata: {
        ...createFileAuditMetadata(scope, actor, file.fileId, version.id),
        approvalId,
        dueAt,
        completionTransition,
        notificationCandidates: reviewers.map((reviewer) => ({
          memberKey: reviewer.memberKey,
          reason: 'approval-requested',
        })),
      },
    })

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactionItems }))
    } catch (error) {
      if (!isConditionalTransactionError(error)) {
        throw error
      }
      const existing = await this.getApproval(scopeKey, approvalId, false)
      if (existing) {
        requireMatchingIdempotencyFingerprint(existing.requestFingerprint, auditContext)
        return toApprovalRequest(existing, actor)
      }
      throw new FileProofingError(
        409,
        auditContext ? 'IdempotencyKeyReused' : 'ApprovalRevisionConflict',
        'Approval state changed. Reload and try again.',
        { cause: error },
      )
    }

    return toApprovalRequest(item, actor)
  }

  /** Reviewer decision を revision 条件付きで保存します。 */
  async decideApproval(
    scope: FileProofingScope,
    actor: FileProofingActor,
    approvalId: string,
    input: CreateFileApprovalDecisionInput,
    auditContext?: MutationAuditContext,
  ): Promise<ApprovalRequest> {
    requireWorkItemScope(scope)
    const expectedRevision = requireApprovalRevision(input.expectedRevision)
    await this.ensureReady()
    const scopeKey = createFileProofingScopeKey(scope)
    const current = await this.getApproval(scopeKey, approvalId)
    const file = await this.getFile(scopeKey, current.fileId)
    requireFileNotDeleted(file)
    requireFileRead(file, actor)
    if (file.currentVersionId !== current.versionId) {
      throw new FileProofingError(
        409,
        'ApprovalVersionStale',
        'The approved file version is no longer current.',
      )
    }
    if (current.revision !== expectedRevision) {
      throw new FileProofingError(409, 'ApprovalRevisionConflict', 'Approval changed. Reload and try again.')
    }
    if (current.status !== 'pending') {
      throw new FileProofingError(409, 'ApprovalAlreadyCompleted', 'Approval is no longer pending.')
    }
    const reviewerIndex = current.reviewers.findIndex(
      (reviewer) => normalizeMemberKey(reviewer.memberKey) === normalizeMemberKey(actor.memberKey),
    )
    const reviewer = current.reviewers[reviewerIndex]
    if (!reviewer || reviewer.status !== 'pending') {
      throw new FileProofingError(403, 'ApprovalReviewerDenied', 'A pending reviewer decision is required.')
    }
    const now = auditContext?.occurredAt ?? new Date().toISOString()
    const reviewerStatus = mapApprovalDecision(input.decision)
    const comment = input.comment === undefined ||
        (typeof input.comment === 'string' && !input.comment.trim())
      ? undefined
      : requireLimitedText(
          input.comment,
          'Approval comment',
          FILE_APPROVAL_COMMENT_MAX_LENGTH,
        )
    const reviewers = current.reviewers.map((candidate, index) => index === reviewerIndex
      ? {
          ...candidate,
          status: reviewerStatus,
          decidedAt: now,
          ...(comment ? { comment } : {}),
        }
      : candidate)
    const status = aggregateApprovalStatus(reviewers)
    const isCompleted = status !== 'pending'
    const next: StoredApprovalItem = {
      ...current,
      revision: current.revision + 1,
      status,
      reviewers,
      updatedAt: now,
      ...(isCompleted ? { completedAt: now } : {}),
    }
    const transactionItems = createApprovalProjectionPutItems(
      this.tableName,
      next,
      current.revision,
    )
    transactionItems.push(isCompleted
      ? createFilePendingApprovalUpdate(
          this.tableName,
          file,
          current.versionId,
          now,
          'decrement',
        )
      : createFileRevisionConditionCheck(this.tableName, file, current.versionId))
    if (isCompleted) {
      transactionItems.push(createApprovalSummaryUpdate(
        this.tableName,
        scopeKey,
        now,
        {
          approvalId: current.id,
          dueAt: current.dueAt,
          pending: -1,
          ...(status === 'approved' ? { approved: 1 } : {}),
          ...(status === 'rejected' ? { rejected: 1 } : {}),
          ...(status === 'changes-requested' ? { changesRequested: 1 } : {}),
        },
      ))
    }
    if (
      status === 'approved' &&
      current.completionTransition &&
      input.workItemRevision &&
      this.workItemsTableName
    ) {
      transactionItems.push({
        Update: {
          TableName: this.workItemsTableName,
          Key: {
            directoryTeamId: `${scope.workspaceId}#team#${scope.teamId}`,
            issueId: scope.issueId,
          },
          UpdateExpression:
            'SET #status = :status, updatedAt = :updatedAt, ' +
            'revision = if_not_exists(revision, :legacyRevision) + :one',
          ConditionExpression:
            'attribute_exists(issueId) AND (revision = :expectedRevision OR ' +
            '(attribute_not_exists(revision) AND :expectedRevision = :legacyRevision))',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': current.completionTransition,
            ':updatedAt': now,
            ':one': 1,
            ':expectedRevision': requirePositiveInteger(
              input.workItemRevision,
              'Work Item revision',
            ),
            ':legacyRevision': 1,
          },
        },
      })
    }
    addAuditItem(transactionItems, this.auditTableName, auditContext, {
      directoryId: scope.workspaceId,
      eventType: resolveApprovalDecisionEventType(status, reviewerStatus),
      entityType: 'work-item',
      entityId: createWorkItemAuditEntityId(scope),
      target: { type: 'approval', id: approvalId },
      action: status === 'approved' ? 'completed' : 'decision-recorded',
      metadata: {
        ...createFileAuditMetadata(scope, actor, current.fileId, current.versionId),
        approvalId,
        reviewerStatus,
        approvalStatus: status,
        completionTransition: status === 'approved' ? current.completionTransition : undefined,
        automation: status === 'approved' && current.completionTransition
          ? {
              action: 'work-item.transition',
              status: current.completionTransition,
            }
          : undefined,
        notificationCandidates: [{
          memberKey: current.requestedByMemberKey,
          reason: status === 'approved' ? 'approval-completed' : 'approval-decision',
        }],
      },
    })

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactionItems }))
    } catch (error) {
      if (isConditionalTransactionError(error)) {
        throw new FileProofingError(
          409,
          'ApprovalRevisionConflict',
          'Approval changed. Reload and try again.',
          { cause: error },
        )
      }
      throw error
    }

    return toApprovalRequest(next, actor)
  }

  /** Requester または manager が pending approval を revision 条件付きで取り消します。 */
  async cancelApproval(
    scope: FileProofingScope,
    actor: FileProofingActor,
    approvalId: string,
    input: CancelFileApprovalInput,
    auditContext?: MutationAuditContext,
  ): Promise<ApprovalRequest> {
    requireWorkItemScope(scope)
    const expectedRevision = requireApprovalRevision(input.expectedRevision)
    await this.ensureReady()
    const scopeKey = createFileProofingScopeKey(scope)
    const current = await this.getApproval(scopeKey, approvalId)
    const file = await this.getFile(scopeKey, current.fileId)
    requireFileNotDeleted(file)
    requireFileRead(file, actor)
    if (!actor.canManage && normalizeMemberKey(current.requestedByMemberKey) !== normalizeMemberKey(actor.memberKey)) {
      throw new FileProofingError(
        403,
        'ApprovalCancelDenied',
        'Approval requester or manager access is required.',
      )
    }
    if (current.revision !== expectedRevision) {
      throw new FileProofingError(409, 'ApprovalRevisionConflict', 'Approval changed. Reload and try again.')
    }
    if (current.status !== 'pending') {
      throw new FileProofingError(409, 'ApprovalAlreadyCompleted', 'Approval is no longer pending.')
    }
    if (file.currentVersionId !== current.versionId) {
      throw new FileProofingError(
        409,
        'ApprovalVersionStale',
        'The approval file version is no longer current.',
      )
    }
    const now = auditContext?.occurredAt ?? new Date().toISOString()
    const next: StoredApprovalItem = {
      ...current,
      revision: current.revision + 1,
      status: 'cancelled',
      updatedAt: now,
      completedAt: now,
    }
    const transactionItems = createApprovalProjectionPutItems(
      this.tableName,
      next,
      current.revision,
    )
    transactionItems.push(createFilePendingApprovalUpdate(
      this.tableName,
      file,
      current.versionId,
      now,
      'decrement',
    ))
    transactionItems.push(createApprovalSummaryUpdate(
      this.tableName,
      scopeKey,
      now,
      { approvalId: current.id, dueAt: current.dueAt, pending: -1 },
    ))
    addAuditItem(transactionItems, this.auditTableName, auditContext, {
      directoryId: scope.workspaceId,
      eventType: 'approval.cancelled',
      entityType: 'work-item',
      entityId: createWorkItemAuditEntityId(scope),
      target: { type: 'approval', id: approvalId },
      action: 'cancelled',
      metadata: {
        ...createFileAuditMetadata(scope, actor, current.fileId, current.versionId),
        approvalId,
        notificationCandidates: current.reviewers.map((reviewer) => ({
          memberKey: reviewer.memberKey,
          reason: 'approval-cancelled',
        })),
      },
    })

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactionItems }))
    } catch (error) {
      if (isConditionalTransactionError(error)) {
        throw new FileProofingError(
          409,
          'ApprovalRevisionConflict',
          'Approval changed. Reload and try again.',
          { cause: error },
        )
      }
      throw error
    }

    return toApprovalRequest(next, actor)
  }

  /** Work Item の approval summary を返します。 */
  async getApprovalSummary(scope: FileProofingScope): Promise<ApprovalSummary> {
    requireWorkItemScope(scope)
    await this.ensureReady()
    const summary = await this.getItem<StoredApprovalSummaryItem>(
      createFileProofingScopeKey(scope),
      'APPROVAL_SUMMARY',
    )

    return isStoredApprovalSummaryItem(summary)
      ? toApprovalSummary(summary)
      : createEmptyApprovalSummary()
  }

  /** 複数 Work Item の approval summary projection を bounded batch read します。 */
  async getApprovalSummaries(
    scopes: readonly FileProofingScope[],
  ): Promise<ReadonlyMap<string, ApprovalSummary>> {
    await this.ensureReady()
    const scopeKeys = [...new Set(scopes.map((scope) => {
      requireWorkItemScope(scope)
      return createFileProofingScopeKey(scope)
    }))]
    const summaries = new Map<string, ApprovalSummary>(scopeKeys.map((scopeKey) => [
      scopeKey,
      createEmptyApprovalSummary(),
    ]))

    for (let index = 0; index < scopeKeys.length; index += 100) {
      let keys = scopeKeys.slice(index, index + 100).map((scopeKey) => ({
        scopeKey,
        recordKey: 'APPROVAL_SUMMARY',
      }))
      for (let attempt = 0; keys.length > 0 && attempt < 5; attempt += 1) {
        const response = await this.documentClient.send(new BatchGetCommand({
          RequestItems: {
            [this.tableName]: {
              ConsistentRead: true,
              Keys: keys,
            },
          },
        }))
        for (const item of response.Responses?.[this.tableName] ?? []) {
          if (isStoredApprovalSummaryItem(item)) {
            summaries.set(item.scopeKey, toApprovalSummary(item))
          }
        }
        keys = response.UnprocessedKeys?.[this.tableName]?.Keys ?? []
      }
      if (keys.length > 0) {
        throw new FileProofingError(
          503,
          'ApprovalSummaryUnavailable',
          'Approval summaries could not be read completely.',
        )
      }
    }

    return summaries
  }

  /** Reviewer の未完了 approval を Workspace 横断で返します。 */
  async listReviewerApprovals(
    workspaceId: string,
    actor: FileProofingActor,
    options: ListReviewerApprovalsOptions = {},
  ): Promise<ReviewerApprovalPage> {
    await this.ensureReady()
    const scopeKey = createReviewerScopeKey(workspaceId, actor.memberKey)
    const limit = normalizeReviewerApprovalLimit(options.limit)
    const readBudget = limit * 5
    const approvals: ApprovalRequest[] = []
    let evaluated = 0
    let exclusiveStartKey = options.cursor
      ? decodeReviewerApprovalCursor(options.cursor, scopeKey)
      : undefined

    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'scopeKey = :scopeKey',
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
        ExpressionAttributeValues: { ':scopeKey': scopeKey },
        Limit: Math.min(limit - approvals.length, readBudget - evaluated),
        ScanIndexForward: true,
      }))
      const items = (response.Items ?? []).filter(isStoredReviewerApprovalItem)
        .filter((item) => item.approvalStatus === 'pending' &&
          item.reviewerStatus === 'pending' &&
          normalizeMemberKey(item.reviewerMemberKey) === normalizeMemberKey(actor.memberKey))
      const approvalItems = await this.batchGetReviewerApprovalItems(items)
      const visibleItems = await Promise.all(items.map(async (item) => {
        const approval = approvalItems.get(createReviewerApprovalPointerKey(item))
        if (!approval || approval.status !== 'pending' || !approval.reviewers.some((reviewer) =>
          normalizeMemberKey(reviewer.memberKey) === normalizeMemberKey(actor.memberKey) &&
          reviewer.status === 'pending'
        )) {
          return undefined
        }
        const file = await this.getFile(item.sourceScopeKey, approval.fileId, false)
        return file && !file.deletedAt && (!actor.guest || file.guestAccess)
          ? approval
          : undefined
      }))
      approvals.push(...visibleItems
        .filter((item): item is StoredApprovalItem => item !== undefined)
        .map((item) => toApprovalRequest(item, actor)))
      evaluated += response.Count ?? response.Items?.length ?? 0
      exclusiveStartKey = response.LastEvaluatedKey
    } while (approvals.length < limit && exclusiveStartKey && evaluated < readBudget)

    return {
      approvals,
      ...(exclusiveStartKey
        ? { nextCursor: encodeReviewerApprovalCursor(scopeKey, exclusiveStartKey) }
        : {}),
    }
  }

  /** 新規 file row と audit event を同じ transaction で保存します。 */
  private async putNewFile(item: StoredFileItem, auditContext?: MutationAuditContext) {
    const transactionItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [{
      Put: {
        TableName: this.tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
      },
    }]
    addAuditItem(transactionItems, this.auditTableName, auditContext, {
      directoryId: item.workspaceId,
      eventType: 'file.created',
      ...resolveStoredFileAuditEntity(item),
      target: { type: 'file', id: item.fileId },
      action: 'created',
      metadata: {
        actorMemberKey: item.createdByMemberKey,
        teamId: item.teamId,
        issueId: item.issueId,
        projectId: item.projectId,
        fileId: item.fileId,
        versionId: item.currentVersionId,
        targetType: item.targetType,
        targetId: item.targetId,
        deepLink: item.issueId
          ? `/teams/${encodeURIComponent(item.teamId)}/issues/${encodeURIComponent(item.issueId)}`
          : `/teams/${encodeURIComponent(item.teamId)}/projects/${encodeURIComponent(item.projectId ?? '')}/files`,
      },
    })

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactionItems }))
      return item
    } catch (error) {
      if (!isConditionalTransactionError(error)) {
        throw error
      }
      const existing = await this.getFile(item.scopeKey, item.fileId, false)
      if (existing) {
        requireMatchingIdempotencyFingerprint(existing.creationRequestFingerprint, auditContext)
        return existing
      }
      throw new FileProofingError(
        409,
        auditContext ? 'IdempotencyKeyReused' : 'FileVersionConflict',
        'File creation state changed. Reload and try again.',
        { cause: error },
      )
    }
  }

  /** Existing file row を revision と任意の pending approval count 条件付きで保存します。 */
  private async putFileWithAudit(
    item: StoredFileItem,
    expectedRevision: number,
    auditContext: MutationAuditContext | undefined,
    event: {
      /** Audit event type です。 */
      eventType: string
      /** Audit action です。 */
      action: string
      /** Audit metadata です。 */
      metadata: Readonly<Record<string, unknown>>
    },
    expectedPendingApprovalCount?: number,
  ) {
    const guardsPendingApprovals = expectedPendingApprovalCount !== undefined
    const transactionItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [{
      Put: {
        TableName: this.tableName,
        Item: item,
        ConditionExpression: 'revision = :expectedRevision' +
          (guardsPendingApprovals
            ? ' AND #pendingApprovalCount = :expectedPendingApprovalCount'
            : ''),
        ...(guardsPendingApprovals
          ? { ExpressionAttributeNames: { '#pendingApprovalCount': 'pendingApprovalCount' } }
          : {}),
        ExpressionAttributeValues: {
          ':expectedRevision': expectedRevision,
          ...(guardsPendingApprovals
            ? { ':expectedPendingApprovalCount': expectedPendingApprovalCount }
            : {}),
        },
      },
    }]
    addAuditItem(transactionItems, this.auditTableName, auditContext, {
      directoryId: item.workspaceId,
      eventType: event.eventType,
      ...resolveStoredFileAuditEntity(item),
      target: { type: 'file', id: item.fileId },
      action: event.action,
      metadata: event.metadata,
    })
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactionItems }))
    } catch (error) {
      if (isConditionalTransactionError(error)) {
        throw new FileProofingError(409, 'FileVersionConflict', 'File changed. Reload and try again.', {
          cause: error,
        })
      }
      throw error
    }
  }

  /** Durable verification state を起点に scan status を revision 条件付きで確定します。 */
  private async persistVerifiedScanStatus(
    item: StoredFileItem,
    versionId: string,
    scanStatus: FileScanStatus,
  ) {
    const version = requireStoredVersion(item, versionId)
    const next = replaceStoredVersion(item, { ...version, scanStatus })
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: next,
        ConditionExpression: 'revision = :revision',
        ExpressionAttributeValues: { ':revision': item.revision },
      }))
      return next
    } catch (error) {
      if (!isConditionalWriteError(error)) {
        throw error
      }
      return this.getFile(item.scopeKey, item.fileId)
    }
  }

  /** Pending scan tag を更新し、file row に反映します。 */
  private async refreshScanStatuses(item: StoredFileItem) {
    const pendingVersions = item.versions.filter((version): version is StoredFileVersion & {
      objectVersionId: string
    } =>
      version.scanStatus === 'scanning' && version.objectVersionId !== undefined
    )
    if (pendingVersions.length === 0) {
      return item
    }
    const statuses = await Promise.all(pendingVersions.map(async (version) => {
      const status = await this.objectClient.getScanStatus(
        version.objectKey,
        version.objectVersionId,
      ).catch(() => version.scanStatus)
      if (status === 'available') {
        const completed = await this.objectClient.markCompleted(
          version.objectKey,
          version.objectVersionId,
        ).then(() => true, () => false)
        if (!completed) {
          return { versionId: version.id, status: version.scanStatus }
        }
      }
      return { versionId: version.id, status }
    }))
    const changed = statuses.some(({ versionId, status }) =>
      item.versions.find((version) => version.id === versionId)?.scanStatus !== status
    )
    if (!changed) {
      return item
    }
    const statusByVersion = new Map(statuses.map((entry) => [entry.versionId, entry.status]))
    const next: StoredFileItem = {
      ...item,
      revision: item.revision + 1,
      versions: item.versions.map((version) => ({
        ...version,
        scanStatus: statusByVersion.get(version.id) ?? version.scanStatus,
      })),
      updatedAt: new Date().toISOString(),
    }
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: next,
        ConditionExpression: 'revision = :revision',
        ExpressionAttributeValues: { ':revision': item.revision },
      }))
      return next
    } catch (error) {
      if (!isConditionalWriteError(error)) {
        throw error
      }
      return this.getFile(item.scopeKey, item.fileId)
    }
  }

  /** Compact reviewer pointers が参照する main approval rows を batch read します。 */
  private async batchGetReviewerApprovalItems(items: readonly StoredReviewerApprovalItem[]) {
    const approvals = new Map<string, StoredApprovalItem>()
    let keys = [...new Map(items.map((item) => [
      createReviewerApprovalPointerKey(item),
      {
        scopeKey: item.sourceScopeKey,
        recordKey: createApprovalRecordKey(item.approvalId),
      },
    ])).values()]

    for (let attempt = 0; keys.length > 0 && attempt < 5; attempt += 1) {
      const response = await this.documentClient.send(new BatchGetCommand({
        RequestItems: {
          [this.tableName]: {
            ConsistentRead: true,
            Keys: keys,
          },
        },
      }))
      for (const item of response.Responses?.[this.tableName] ?? []) {
        if (isStoredApprovalItem(item)) {
          approvals.set(`${item.scopeKey}\0${item.id}`, item)
        }
      }
      keys = response.UnprocessedKeys?.[this.tableName]?.Keys ?? []
    }
    if (keys.length > 0) {
      throw new FileProofingError(
        503,
        'ReviewerApprovalsUnavailable',
        'Reviewer approvals could not be read completely.',
      )
    }
    return approvals
  }

  /** Scope partition を prefix query します。 */
  private async queryScope(scopeKey: string, recordPrefix?: string) {
    const input: QueryCommandInput = {
      TableName: this.tableName,
      KeyConditionExpression: recordPrefix
        ? 'scopeKey = :scopeKey AND begins_with(recordKey, :recordPrefix)'
        : 'scopeKey = :scopeKey',
      ConsistentRead: true,
      ExpressionAttributeValues: {
        ':scopeKey': scopeKey,
        ...(recordPrefix ? { ':recordPrefix': recordPrefix } : {}),
      },
    }
    const items: unknown[] = []
    let exclusiveStartKey: QueryCommandInput['ExclusiveStartKey']

    do {
      const response = await this.documentClient.send(new QueryCommand({
        ...input,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      items.push(...(response.Items ?? []))
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return items
  }

  /** 保存済み immutable object versions を同期的に deleted quarantine へ移します。 */
  private async quarantineDeletedVersions(file: StoredFileItem) {
    await Promise.all(file.versions.flatMap((version) => version.objectVersionId
      ? [this.objectClient.quarantineDeletedVersion(version.objectKey, version.objectVersionId)]
      : []))
  }

  /** File に従属する review metadata を tombstone と同じ期限でTTL削除します。 */
  private async scheduleRelatedMetadataExpiry(
    file: StoredFileItem,
    expiresAt: number,
    retentionUntil: string,
  ) {
    const [annotations, approvalIndexes] = await Promise.all([
      this.queryScope(file.scopeKey, `ANNOTATION#${file.fileId}#`),
      this.queryScope(file.scopeKey, createFileApprovalIndexPrefix(file.fileId)),
    ])
    const relatedApprovalIndexes = approvalIndexes
      .filter(isStoredFileApprovalIndexItem)
      .filter((approvalIndex) => approvalIndex.fileId === file.fileId)
    const keys = [
      ...annotations.filter(isStoredAnnotationItem).map((annotation) => ({
        scopeKey: annotation.scopeKey,
        recordKey: annotation.recordKey,
      })),
      ...relatedApprovalIndexes.flatMap((approvalIndex) => [
        { scopeKey: approvalIndex.scopeKey, recordKey: approvalIndex.recordKey },
        {
          scopeKey: approvalIndex.scopeKey,
          recordKey: createApprovalRecordKey(approvalIndex.approvalId),
        },
        ...approvalIndex.reviewerMemberKeys.map((reviewerMemberKey) => ({
          scopeKey: createReviewerScopeKey(file.workspaceId, reviewerMemberKey),
          recordKey: `APPROVAL#${approvalIndex.dueAt}#${approvalIndex.approvalId}`,
        })),
      ]),
    ]

    for (let index = 0; index < keys.length; index += 20) {
      await Promise.all(keys.slice(index, index + 20).map(async (key) => {
        try {
          await this.documentClient.send(new UpdateCommand({
            TableName: this.tableName,
            Key: key,
            UpdateExpression: 'SET expiresAt = :expiresAt, retentionUntil = :retentionUntil',
            ConditionExpression: 'attribute_exists(scopeKey) AND attribute_exists(recordKey)',
            ExpressionAttributeValues: { ':expiresAt': expiresAt, ':retentionUntil': retentionUntil },
          }))
        } catch (error) {
          if (!isConditionalWriteError(error)) {
            throw error
          }
        }
      }))
    }
  }

  /** File row を取得します。 */
  private async getFile(scopeKey: string, fileId: string): Promise<StoredFileItem>
  private async getFile(
    scopeKey: string,
    fileId: string,
    required: false,
  ): Promise<StoredFileItem | undefined>
  private async getFile(scopeKey: string, fileId: string, required = true) {
    const item = await this.getItem<StoredFileItem>(scopeKey, createFileRecordKey(fileId))
    if (!item && required) {
      throw new FileProofingError(404, 'FileNotFound', 'File was not found.')
    }
    return item
  }

  /** Approval row を取得します。 */
  private async getApproval(scopeKey: string, approvalId: string): Promise<StoredApprovalItem>
  private async getApproval(
    scopeKey: string,
    approvalId: string,
    required: false,
  ): Promise<StoredApprovalItem | undefined>
  private async getApproval(scopeKey: string, approvalId: string, required = true) {
    const item = await this.getItem<StoredApprovalItem>(scopeKey, createApprovalRecordKey(approvalId))
    if (!item && required) {
      throw new FileProofingError(404, 'ApprovalNotFound', 'Approval was not found.')
    }
    return item
  }

  /** Generic row を取得します。 */
  private async getItem<T>(scopeKey: string, recordKey: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { scopeKey, recordKey },
      ConsistentRead: true,
    }))
    return response.Item as T | undefined
  }

  /** Local DynamoDB table を一度だけ初期化します。 */
  private async ensureReady() {
    if (!this.bootstrapLocalTable || !this.dynamoDbClient) {
      return
    }
    this.tableReady ??= ensureLocalFileProofingTable(this.dynamoDbClient, this.tableName)
    await this.tableReady
  }
}

/** Production/local environment から標準 file proofing client を作成します。 */
export function createDefaultFileProofingClient(): FileProofingClient {
  const dynamoDbEndpoint = getConfiguredDynamoDbEndpoint()
  const dynamoDbClient = new DynamoDBClient(createAwsClientConfiguration(dynamoDbEndpoint))
  const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
    marshallOptions: { removeUndefinedValues: true },
  })
  const s3Endpoint = readEnvironment('AWS_ENDPOINT_URL_S3') ?? readEnvironment('AWS_ENDPOINT_URL')
  const s3Client = new S3Client({
    ...createAwsClientConfiguration(s3Endpoint),
    forcePathStyle: Boolean(s3Endpoint),
    requestChecksumCalculation: 'WHEN_REQUIRED',
  })
  const objectClient = new S3FileObjectClient(
    s3Client,
    readEnvironment('FILE_BUCKET_NAME') ?? 'mukuroji-files-local',
    readPositiveIntegerEnvironment('FILE_UPLOAD_URL_TTL_SECONDS', 600),
    readPositiveIntegerEnvironment('FILE_DOWNLOAD_URL_TTL_SECONDS', 300),
  )

  return new DynamoDbFileProofingClient(
    documentClient,
    readEnvironment('FILE_PROOFING_TABLE_NAME') ?? 'mukuroji-file-proofing',
    objectClient,
    {
      auditTableName: getConfiguredAuditTableName(),
      retentionDays: readPositiveIntegerEnvironment('FILE_RETENTION_DAYS', 30),
      workItemsTableName: readEnvironment('WORK_ITEMS_TABLE_NAME') ??
        readEnvironment('TEAM_ISSUES_TABLE_NAME'),
      dynamoDbClient,
      bootstrapLocalTable: Boolean(dynamoDbEndpoint),
    },
  )
}

/** Scope を stable DynamoDB partition key へ変換します。 */
export function createFileProofingScopeKey(scope: FileProofingScope) {
  const workspaceId = requireText(scope.workspaceId, 'Workspace ID')
  const teamId = requireText(scope.teamId, 'Team ID')

  if (scope.kind === 'work-item') {
    return `WORKSPACE#${workspaceId}#TEAM#${teamId}#WORKITEM#${requireText(scope.issueId, 'Work Item ID')}`
  }
  if (scope.kind === 'project') {
    return `WORKSPACE#${workspaceId}#TEAM#${teamId}#PROJECT#${requireText(scope.projectId, 'Project ID')}`
  }
  throw new FileProofingError(400, 'InvalidFileScope', 'File scope is invalid.')
}

/** GuardDuty tag set を canonical scan status へ変換します。 */
export function mapGuardDutyScanStatus(tags: Tag[] | undefined): FileScanStatus {
  const status = tags?.find((tag) => tag.Key === GUARDDUTY_SCAN_STATUS_TAG)?.Value

  if (!status) {
    return 'scanning'
  }
  if (status === 'NO_THREATS_FOUND') {
    return 'available'
  }
  if (status === 'THREATS_FOUND') {
    return 'blocked'
  }
  if (status === 'UNSUPPORTED' || status === 'ACCESS_DENIED' || status === 'FAILED') {
    return 'failed'
  }
  return 'scanning'
}

/** Approval row 一覧から Work Item summary を作成します。 */
export function createApprovalSummary(approvals: readonly ApprovalRequest[]): ApprovalSummary {
  const now = Date.now()
  const pending = approvals.filter((approval) => approval.status === 'pending')
  const nextDueAt = pending.map((approval) => approval.dueAt).sort()[0]

  return {
    pendingCount: pending.length,
    overdueCount: pending.filter((approval) => Date.parse(approval.dueAt) < now).length,
    approvedCount: approvals.filter((approval) => approval.status === 'approved').length,
    rejectedCount: approvals.filter((approval) => approval.status === 'rejected').length,
    changesRequestedCount: approvals.filter(
      (approval) => approval.status === 'changes-requested',
    ).length,
    ...(nextDueAt ? { nextDueAt } : {}),
  }
}

/** Approval がない Work Item の summary です。 */
function createEmptyApprovalSummary(): ApprovalSummary {
  return {
    pendingCount: 0,
    overdueCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
    changesRequestedCount: 0,
  }
}

/** Stored aggregate projection を時点依存の overdue count 付き response へ変換します。 */
function toApprovalSummary(item: StoredApprovalSummaryItem): ApprovalSummary {
  const dueDates = [...(item.pendingDueAt ?? [])].map(readApprovalDueAtKey).sort()
  const now = Date.now()
  return {
    pendingCount: item.pendingCount,
    overdueCount: dueDates.filter((dueAt) => Date.parse(dueAt) < now).length,
    approvedCount: item.approvedCount,
    rejectedCount: item.rejectedCount,
    changesRequestedCount: item.changesRequestedCount,
    ...(dueDates[0] ? { nextDueAt: dueDates[0] } : {}),
  }
}

/** 同一期限の approval も区別できる pending due set key を作成します。 */
function createApprovalDueAtKey(dueAt: string, approvalId: string) {
  return `${dueAt}#${approvalId}`
}

/** Pending due set key から ISO dueAt を取得します。 */
function readApprovalDueAtKey(value: string) {
  const separatorIndex = value.indexOf('#')
  return separatorIndex > 0 ? value.slice(0, separatorIndex) : value
}

/** File record key を作成します。 */
function createFileRecordKey(fileId: string) {
  return `FILE#${requireText(fileId, 'File ID')}`
}

/** Approval record key を作成します。 */
function createApprovalRecordKey(approvalId: string) {
  return `APPROVAL#${requireText(approvalId, 'Approval ID')}`
}

/** File approval reverse projection の record key prefix を作成します。 */
function createFileApprovalIndexPrefix(fileId: string) {
  return `FILE_APPROVAL#${requireText(fileId, 'File ID')}#`
}

/** File approval reverse projection の record key を作成します。 */
function createFileApprovalIndexRecordKey(fileId: string, approvalId: string) {
  return `${createFileApprovalIndexPrefix(fileId)}${requireText(approvalId, 'Approval ID')}`
}

/** Annotation record prefix を作成します。 */
function createAnnotationRecordPrefix(fileId: string, versionId: string) {
  return `ANNOTATION#${requireText(fileId, 'File ID')}#${requireText(versionId, 'Version ID')}#`
}

/** Reviewer query partition key を作成します。 */
function createReviewerScopeKey(workspaceId: string, memberKey: string) {
  return `WORKSPACE#${requireText(workspaceId, 'Workspace ID')}#REVIEWER#${normalizeMemberKey(memberKey)}`
}

/** Compact reviewer pointer の map key を作成します。 */
function createReviewerApprovalPointerKey(item: StoredReviewerApprovalItem) {
  return `${item.sourceScopeKey}\0${item.approvalId}`
}

/** Work Item activity と共有する canonical audit entity ID を作成します。 */
function createWorkItemAuditEntityId(scope: FileProofingScope) {
  requireWorkItemScope(scope)
  return `team/${scope.teamId}/issue/${scope.issueId}`
}

/** File scope の親 activity entity を解決します。 */
function resolveFileAuditEntity(scope: FileProofingScope): {
  /** Audit entity type です。 */
  entityType: 'work-item' | 'project'
  /** Audit entity ID です。 */
  entityId: string
} {
  return scope.kind === 'work-item'
    ? { entityType: 'work-item', entityId: createWorkItemAuditEntityId(scope) }
    : { entityType: 'project', entityId: requireText(scope.projectId, 'Project ID') }
}

/** Stored file row から親 activity entity を解決します。 */
function resolveStoredFileAuditEntity(item: StoredFileItem) {
  return item.issueId
    ? {
        entityType: 'work-item' as const,
        entityId: `team/${item.teamId}/issue/${item.issueId}`,
      }
    : {
        entityType: 'project' as const,
        entityId: requireText(item.projectId, 'Project ID'),
      }
}

/** Attachment target を scope から解決します。 */
function resolveAttachmentTarget(scope: FileProofingScope): {
  /** Attachment target 種別です。 */
  type: FileAttachmentTargetType
  /** Attachment target ID です。 */
  id: string
} {
  if (scope.commentId) {
    return { type: 'comment', id: requireText(scope.commentId, 'Comment ID') }
  }
  if (scope.kind === 'work-item') {
    return { type: 'work-item', id: requireText(scope.issueId, 'Work Item ID') }
  }
  return { type: 'project', id: requireText(scope.projectId, 'Project ID') }
}

/** Direct upload input を検証・正規化します。 */
function normalizeUploadInput(input: CreateFileUploadInput) {
  const fileName = normalizeFileName(input.fileName)
  const contentType = normalizeContentType(input.contentType)
  if (!isAllowedFileContentType(contentType)) {
    throw new FileProofingError(415, 'FileTypeNotAllowed', `Media type "${contentType}" is not allowed.`)
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new FileProofingError(400, 'InvalidFileSize', 'File size must be a positive integer.')
  }
  if (input.sizeBytes > FILE_UPLOAD_MAX_SIZE_BYTES) {
    throw new FileProofingError(
      413,
      'FileTooLarge',
      `File exceeds the ${FILE_UPLOAD_MAX_SIZE_BYTES} byte upload limit.`,
    )
  }
  return { fileName, contentType, sizeBytes: input.sizeBytes }
}

/** File 名を path/control character なしの表示名へ正規化します。 */
function normalizeFileName(value: unknown) {
  const raw = requireLimitedText(value, 'File name', 255)
  const fileName = raw.split(/[\\/]/).at(-1)?.split('').filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint >= 32 && codePoint !== 127
  }).join('').trim()
  if (!fileName || fileName === '.' || fileName === '..') {
    throw new FileProofingError(400, 'InvalidFileName', 'File name is invalid.')
  }
  return fileName
}

/** MIME type parameter を除去して小文字化します。 */
function normalizeContentType(value: unknown) {
  return requireText(value, 'File media type').split(';')[0]!.trim().toLowerCase()
}

/** Upload を許可する MIME type かどうかを判定します。 */
function isAllowedFileContentType(contentType: string) {
  return contentType.startsWith('image/') ||
    contentType === 'application/pdf' ||
    contentType === 'video/mp4' ||
    contentType === 'video/webm' ||
    contentType === 'video/quicktime' ||
    contentType === 'text/plain' ||
    contentType === 'text/csv' ||
    contentType === 'application/json' ||
    contentType === 'application/zip' ||
    contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    contentType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

/** MIME type を browser preview 種別へ変換します。 */
function resolvePreviewKind(contentType: string): FilePreviewKind {
  if (contentType.startsWith('image/')) {
    return 'image'
  }
  if (contentType === 'application/pdf') {
    return 'pdf'
  }
  if (contentType.startsWith('video/')) {
    return 'video'
  }
  return 'none'
}

/** Stored version を作成します。 */
function createStoredVersion(
  versionId: string,
  number: number,
  input: { fileName: string; contentType: string; sizeBytes: number },
  memberKey: string,
  createdAt: string,
  objectKey: string,
  requestFingerprint?: string,
): StoredFileVersion {
  return {
    id: versionId,
    number,
    fileName: input.fileName,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    scanStatus: 'pending',
    previewKind: resolvePreviewKind(input.contentType),
    createdByMemberKey: normalizeMemberKey(memberKey),
    createdAt,
    objectKey,
    ...(requestFingerprint ? { requestFingerprint } : {}),
  }
}

/** File body の非推測 object key を作成します。 */
function createFileObjectKey(
  workspaceId: string,
  fileId: string,
  versionId: string,
  fileName: string,
) {
  return [
    'workspaces',
    encodeURIComponent(requireText(workspaceId, 'Workspace ID')),
    'files',
    encodeURIComponent(fileId),
    encodeURIComponent(versionId),
    encodeURIComponent(fileName),
  ].join('/')
}

/** Stored file を API response へ変換します。 */
function toFileAttachment(item: StoredFileItem, actor: FileProofingActor): FileAttachment {
  const versions = [...item.versions].sort((left, right) => right.number - left.number)
  const current = requireStoredVersion(item, item.currentVersionId)
  const canRead = !actor.guest || item.guestAccess
  const hasPendingApproval = item.pendingApprovalCount > 0
  const capabilities: FileAttachmentCapabilities = {
    canDownload: canRead,
    canUploadVersion: actor.canWrite && !hasPendingApproval,
    canDelete: !actor.guest && !hasPendingApproval && (
      actor.canManage || item.createdByMemberKey === actor.memberKey
    ),
    canAnnotate: actor.canWrite,
    canRequestApproval: actor.canWrite && item.issueId !== undefined,
  }
  return {
    id: item.fileId,
    name: item.name,
    targetType: item.targetType,
    targetId: item.targetId,
    versionCount: item.versions.length,
    versions: versions.map(toFileVersion),
    currentVersion: toFileVersion(current),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    guestAccess: item.guestAccess,
    ...(item.deletedAt ? { deletedAt: item.deletedAt } : {}),
    ...(item.retentionUntil ? { retentionUntil: item.retentionUntil } : {}),
    capabilities,
  }
}

/** Stored version の内部 object key を response から除外します。 */
function toFileVersion(version: StoredFileVersion): FileVersion {
  const {
    objectKey: _objectKey,
    objectVersionId: _objectVersionId,
    requestFingerprint: _requestFingerprint,
    ...view
  } = version
  return view
}

/** Stored annotation を capability 付き response へ変換します。 */
function toFileAnnotation(item: StoredAnnotationItem, actor: FileProofingActor): FileAnnotation {
  const {
    scopeKey: _scopeKey,
    recordKey: _recordKey,
    entryType: _entryType,
    requestFingerprint: _requestFingerprint,
    ...annotation
  } = item
  return {
    ...annotation,
    capabilities: {
      canResolve: actor.canManage || item.authorMemberKey === actor.memberKey,
    },
  }
}

/** Stored approval を actor capability 付き response へ変換します。 */
function toApprovalRequest(item: StoredApprovalItem, actor: FileProofingActor): ApprovalRequest {
  const isPendingReviewer = item.reviewers.some((reviewer) =>
    normalizeMemberKey(reviewer.memberKey) === normalizeMemberKey(actor.memberKey) &&
    reviewer.status === 'pending'
  )
  return {
    id: item.id,
    teamId: item.teamId,
    issueId: item.issueId,
    ...(item.projectId ? { projectId: item.projectId } : {}),
    revision: item.revision,
    fileId: item.fileId,
    versionId: item.versionId,
    status: item.status,
    reviewers: item.reviewers,
    dueAt: item.dueAt,
    requestedByMemberKey: item.requestedByMemberKey,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.completedAt ? { completedAt: item.completedAt } : {}),
    capabilities: {
      canDecide: isPendingReviewer && item.status === 'pending',
      canCancel: item.status === 'pending' && (
        actor.canManage || item.requestedByMemberKey === actor.memberKey
      ),
    },
  }
}

/** Stored file 内の version を取得します。 */
function requireStoredVersion(item: StoredFileItem, versionId: string) {
  const version = item.versions.find((candidate) => candidate.id === versionId)
  if (!version) {
    throw new FileProofingError(404, 'FileVersionNotFound', 'File version was not found.')
  }
  return version
}

/** Upload 完了で固定した immutable object version ID を取得します。 */
function requireStoredObjectVersionId(version: StoredFileVersion) {
  if (!version.objectVersionId || !version.verifiedAt) {
    throw new FileProofingError(
      423,
      'FileUploadIncomplete',
      'File upload must be completed before this operation is allowed.',
    )
  }
  return version.objectVersionId
}

/** Stored file 内の version を置換します。 */
function replaceStoredVersion(item: StoredFileItem, nextVersion: StoredFileVersion): StoredFileItem {
  return {
    ...item,
    revision: item.revision + 1,
    versions: item.versions.map((version) =>
      version.id === nextVersion.id ? nextVersion : version
    ),
    updatedAt: nextVersion.verifiedAt ?? new Date().toISOString(),
  }
}

/** Soft deleted file を mutation から拒否します。 */
function requireFileNotDeleted(file: StoredFileItem) {
  if (file.deletedAt) {
    throw new FileProofingError(410, 'FileDeleted', 'File is in retention and cannot be changed.')
  }
}

/** Actor に file write capability があることを検証します。 */
function requireFileWrite(actor: FileProofingActor) {
  if (!actor.canWrite || actor.guest) {
    throw new FileProofingError(403, 'FileWriteDenied', 'File write access is required.')
  }
}

/** Actor が file を read できることを検証します。 */
function requireFileRead(file: StoredFileItem, actor: FileProofingActor) {
  if (actor.guest && !file.guestAccess) {
    throw new FileProofingError(403, 'FileGuestAccessDenied', 'This file is not shared with guests.')
  }
}

/** GuardDuty clean 以外の object access を拒否します。 */
function requireAvailableScanStatus(status: FileScanStatus) {
  if (status === 'available') {
    return
  }
  if (status === 'blocked') {
    throw new FileProofingError(423, 'FileThreatDetected', 'Malware scanning blocked this file.')
  }
  if (status === 'failed') {
    throw new FileProofingError(423, 'FileScanFailed', 'File scanning did not complete safely.')
  }
  throw new FileProofingError(423, 'FileScanPending', 'File scanning is still in progress.')
}

/** Annotation anchor を media type に合わせて検証します。 */
function normalizeAnnotationAnchor(anchor: AnnotationAnchor, previewKind: FilePreviewKind) {
  if (previewKind === 'none' || anchor.kind !== previewKind) {
    throw new FileProofingError(400, 'InvalidAnnotationAnchor', 'Annotation media type is invalid.')
  }
  const x = normalizeCoordinate(anchor.x, 'Annotation X coordinate')
  const y = normalizeCoordinate(anchor.y, 'Annotation Y coordinate')
  if (anchor.kind === 'pdf') {
    if (!Number.isSafeInteger(anchor.pageNumber) || (anchor.pageNumber ?? 0) < 1) {
      throw new FileProofingError(400, 'InvalidAnnotationAnchor', 'PDF page number is invalid.')
    }
    return { kind: 'pdf', x, y, pageNumber: anchor.pageNumber! } satisfies AnnotationAnchor
  }
  if (anchor.kind === 'video') {
    if (!Number.isSafeInteger(anchor.timecodeMs) || (anchor.timecodeMs ?? -1) < 0) {
      throw new FileProofingError(400, 'InvalidAnnotationAnchor', 'Video timecode is invalid.')
    }
    return { kind: 'video', x, y, timecodeMs: anchor.timecodeMs! } satisfies AnnotationAnchor
  }
  return { kind: 'image', x, y } satisfies AnnotationAnchor
}

/** 0..1 coordinate を検証します。 */
function normalizeCoordinate(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new FileProofingError(400, 'InvalidAnnotationAnchor', `${label} is invalid.`)
  }
  return value
}

/** Approval decision を reviewer status へ変換します。 */
function mapApprovalDecision(decision: CreateFileApprovalDecisionInput['decision']): ApprovalReviewerStatus {
  if (decision === 'approve') {
    return 'approved'
  }
  if (decision === 'reject') {
    return 'rejected'
  }
  if (decision === 'request-changes') {
    return 'changes-requested'
  }
  throw new FileProofingError(400, 'InvalidApprovalDecision', 'Approval decision is invalid.')
}

/** Reviewer statuses を request 全体の状態へ集約します。 */
function aggregateApprovalStatus(reviewers: readonly ApprovalReviewer[]): ApprovalRequestStatus {
  if (reviewers.some((reviewer) => reviewer.status === 'rejected')) {
    return 'rejected'
  }
  if (reviewers.some((reviewer) => reviewer.status === 'changes-requested')) {
    return 'changes-requested'
  }
  if (reviewers.every((reviewer) => reviewer.status === 'approved')) {
    return 'approved'
  }
  return 'pending'
}

/** Reviewer decision と aggregate state から activity event type を選択します。 */
function resolveApprovalDecisionEventType(
  status: ApprovalRequestStatus,
  reviewerStatus: ApprovalReviewerStatus,
) {
  if (status === 'approved') {
    return 'approval.completed'
  }
  if (reviewerStatus === 'rejected') {
    return 'approval.rejected'
  }
  if (reviewerStatus === 'changes-requested') {
    return 'approval.changes-requested'
  }
  return 'approval.approved'
}

/** Workflow transition status を canonical Work Item status に制限します。 */
function normalizeWorkItemStatus(value: unknown): WorkItemStatus {
  if (value === 'todo' || value === 'in-progress' || value === 'review' || value === 'done') {
    return value
  }
  throw new FileProofingError(
    400,
    'InvalidApprovalTransition',
    'Approval completion transition is invalid.',
  )
}

/** Approval main/projection rows の transaction items を作成します。 */
function createApprovalProjectionPutItems(
  tableName: string,
  approval: StoredApprovalItem,
  expectedRevision?: number,
) {
  const transactionItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [{
    Put: {
      TableName: tableName,
      Item: approval,
      ConditionExpression: expectedRevision === undefined
        ? 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)'
        : 'revision = :expectedRevision',
      ...(expectedRevision === undefined
        ? {}
        : { ExpressionAttributeValues: { ':expectedRevision': expectedRevision } }),
    },
  }]
  const fileApprovalIndex: StoredFileApprovalIndexItem = {
    scopeKey: approval.scopeKey,
    recordKey: createFileApprovalIndexRecordKey(approval.fileId, approval.id),
    entryType: 'file-approval-index',
    fileId: approval.fileId,
    approvalId: approval.id,
    dueAt: approval.dueAt,
    reviewerMemberKeys: approval.reviewers.map((reviewer) => reviewer.memberKey),
  }
  transactionItems.push({ Put: { TableName: tableName, Item: fileApprovalIndex } })
  for (const reviewer of approval.reviewers) {
    const projection: StoredReviewerApprovalItem = {
      scopeKey: createReviewerScopeKey(approval.workspaceId, reviewer.memberKey),
      recordKey: `APPROVAL#${approval.dueAt}#${approval.id}`,
      entryType: 'reviewer-approval',
      approvalId: approval.id,
      dueAt: approval.dueAt,
      reviewerMemberKey: reviewer.memberKey,
      reviewerStatus: reviewer.status,
      approvalStatus: approval.status,
      sourceScopeKey: approval.scopeKey,
      ...(approval.status === 'pending'
        ? {}
        : { expiresAt: epochSecondsAfterDays(approval.updatedAt, 30) }),
    }
    transactionItems.push({ Put: { TableName: tableName, Item: projection } })
  }
  return transactionItems
}

/** File が read 時点から変更・削除されていないことを transaction 内で確認します。 */
function createFileRevisionConditionCheck(
  tableName: string,
  file: StoredFileItem,
  expectedVersionId = file.currentVersionId,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { scopeKey: file.scopeKey, recordKey: file.recordKey },
      ConditionExpression:
        '#revision = :fileRevision AND #currentVersionId = :versionId AND attribute_not_exists(#deletedAt)',
      ExpressionAttributeNames: {
        '#currentVersionId': 'currentVersionId',
        '#deletedAt': 'deletedAt',
        '#revision': 'revision',
      },
      ExpressionAttributeValues: {
        ':fileRevision': file.revision,
        ':versionId': expectedVersionId,
      },
    },
  }
}

/** Pending approval count と file revision を同じ transaction で増減します。 */
function createFilePendingApprovalUpdate(
  tableName: string,
  file: StoredFileItem,
  expectedVersionId: string,
  updatedAt: string,
  mode: 'increment' | 'decrement',
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  return {
    Update: {
      TableName: tableName,
      Key: { scopeKey: file.scopeKey, recordKey: file.recordKey },
      UpdateExpression:
        'SET #pending = if_not_exists(#pending, :zero) + :delta, #revision = #revision + :one, #updatedAt = :updatedAt',
      ConditionExpression:
        '#revision = :fileRevision AND #currentVersionId = :versionId AND attribute_not_exists(#deletedAt)' +
        (mode === 'decrement' ? ' AND #pending >= :one' : ''),
      ExpressionAttributeNames: {
        '#currentVersionId': 'currentVersionId',
        '#deletedAt': 'deletedAt',
        '#pending': 'pendingApprovalCount',
        '#revision': 'revision',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':delta': mode === 'increment' ? 1 : -1,
        ':fileRevision': file.revision,
        ':one': 1,
        ':updatedAt': updatedAt,
        ':versionId': expectedVersionId,
        ':zero': 0,
      },
    },
  }
}

/** Approval mutation と同じ transaction で aggregate projection を増減します。 */
function createApprovalSummaryUpdate(
  tableName: string,
  scopeKey: string,
  updatedAt: string,
  delta: ApprovalSummaryDelta,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  return {
    Update: {
      TableName: tableName,
      Key: { scopeKey, recordKey: 'APPROVAL_SUMMARY' },
      UpdateExpression:
        'SET #entryType = if_not_exists(#entryType, :entryType), ' +
        '#pending = if_not_exists(#pending, :zero) + :pendingDelta, ' +
        '#approved = if_not_exists(#approved, :zero) + :approvedDelta, ' +
        '#rejected = if_not_exists(#rejected, :zero) + :rejectedDelta, ' +
        '#changes = if_not_exists(#changes, :zero) + :changesDelta, ' +
        '#updatedAt = :updatedAt ' +
        (delta.pending > 0
          ? 'ADD #pendingDueAt :dueAtSet'
          : 'DELETE #pendingDueAt :dueAtSet'),
      ...(delta.pending < 0
        ? { ConditionExpression: 'attribute_exists(scopeKey) AND #pending >= :one' }
        : {}),
      ExpressionAttributeNames: {
        '#approved': 'approvedCount',
        '#changes': 'changesRequestedCount',
        '#entryType': 'entryType',
        '#pending': 'pendingCount',
        '#pendingDueAt': 'pendingDueAt',
        '#rejected': 'rejectedCount',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':approvedDelta': delta.approved ?? 0,
        ':changesDelta': delta.changesRequested ?? 0,
        ':entryType': 'approval-summary',
        ':dueAtSet': new Set([createApprovalDueAtKey(delta.dueAt, delta.approvalId)]),
        ':pendingDelta': delta.pending,
        ':rejectedDelta': delta.rejected ?? 0,
        ':updatedAt': updatedAt,
        ':zero': 0,
        ...(delta.pending < 0 ? { ':one': 1 } : {}),
      },
    },
  }
}

/** Optional audit event を state transaction へ追加します。 */
function addAuditItem(
  transactionItems: NonNullable<TransactWriteCommandInput['TransactItems']>,
  tableName: string | undefined,
  context: MutationAuditContext | undefined,
  input: Parameters<typeof createMutationAuditEventPut>[2],
) {
  const item = createMutationAuditEventPut(tableName, context, input)
  if (item) {
    transactionItems.push(item)
  }
}

/** File mutation 共通の audit/outbox metadata を作成します。 */
function createFileAuditMetadata(
  scope: FileProofingScope,
  actor: FileProofingActor,
  fileId: string,
  versionId: string,
) {
  return {
    actorMemberKey: actor.memberKey,
    teamId: scope.teamId,
    issueId: scope.issueId,
    projectId: scope.projectId,
    commentId: scope.commentId,
    fileId,
    versionId,
    deepLink: scope.issueId
      ? `/teams/${encodeURIComponent(scope.teamId)}/issues/${encodeURIComponent(scope.issueId)}`
      : `/teams/${encodeURIComponent(scope.teamId)}/projects/${encodeURIComponent(scope.projectId ?? '')}/files`,
  }
}

/** Scope と mutation idempotency hash から deterministic resource ID を作成します。 */
function createMutationResourceId(
  prefix: string,
  context: MutationAuditContext | undefined,
  scopeIdentity: string,
) {
  const suffix = context
    ? createHash('sha256')
        .update(`${scopeIdentity}\0${context.idempotencyKeyHash}`)
        .digest('hex')
        .slice(0, 40)
    : crypto.randomUUID().replaceAll('-', '')
  return `${prefix}_${suffix}`
}

/** 同じ idempotency key が別 payload に再利用されていないことを確認します。 */
function requireMatchingIdempotencyFingerprint(
  storedFingerprint: string | undefined,
  context: MutationAuditContext | undefined,
) {
  if (context && storedFingerprint !== context.requestFingerprint) {
    throw new FileProofingError(
      409,
      'IdempotencyKeyReused',
      'The Idempotency-Key was already used with a different request.',
    )
  }
}

/** Work Item scope であることを検証します。 */
function requireWorkItemScope(scope: FileProofingScope) {
  if (scope.kind !== 'work-item' || !scope.issueId) {
    throw new FileProofingError(400, 'InvalidApprovalScope', 'Approval requires a Work Item scope.')
  }
}

/** ISO timestamp が未来日時であることを検証します。 */
function normalizeFutureTimestamp(value: unknown, label: string) {
  const timestamp = requireText(value, label)
  const epoch = Date.parse(timestamp)
  if (!Number.isFinite(epoch) || epoch <= Date.now()) {
    throw new FileProofingError(400, 'InvalidApprovalDueAt', `${label} must be in the future.`)
  }
  return new Date(epoch).toISOString()
}

/** Member key を比較用に正規化します。 */
function normalizeMemberKey(value: unknown) {
  return requireText(value, 'Workspace member key').toLowerCase()
}

/** Reviewer member key を DynamoDB item size に収まる identity 長へ制限します。 */
function normalizeReviewerMemberKey(value: unknown) {
  return requireLimitedText(value, 'Approval reviewer', 320).toLowerCase()
}

/** Reviewer page size を 1-100 件へ制限します。 */
function normalizeReviewerApprovalLimit(value: number | undefined) {
  const limit = value ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new FileProofingError(
      400,
      'InvalidReviewerApprovalLimit',
      'Reviewer approval limit must be between 1 and 100.',
    )
  }
  return limit
}

/** Reviewer query cursor を scope-bound base64url へ変換します。 */
function encodeReviewerApprovalCursor(
  scopeKey: string,
  lastEvaluatedKey: Record<string, unknown>,
) {
  const recordKey = lastEvaluatedKey.recordKey
  if (typeof recordKey !== 'string') {
    throw new FileProofingError(503, 'ReviewerApprovalCursorUnavailable', 'Reviewer cursor is invalid.')
  }
  return Buffer.from(JSON.stringify({ scopeKey, recordKey }), 'utf8').toString('base64url')
}

/** Reviewer query cursor を検証して DynamoDB key へ戻します。 */
function decodeReviewerApprovalCursor(cursor: string, expectedScopeKey: string) {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (
      typeof value !== 'object' ||
      value === null ||
      !('scopeKey' in value) ||
      value.scopeKey !== expectedScopeKey ||
      !('recordKey' in value) ||
      typeof value.recordKey !== 'string'
    ) {
      throw new Error('Cursor scope or key is invalid.')
    }
    return { scopeKey: expectedScopeKey, recordKey: value.recordKey }
  } catch (error) {
    throw new FileProofingError(
      400,
      'InvalidReviewerApprovalCursor',
      'Reviewer approval cursor is invalid.',
      { cause: error },
    )
  }
}

/** String input の存在を検証します。 */
function requireText(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FileProofingError(400, 'InvalidFileProofingInput', `${label} is required.`)
  }
  return value.trim()
}

/** String input の長さを検証します。 */
function requireLimitedText(value: unknown, label: string, maxLength: number) {
  const text = requireText(value, label)
  if (text.length > maxLength) {
    throw new FileProofingError(400, 'InvalidFileProofingInput', `${label} is too long.`)
  }
  return text
}

/** Positive integer input を検証します。 */
function requirePositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer.`)
  }
  return value
}

/** Approval revision を API domain error として検証します。 */
function requireApprovalRevision(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new FileProofingError(
      400,
      'InvalidFileProofingInput',
      'Approval revision must be a positive integer.',
    )
  }
  return value
}

/** Environment string を trim して取得します。 */
function readEnvironment(name: string) {
  return process.env[name]?.trim() || undefined
}

/** Positive integer environment を取得します。 */
function readPositiveIntegerEnvironment(name: string, fallback: number) {
  const value = Number(readEnvironment(name) ?? fallback)
  return requirePositiveInteger(value, name)
}

/** Local endpoint を含む AWS SDK client 設定を作成します。 */
function createAwsClientConfiguration(endpoint: string | undefined) {
  return {
    region: readEnvironment('AWS_REGION') ?? 'us-east-1',
    ...(endpoint ? { endpoint } : {}),
    ...(endpoint
      ? {
          credentials: {
            accessKeyId: readEnvironment('AWS_ACCESS_KEY_ID') ?? 'test',
            secretAccessKey: readEnvironment('AWS_SECRET_ACCESS_KEY') ?? 'test',
          },
        }
      : {}),
  }
}

/** Timestamp から保持期限 epoch seconds を作成します。 */
function epochSecondsAfterDays(timestamp: string, days: number) {
  return Math.floor(Date.parse(timestamp) / 1_000) + days * 86_400
}

/** DynamoDB conditional transaction error かどうかを判定します。 */
function isConditionalTransactionError(error: unknown) {
  if (
    typeof error !== 'object' || error === null ||
    !('name' in error) || error.name !== 'TransactionCanceledException' ||
    !('CancellationReasons' in error) || !Array.isArray(error.CancellationReasons)
  ) {
    return false
  }
  const reasonCodes = error.CancellationReasons.map((reason) =>
    typeof reason === 'object' && reason !== null &&
      'Code' in reason && typeof reason.Code === 'string'
      ? reason.Code
      : undefined
  )
  if (reasonCodes.some((code) => code === undefined)) {
    return false
  }
  const failureCodes = reasonCodes.filter((code) => code !== 'None')
  return failureCodes.length > 0 &&
    failureCodes.every((code) => code === 'ConditionalCheckFailed')
}

/** DynamoDB single-item conditional write error かどうかを判定します。 */
function isConditionalWriteError(error: unknown) {
  return typeof error === 'object' && error !== null &&
    'name' in error && error.name === 'ConditionalCheckFailedException'
}

/** File item row を判定します。 */
function isStoredFileItem(value: unknown): value is StoredFileItem {
  return typeof value === 'object' && value !== null &&
    'entryType' in value && value.entryType === 'file'
}

/** Annotation item row を判定します。 */
function isStoredAnnotationItem(value: unknown): value is StoredAnnotationItem {
  return typeof value === 'object' && value !== null &&
    'entryType' in value && value.entryType === 'annotation'
}

/** Approval item row を判定します。 */
function isStoredApprovalItem(value: unknown): value is StoredApprovalItem {
  return typeof value === 'object' && value !== null &&
    'entryType' in value && value.entryType === 'approval'
}

/** File approval reverse projection row を判定します。 */
function isStoredFileApprovalIndexItem(value: unknown): value is StoredFileApprovalIndexItem {
  return typeof value === 'object' && value !== null &&
    'entryType' in value && value.entryType === 'file-approval-index'
}

/** Approval summary projection row を判定します。 */
function isStoredApprovalSummaryItem(value: unknown): value is StoredApprovalSummaryItem {
  return typeof value === 'object' && value !== null &&
    'entryType' in value && value.entryType === 'approval-summary' && (
      !('pendingDueAt' in value) || value.pendingDueAt instanceof Set
    )
}

/** Reviewer projection row を判定します。 */
function isStoredReviewerApprovalItem(value: unknown): value is StoredReviewerApprovalItem {
  return typeof value === 'object' && value !== null &&
    'entryType' in value && value.entryType === 'reviewer-approval'
}

/** Local DynamoDB に file metadata table を作成します。 */
async function ensureLocalFileProofingTable(client: DynamoDBClient, tableName: string) {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }))
    return
  } catch (error) {
    if (!isResourceNotFoundError(error)) {
      throw error
    }
  }
  try {
    await client.send(new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'scopeKey', AttributeType: 'S' },
        { AttributeName: 'recordKey', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'scopeKey', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ],
    }))
  } catch (error) {
    if (!isResourceInUseError(error)) {
      throw error
    }
  }
}

/** DynamoDB ResourceNotFoundException を判定します。 */
function isResourceNotFoundError(error: unknown) {
  return typeof error === 'object' && error !== null &&
    'name' in error && error.name === 'ResourceNotFoundException'
}

/** DynamoDB ResourceInUseException を判定します。 */
function isResourceInUseError(error: unknown) {
  return typeof error === 'object' && error !== null &&
    'name' in error && error.name === 'ResourceInUseException'
}
