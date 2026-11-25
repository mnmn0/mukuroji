import type {
  ApprovalRequest,
  FileAnnotation,
  FileAttachment,
  ProjectDeliverable,
} from '@mukuroji/contracts'
import type { FileArtifactsController } from './mutations/useFileArtifacts'
import type { ProjectDeliverablesController } from './queries/useProjectDeliverables'

/**
 * Storybook と unit test で共有する image file fixture です。
 */
export const imageFileFixture = {
  id: 'file-launch-hero',
  name: 'launch-hero.png',
  targetType: 'work-item',
  targetId: 'onboarding-friction',
  versionCount: 2,
  versions: [
    {
      id: 'version-image-2',
      number: 2,
      fileName: 'launch-hero.png',
      contentType: 'image/png',
      sizeBytes: 2_480_000,
      scanStatus: 'available',
      previewKind: 'image',
      createdByMemberKey: 'demo@example.com',
      createdAt: '2026-07-12T02:00:00.000Z',
      verifiedAt: '2026-07-12T02:00:05.000Z',
    },
    {
      id: 'version-image-1',
      number: 1,
      fileName: 'launch-hero-draft.png',
      contentType: 'image/png',
      sizeBytes: 2_120_000,
      scanStatus: 'available',
      previewKind: 'image',
      createdByMemberKey: 'sato@example.com',
      createdAt: '2026-07-11T02:00:00.000Z',
      verifiedAt: '2026-07-11T02:00:05.000Z',
    },
  ],
  currentVersion: {
    id: 'version-image-2',
    number: 2,
    fileName: 'launch-hero.png',
    contentType: 'image/png',
    sizeBytes: 2_480_000,
    scanStatus: 'available',
    previewKind: 'image',
    createdByMemberKey: 'demo@example.com',
    createdAt: '2026-07-12T02:00:00.000Z',
    verifiedAt: '2026-07-12T02:00:05.000Z',
  },
  createdAt: '2026-07-11T02:00:00.000Z',
  updatedAt: '2026-07-12T02:00:00.000Z',
  capabilities: {
    canAnnotate: true,
    canDelete: true,
    canDownload: true,
    canRequestApproval: true,
    canUploadVersion: true,
  },
} satisfies FileAttachment

/**
 * Scan 中状態を確認する PDF fixture です。
 */
export const scanningPdfFileFixture = {
  ...imageFileFixture,
  id: 'file-launch-brief',
  name: 'launch-brief.pdf',
  versionCount: 1,
  versions: [
    {
      ...imageFileFixture.currentVersion,
      id: 'version-pdf-1',
      number: 1,
      fileName: 'launch-brief.pdf',
      contentType: 'application/pdf',
      previewKind: 'pdf',
      scanStatus: 'scanning',
    },
  ],
  currentVersion: {
    ...imageFileFixture.currentVersion,
    id: 'version-pdf-1',
    number: 1,
    fileName: 'launch-brief.pdf',
    contentType: 'application/pdf',
    previewKind: 'pdf',
    scanStatus: 'scanning',
  },
} satisfies FileAttachment

/**
 * Virus scan で block された video fixture です。
 */
export const blockedVideoFileFixture = {
  ...imageFileFixture,
  id: 'file-walkthrough',
  name: 'walkthrough.mp4',
  versionCount: 1,
  versions: [
    {
      ...imageFileFixture.currentVersion,
      id: 'version-video-1',
      number: 1,
      fileName: 'walkthrough.mp4',
      contentType: 'video/mp4',
      previewKind: 'video',
      scanStatus: 'blocked',
    },
  ],
  currentVersion: {
    ...imageFileFixture.currentVersion,
    id: 'version-video-1',
    number: 1,
    fileName: 'walkthrough.mp4',
    contentType: 'video/mp4',
    previewKind: 'video',
    scanStatus: 'blocked',
  },
  capabilities: {
    ...imageFileFixture.capabilities,
    canAnnotate: false,
    canDownload: false,
    canRequestApproval: false,
  },
} satisfies FileAttachment

/**
 * 画像 preview 上の位置 annotation fixture です。
 */
export const fileAnnotationFixtures = [
  {
    id: 'annotation-1',
    fileId: imageFileFixture.id,
    versionId: imageFileFixture.currentVersion.id,
    anchor: { kind: 'image', x: 0.42, y: 0.34 },
    bodyMarkdown: '**CTA** のコントラストを最終確認してください。',
    authorMemberKey: 'sato@example.com',
    createdAt: '2026-07-12T02:10:00.000Z',
    capabilities: { canResolve: true, canDelete: false },
  },
  {
    id: 'annotation-2',
    fileId: imageFileFixture.id,
    versionId: imageFileFixture.currentVersion.id,
    anchor: { kind: 'image', x: 0.7, y: 0.62 },
    bodyMarkdown: '余白を 8px 広げました。',
    authorMemberKey: 'demo@example.com',
    createdAt: '2026-07-12T02:12:00.000Z',
    resolvedAt: '2026-07-12T02:40:00.000Z',
    resolvedByMemberKey: 'sato@example.com',
    capabilities: { canResolve: true, canDelete: true },
  },
] satisfies FileAnnotation[]

/**
 * 判断待ち approval request fixture です。
 */
export const approvalRequestFixture = {
  id: 'approval-launch-hero',
  subjectType: 'file-version',
  revision: 1,
  fileId: imageFileFixture.id,
  versionId: imageFileFixture.currentVersion.id,
  status: 'pending',
  reviewers: [
    { memberKey: 'demo@example.com', status: 'pending' },
    { memberKey: 'sato@example.com', status: 'approved', decidedAt: '2026-07-12T02:20:00.000Z' },
  ],
  dueAt: '2026-07-15T14:59:59.000Z',
  requestedByMemberKey: 'sato@example.com',
  requestedByKind: 'member',
  createdAt: '2026-07-12T02:15:00.000Z',
  updatedAt: '2026-07-12T02:20:00.000Z',
  unresolvedAnnotationCount: 1,
  capabilities: { canCancel: false, canDecide: true },
} satisfies ApprovalRequest

/**
 * API に接続せず file UI を操作できる Storybook controller です。
 */
export const fileArtifactsControllerFixture = {
  scope: { kind: 'work-item', teamId: 'core-team', issueId: 'onboarding-friction' },
  files: [imageFileFixture, scanningPdfFileFixture, blockedVideoFileFixture],
  approvals: [approvalRequestFixture],
  capabilities: { canGrantGuestAccess: true, canRequestApproval: true, canUpload: true },
  isLoading: false,
  isMutating: false,
  hasLoadError: false,
  uploadFiles: async () => true,
  getVersionAccess: async () => ({
    expiresAt: '2026-07-12T03:00:00.000Z',
    url: '/assets/hero.png',
  }),
  getAnnotations: async () => fileAnnotationFixtures,
  createAnnotation: async (_file, version, input) => ({
    id: 'annotation-new',
    fileId: imageFileFixture.id,
    versionId: version.id,
    anchor: input.anchor,
    bodyMarkdown: input.bodyMarkdown,
    authorMemberKey: 'demo@example.com',
    createdAt: '2026-07-12T02:30:00.000Z',
    capabilities: { canResolve: true, canDelete: true },
  }),
  setAnnotationResolution: async (_file, _version, annotation, resolved) => resolved
    ? {
        ...annotation,
        resolvedAt: '2026-07-12T02:45:00.000Z',
        resolvedByMemberKey: 'demo@example.com',
      }
    : { ...annotation, resolvedAt: undefined, resolvedByMemberKey: undefined },
  deleteAnnotation: async () => true,
  requestApproval: async () => true,
  decideApproval: async () => true,
  cancelApproval: async () => true,
  deleteFile: async () => true,
  refresh: async () => undefined,
} satisfies FileArtifactsController

/**
 * Project 成果物一覧の Storybook と unit test で共有する行です。
 */
export const projectDeliverableFixtures = [
  {
    file: { ...imageFileFixture, unresolvedAnnotationCount: 1 },
    owner: {
      kind: 'work-item',
      teamId: 'core-team',
      issueId: 'onboarding-friction',
      key: 'CORE-12',
      title: '初回オンボーディングの離脱要因を減らす',
    },
    approvalState: 'pending',
    approvalId: approvalRequestFixture.id,
    unresolvedAnnotationCount: 1,
  },
  {
    file: {
      ...scanningPdfFileFixture,
      id: 'file-project-plan',
      name: 'project-plan.pdf',
      targetType: 'project',
      targetId: 'refero',
      currentVersion: { ...scanningPdfFileFixture.currentVersion, scanStatus: 'available' },
      unresolvedAnnotationCount: 0,
    },
    owner: { kind: 'project', teamId: 'core-team', projectId: 'refero' },
    approvalState: 'approved',
    approvalId: 'approval-project-plan',
    unresolvedAnnotationCount: 0,
  },
  {
    file: { ...blockedVideoFileFixture, unresolvedAnnotationCount: 0 },
    owner: {
      kind: 'work-item',
      teamId: 'core-team',
      issueId: 'walkthrough',
      title: 'Walkthrough video',
    },
    approvalState: 'none',
    unresolvedAnnotationCount: 0,
  },
] satisfies ProjectDeliverable[]

/**
 * API に接続せず Project 成果物一覧を表示できる controller です。
 */
export const projectDeliverablesControllerFixture = {
  deliverables: projectDeliverableFixtures,
  filters: { approval: 'all', unresolvedOnly: false },
  setFilters: () => undefined,
  isScoped: true,
  isLoading: false,
  isLoadingMore: false,
  hasError: false,
  hasMore: true,
  loadMore: () => undefined,
  refresh: async () => undefined,
  loadAll: async () => projectDeliverableFixtures,
} satisfies ProjectDeliverablesController
