import type { DocumentCapabilities } from '@mukuroji/contracts'
import type {
  DocumentBacklink,
  DocumentComment,
  DocumentPresence,
  PublicDocument,
  DocumentRecord,
  DocumentShare,
  DocumentSummary,
  DocumentVersion,
} from './api'

/**
 * Storybook と test で使う編集可能 capability です。
 */
export const editableDocumentCapabilities: DocumentCapabilities = {
  canArchive: true,
  canComment: true,
  canEdit: true,
  canExport: true,
  canManagePermissions: true,
  canRestore: true,
  canShare: true,
  canView: true,
}

/**
 * Storybook と test で使う read-only capability です。
 */
export const readOnlyDocumentCapabilities: DocumentCapabilities = {
  canArchive: false,
  canComment: false,
  canEdit: false,
  canExport: true,
  canManagePermissions: false,
  canRestore: false,
  canShare: false,
  canView: true,
}

const commonNodeFields = {
  capabilities: editableDocumentCapabilities,
  childCount: 0,
  createdAt: '2026-07-10T01:00:00.000Z',
  createdByUserId: 'demo-user',
  revision: 1,
  schemaVersion: 1,
  updatedByUserId: 'demo-user',
} as const

/**
 * Workspace と Project scope を含む Document tree fixture です。
 */
export const documentSummaryFixtures: DocumentSummary[] = [
  {
    ...commonNodeFields,
    childCount: 2,
    favorite: true,
    id: 'product-handbook',
    kind: 'folder',
    position: '000010',
    scope: { type: 'workspace' },
    title: 'Product handbook',
    updatedAt: '2026-07-18T08:00:00.000Z',
  },
  {
    ...commonNodeFields,
    favorite: true,
    id: 'product-principles',
    kind: 'page',
    lastOpenedAt: '2026-07-18T09:30:00.000Z',
    parentId: 'product-handbook',
    position: '000010',
    revision: 7,
    scope: { type: 'workspace' },
    title: 'Product principles',
    updatedAt: '2026-07-18T09:20:00.000Z',
  },
  {
    ...commonNodeFields,
    favorite: false,
    id: 'decision-log',
    kind: 'page',
    lastOpenedAt: '2026-07-17T06:00:00.000Z',
    parentId: 'product-handbook',
    position: '000020',
    scope: { type: 'workspace' },
    title: 'Decision log',
    updatedAt: '2026-07-17T06:30:00.000Z',
  },
  {
    ...commonNodeFields,
    favorite: false,
    id: 'weekly-notes-template',
    kind: 'template',
    position: '000030',
    scope: { type: 'workspace' },
    title: 'Weekly meeting notes',
    updatedAt: '2026-07-16T02:00:00.000Z',
  },
  {
    ...commonNodeFields,
    favorite: true,
    id: 'launch-workshop',
    kind: 'whiteboard',
    lastOpenedAt: '2026-07-18T08:50:00.000Z',
    position: '000010',
    revision: 4,
    scope: { projectId: 'refero', type: 'project' },
    title: 'Launch workshop',
    updatedAt: '2026-07-18T09:10:00.000Z',
  },
  {
    ...commonNodeFields,
    archivedAt: '2026-07-12T01:00:00.000Z',
    favorite: false,
    id: 'research-archive',
    kind: 'page',
    position: '000040',
    scope: { type: 'workspace' },
    title: 'Archived research',
    updatedAt: '2026-07-12T01:00:00.000Z',
  },
]

/**
 * すべての typed block を含む Document detail fixture です。
 */
export const documentRecordFixture: DocumentRecord = {
  ...documentSummaryFixtures[1]!,
  blocks: [
    {
      id: 'heading-context',
      level: 2,
      text: 'Context before execution',
      type: 'heading',
    },
    {
      id: 'paragraph-context',
      text: 'Keep the product rationale, constraints, and follow-up work connected in one durable page.',
      type: 'paragraph',
    },
    {
      columns: ['Principle', 'How we apply it'],
      id: 'table-principles',
      rows: [
        {
          cells: [
            { id: 'cell-1', text: 'Quiet progress' },
            { id: 'cell-2', text: 'Show the next decision without visual noise.' },
          ],
          id: 'row-1',
        },
        {
          cells: [
            { id: 'cell-3', text: 'Traceable work' },
            { id: 'cell-4', text: 'Link decisions to Work Items and projects.' },
          ],
          id: 'row-2',
        },
      ],
      type: 'table',
    },
    {
      id: 'checklist-rollout',
      items: [
        { checked: true, id: 'check-1', text: 'Review with design' },
        { checked: false, id: 'check-2', text: 'Confirm rollout owner' },
      ],
      type: 'checklist',
    },
    {
      code: 'const nextStep = decisions.find((item) => !item.resolved)',
      id: 'code-example',
      language: 'typescript',
      type: 'code',
    },
    {
      id: 'embed-work-item',
      provider: 'mukuroji',
      title: 'Launch readiness review',
      type: 'embed',
      url: '/projects/refero/issues?teamId=core-team&issueId=launch-review',
    },
    {
      format: 'text',
      id: 'diagram-flow',
      source: 'Decision → Project → Work Item → Outcome',
      type: 'diagram',
    },
  ],
  kind: 'page',
  permission: { memberGrants: [], mode: 'inherit' },
  relations: [],
}

/**
 * Object、connector、frame、Work Item link を含む Whiteboard fixture です。
 */
export const whiteboardRecordFixture: DocumentRecord = {
  ...documentSummaryFixtures[4]!,
  kind: 'whiteboard',
  permission: { memberGrants: [], mode: 'inherit' },
  relations: [],
  whiteboard: {
    connectors: [
      {
        from: { objectId: 'board-note' },
        id: 'board-connector',
        label: 'creates',
        to: { objectId: 'board-work-item' },
      },
    ],
    frames: [
      {
        bounds: { height: 260, width: 520, x: 60, y: 60 },
        id: 'board-frame',
        objectIds: ['board-note', 'board-work-item'],
        title: 'Launch readiness',
      },
    ],
    objects: [
      {
        bounds: { height: 110, width: 190, x: 110, y: 120 },
        id: 'board-note',
        style: { fill: '#fef3c7' },
        text: 'Clarify the launch decision',
        type: 'note',
        zIndex: 1,
      },
      {
        bounds: { height: 110, width: 210, x: 350, y: 120 },
        id: 'board-work-item',
        style: { fill: '#e5f7f4' },
        type: 'work-item',
        workItemId: 'launch-review',
        zIndex: 2,
      },
    ],
  },
}

/**
 * ACL や member assignment を含まない public page fixture です。
 */
export const publicDocumentFixture: PublicDocument = {
  blocks:
    documentRecordFixture.kind === 'page'
      ? documentRecordFixture.blocks.map((block) =>
          block.type === 'checklist'
            ? {
                ...block,
                items: block.items.map(({ checked, id, text }) => ({
                  checked,
                  id,
                  text,
                })),
              }
            : block,
        )
      : [],
  kind: 'page',
  title: documentRecordFixture.title,
  updatedAt: documentRecordFixture.updatedAt,
}

/**
 * Work Item target ID を含まない public Whiteboard fixture です。
 */
export const publicWhiteboardFixture: PublicDocument = {
  kind: 'whiteboard',
  title: whiteboardRecordFixture.title,
  updatedAt: whiteboardRecordFixture.updatedAt,
  whiteboard: {
    connectors:
      whiteboardRecordFixture.kind === 'whiteboard'
        ? whiteboardRecordFixture.whiteboard.connectors
        : [],
    frames:
      whiteboardRecordFixture.kind === 'whiteboard'
        ? whiteboardRecordFixture.whiteboard.frames
        : [],
    objects:
      whiteboardRecordFixture.kind === 'whiteboard'
        ? whiteboardRecordFixture.whiteboard.objects.map((object) =>
            object.type === 'work-item'
              ? {
                  bounds: object.bounds,
                  id: object.id,
                  ...(object.style ? { style: object.style } : {}),
                  type: object.type,
                  zIndex: object.zIndex,
                }
              : object,
          )
        : [],
  },
}

/**
 * Document comment panel fixture です。
 */
export const documentCommentFixtures: DocumentComment[] = [
  {
    anchor: { blockId: 'paragraph-context', type: 'block' },
    authorUserId: 'sato-user',
    body: '@demo-user 制約の説明をもう一段具体化できますか？',
    createdAt: '2026-07-18T08:20:00.000Z',
    documentId: 'product-principles',
    id: 'comment-context',
    mentions: [{ length: 10, offset: 0, userId: 'demo-user' }],
    resolved: false,
    updatedAt: '2026-07-18T08:20:00.000Z',
  },
  {
    anchor: { type: 'document' },
    authorUserId: 'demo-user',
    body: '次回のレビューで決定ログへ反映します。',
    createdAt: '2026-07-18T08:40:00.000Z',
    documentId: 'product-principles',
    id: 'comment-resolved',
    mentions: [],
    resolved: true,
    resolvedAt: '2026-07-18T09:00:00.000Z',
    resolvedByUserId: 'demo-user',
    updatedAt: '2026-07-18T09:00:00.000Z',
  },
  {
    anchor: { blockId: 'paragraph-context', type: 'block' },
    authorUserId: 'demo-user',
    body: '@sato-user 補足を追記しました。',
    createdAt: '2026-07-18T08:30:00.000Z',
    documentId: 'product-principles',
    id: 'comment-context-reply',
    mentions: [{ length: 11, offset: 0, userId: 'sato-user' }],
    parentCommentId: 'comment-context',
    resolved: false,
    updatedAt: '2026-07-18T08:30:00.000Z',
  },
]

/**
 * Document presence toolbar fixture です。
 */
export const documentPresenceFixtures: DocumentPresence[] = [
  {
    clientId: 'client-sato',
    color: '#0f766e',
    displayName: 'Sato',
    documentId: 'product-principles',
    lastSeenAt: '2026-07-18T09:40:00.000Z',
    selection: {
      anchorOffset: 0,
      blockId: 'paragraph-context',
      focusOffset: 0,
      type: 'text',
    },
    userId: 'sato-user',
  },
  {
    clientId: 'client-suzuki',
    color: '#2563eb',
    displayName: 'Suzuki',
    documentId: 'product-principles',
    lastSeenAt: '2026-07-18T09:40:02.000Z',
    selection: {
      anchorOffset: 0,
      blockId: 'table-principles',
      focusOffset: 0,
      type: 'text',
    },
    userId: 'suzuki-user',
  },
]

/**
 * Document version history fixture です。
 */
export const documentVersionFixtures: DocumentVersion[] = [
  {
    createdAt: '2026-07-18T09:20:00.000Z',
    createdByUserId: 'demo-user',
    documentId: 'product-principles',
    id: 'version-7',
    kind: 'page',
    reason: 'auto-save',
    revision: 7,
    schemaVersion: 1,
    summary: 'Updated principles and rollout checklist',
    title: 'Product principles',
  },
  {
    createdAt: '2026-07-18T08:10:00.000Z',
    createdByUserId: 'sato-user',
    documentId: 'product-principles',
    id: 'version-6',
    kind: 'page',
    reason: 'edit',
    revision: 6,
    schemaVersion: 1,
    summary: 'Added decision flow diagram',
    title: 'Product principles',
  },
  {
    createdAt: '2026-07-17T04:30:00.000Z',
    createdByUserId: 'demo-user',
    documentId: 'product-principles',
    id: 'version-5',
    kind: 'page',
    reason: 'create',
    revision: 5,
    schemaVersion: 1,
    summary: 'Created page from product template',
    title: 'Product principles',
  },
]

/**
 * Member grant と expiring public link の share fixture です。
 */
export const documentShareFixtures: DocumentShare[] = [
  {
    grant: { memberKey: 'guest@example.com', role: 'viewer' },
    type: 'member',
  },
  {
    allowExport: false,
    createdAt: '2026-07-18T07:10:00.000Z',
    createdByUserId: 'demo-user',
    documentId: 'product-principles',
    expiresAt: '2099-07-25T07:10:00.000Z',
    id: 'share-public',
    role: 'viewer',
    type: 'public',
    url: 'https://example.test/share/documents/public-token',
  },
]

/**
 * Document backlink panel fixture です。
 */
export const documentBacklinkFixtures: DocumentBacklink[] = [
  {
    documentId: 'launch-plan',
    documentTitle: 'Launch plan',
    relation: {
      createdAt: '2026-07-18T07:00:00.000Z',
      createdByUserId: 'demo-user',
      id: 'backlink-work-item',
      source: { kind: 'document' },
      target: { kind: 'work-item', workItemId: 'launch-review' },
    },
  },
  {
    documentId: 'project-brief',
    documentTitle: 'Refero project brief',
    relation: {
      createdAt: '2026-07-18T07:10:00.000Z',
      createdByUserId: 'demo-user',
      id: 'backlink-project',
      source: { kind: 'document' },
      target: { kind: 'project', projectId: 'refero' },
    },
  },
]
