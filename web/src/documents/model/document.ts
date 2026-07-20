import {
  DOCUMENT_OPERATION_BATCH_LIMIT,
  type DocumentBlock,
  type DocumentKind,
  type DocumentRelation,
  type DocumentScope,
  type WhiteboardFrame,
} from '@mukuroji/contracts'
import type {
  CreateDocumentShareInput,
  DocumentOperation,
  DocumentOperationSaveResult,
  DocumentRecord,
  DocumentSummary,
  WhiteboardConnector,
  WhiteboardContent,
  WhiteboardObject,
} from '../api'

/**
 * Document tree の一つの再帰 branch です。
 */
export type DocumentTreeBranch = {
  /**
   * Branch に表示する Document node です。
   */
  document: DocumentSummary
  /**
   * 表示順に並んだ子 branch です。
   */
  children: DocumentTreeBranch[]
}

/**
 * Document editor の保存状態です。
 */
export type DocumentSaveStatus =
  | 'idle'
  | 'saving'
  | 'saved'
  | 'conflict'
  | 'error'

/**
 * 画面遷移や破壊的操作の前に Document draft を確定する guard です。
 */
export type DocumentDraftSaveGuard = {
  /**
   * 現在 server へ確定していない変更があるか返します。
   */
  hasUnsavedChanges: () => boolean
  /**
   * Editor が最後に server へ確定した Document revision を返します。
   */
  getCommittedRevision?: () => number
  /**
   * Pending title/operation を保存し、安全に後続操作へ進めるか返します。
   */
  savePendingChanges: () => Promise<boolean>
}

/**
 * Document 単位の mutation を呼び出し順に直列化する queue です。
 */
export type DocumentMutationQueue = {
  /**
   * 一つの mutation を先行 mutation の完了後に実行します。
   */
  <T>(mutation: () => Promise<T>): Promise<T>
}

/**
 * Response loss 後も同じ public link 作成 payload を再送するための pending request
 * です。
 */
export type PendingPublicShareCreateRequest = {
  /**
   * Share を作成する Document ID です。
   */
  documentId: string
  /**
   * Dialog で選択した expiry 日数です。
   */
  expiresInDays: number
  /**
   * Public export を許可するかどうかです。
   */
  allowExport: boolean
  /**
   * 初回試行時に絶対 expiry を固定した API input です。
   */
  input: Extract<CreateDocumentShareInput, { type: 'public' }>
  /**
   * Mutation request context を再利用する logical fingerprint です。
   */
  fingerprint: string
}

/**
 * 同じ public share intent の retry では初回の絶対 expiry と fingerprint を再利用します。
 *
 * @param previous - 直前に失敗した public share request です。
 * @param documentId - Share 対象 Document ID です。
 * @param expiresInDays - Dialog で選択した expiry 日数です。
 * @param allowExport - Public export を許可するかどうかです。
 * @param nowEpochMs - 新規 request の expiry を計算する clock です。
 * @returns 再利用または新規作成した pending request です。
 */
export function resolvePendingPublicShareCreateRequest(
  previous: PendingPublicShareCreateRequest | undefined,
  documentId: string,
  expiresInDays: number,
  allowExport: boolean,
  nowEpochMs = Date.now(),
): PendingPublicShareCreateRequest {
  if (
    previous?.documentId === documentId &&
    previous.expiresInDays === expiresInDays &&
    previous.allowExport === allowExport
  ) {
    return previous
  }

  const input = {
    allowExport,
    expiresAt: new Date(
      nowEpochMs + expiresInDays * 24 * 60 * 60 * 1_000,
    ).toISOString(),
    type: 'public' as const,
  }

  return {
    allowExport,
    documentId,
    expiresInDays,
    fingerprint: JSON.stringify({
      allowExport,
      expiresInDays,
      type: 'public',
    }),
    input,
  }
}

/**
 * Operation chunk の途中保存に失敗したとき、未送信 operation を保持する
 * error です。
 */
export class DocumentOperationChunkSaveError extends Error {
  /**
   * 保存に失敗した chunk と、それ以降の未送信 operation です。
   */
  readonly remainingOperations: DocumentOperation[]
  /**
   * 失敗前に最後まで保存できた Document です。
   */
  readonly lastSavedDocument?: DocumentRecord
  /**
   * 失敗前に最後まで確定した operation POST の正確な revision です。
   */
  readonly lastCommittedRevision?: number
  /**
   * Chunk callback が返した元 error です。
   */
  readonly originalError: unknown

  /**
   * Partial save の復旧情報を持つ error を作成します。
   *
   * @param originalError - Chunk callback が返した元 error です。
   * @param remainingOperations - 再試行が必要な operation です。
   * @param lastSavedResult - 失敗前に最後まで保存できた operation 結果です。
   */
  constructor(
    originalError: unknown,
    remainingOperations: readonly DocumentOperation[],
    lastSavedResult?: DocumentOperationSaveResult,
  ) {
    super(
      originalError instanceof Error
        ? originalError.message
        : 'Unable to save document operations.',
    )
    this.name = 'DocumentOperationChunkSaveError'
    this.originalError = originalError
    this.remainingOperations = [...remainingOperations]
    this.lastSavedDocument = lastSavedResult?.document
    this.lastCommittedRevision =
      lastSavedResult?.committedRevision
  }
}

/**
 * Polling で到着した Document detail を editor が採用できる状態です。
 */
export type DocumentAdoptionState = {
  /**
   * Blur 前の未保存 title edit があるかどうかです。
   */
  hasDirtyTitle?: boolean
  /**
   * まだ server へ確定していない operation 数です。
   */
  pendingOperationCount: number
  /**
   * 現在 editor が表示する保存状態です。
   */
  saveStatus: DocumentSaveStatus
  /**
   * Polling で到着した detail の revision です。
   */
  incomingRevision: number
  /**
   * Editor が最後に確定した revision です。
   */
  localRevision: number
}

/**
 * Concurrent polling detail が未保存 local edit を上書きしないか判定します。
 *
 * @param state - Pending operation、save status、revision の snapshot です。
 * @returns Incoming detail を安全に採用できる場合は true です。
 */
export function shouldAdoptIncomingDocument(
  state: DocumentAdoptionState,
) {
  return (
    !state.hasDirtyTitle &&
    state.pendingOperationCount === 0 &&
    (state.saveStatus === 'idle' || state.saveStatus === 'saved') &&
    state.incomingRevision >= state.localRevision
  )
}

/**
 * 新しい local edit が既存 conflict batch を暗黙に再送してよいか判定します。
 *
 * @param saveStatus - 現在の editor save state です。
 * @returns Explicit overwrite confirmation が必要な conflict 以外は true です。
 */
export function shouldScheduleDocumentAutosave(
  saveStatus: DocumentSaveStatus,
) {
  return saveStatus !== 'conflict' && saveStatus !== 'error'
}

/**
 * Title commit 開始後に入力値が変わっていないか判定します。
 *
 * @param savedGeneration - Commit 開始時の title generation です。
 * @param currentGeneration - 現在の title generation です。
 * @returns 同じ入力値をまだ表示している場合は true です。
 */
export function isDocumentTitleCommitCurrent(
  savedGeneration: number,
  currentGeneration: number,
) {
  return savedGeneration === currentGeneration
}

/**
 * 入力 title が canonical title と異なるか、別 title の commit 中か判定します。
 *
 * @param inputTitle - 現在 input に表示している title です。
 * @param committedTitle - 最後に server で確定した title です。
 * @param hasActiveCommit - 先行 title commit が完了していないかどうかです。
 * @returns 後続 commit が必要な場合は true です。
 */
export function isDocumentTitleDirty(
  inputTitle: string,
  committedTitle: string,
  hasActiveCommit: boolean,
) {
  return hasActiveCommit || inputTitle !== committedTitle
}

/**
 * Cache 側と draft flush 側のうち新しい Document revision を後続 mutation に使います。
 *
 * @param cachedRevision - 呼び出し元 render が保持する Document revision です。
 * @param flushedRevision - Draft guard が保存後に保持する Document revision です。
 * @returns 後続 mutation が基準にする最新 revision です。
 */
export function resolveDocumentMutationRevision(
  cachedRevision: number,
  flushedRevision?: number,
) {
  return Math.max(
    cachedRevision,
    flushedRevision ?? cachedRevision,
  )
}

/**
 * Title commit と operation flush の途中で追加された変更も含め、pending
 * 状態が空になるまで single-flight save を繰り返します。
 *
 * @param controller - Editor 内の現在値と save callbacks です。
 * @returns 全変更を保存できた場合は true、競合または失敗時は false です。
 */
export async function saveAllPendingDocumentChanges(controller: {
  getActiveOperationFlush: () => Promise<boolean> | undefined
  getActiveTitleCommit: () => Promise<boolean> | undefined
  getSaveStatus: () => DocumentSaveStatus
  hasDirtyTitle: () => boolean
  hasPendingOperations: () => boolean
  commitTitle: () => Promise<boolean>
  flushOperations: () => Promise<boolean>
}) {
  while (true) {
    const saveStatus = controller.getSaveStatus()
    if (saveStatus === 'conflict' || saveStatus === 'error') {
      return false
    }
    const activeTitleCommit = controller.getActiveTitleCommit()
    if (activeTitleCommit) {
      if (!(await activeTitleCommit)) return false
      continue
    }
    if (controller.hasDirtyTitle()) {
      if (!(await controller.commitTitle())) return false
      continue
    }
    const activeOperationFlush =
      controller.getActiveOperationFlush()
    if (activeOperationFlush) {
      if (!(await activeOperationFlush)) return false
      continue
    }
    if (controller.hasPendingOperations()) {
      if (!(await controller.flushOperations())) return false
      continue
    }
    return true
  }
}

/**
 * Pending operation を API 上限ずつ保存し、各 response revision を
 * 次 chunk の base revision へ連鎖させます。
 *
 * @param operations - 保存順を維持する pending operation です。
 * @param baseRevision - 最初の chunk が基準にする revision です。
 * @param saveChunk - 一つの chunk を保存する callback です。
 * @returns 最後に保存された operation 結果、または空入力なら undefined です。
 * @throws {DocumentOperationChunkSaveError} 途中失敗時に未送信 operation を保持します。
 */
export async function saveDocumentOperationChunks(
  operations: readonly DocumentOperation[],
  baseRevision: number,
  saveChunk: (
    revision: number,
    chunk: DocumentOperation[],
  ) => Promise<DocumentOperationSaveResult>,
) {
  let revision = baseRevision
  let lastSavedResult: DocumentOperationSaveResult | undefined

  for (
    let index = 0;
    index < operations.length;
    index += DOCUMENT_OPERATION_BATCH_LIMIT
  ) {
    const chunk = operations.slice(
      index,
      index + DOCUMENT_OPERATION_BATCH_LIMIT,
    )
    try {
      lastSavedResult = await saveChunk(revision, chunk)
      revision = lastSavedResult.committedRevision
    } catch (error) {
      throw new DocumentOperationChunkSaveError(
        error,
        operations.slice(index),
        lastSavedResult,
      )
    }
  }

  return lastSavedResult
}

/**
 * Operation chunk failure 後に、部分成功または response loss を含む server state を
 * cache へ再反映します。
 *
 * @param error - Partial save 情報を保持する operation error です。
 * @param operations - 保存を試みた全 operation です。
 * @param callbacks - Detail、collection、version、backlink cache の更新 callback です。
 */
export async function refreshDocumentOperationCachesAfterFailure(
  error: DocumentOperationChunkSaveError,
  operations: readonly DocumentOperation[],
  callbacks: {
    refreshSelectedDocument?: (
      document?: DocumentRecord,
    ) => Promise<unknown>
    refreshDocuments: () => Promise<unknown>
    refreshVersions: () => Promise<unknown>
    refreshBacklinks?: () => Promise<unknown>
  },
) {
  const refreshes = [
    Promise.resolve().then(callbacks.refreshDocuments),
    Promise.resolve().then(callbacks.refreshVersions),
  ]
  if (callbacks.refreshSelectedDocument) {
    refreshes.push(
      Promise.resolve().then(() =>
        callbacks.refreshSelectedDocument!(
          error.lastSavedDocument,
        )
      ),
    )
  }
  if (
    callbacks.refreshBacklinks &&
    changesDocumentBacklinks(operations)
  ) {
    refreshes.push(
      Promise.resolve().then(callbacks.refreshBacklinks),
    )
  }
  await Promise.allSettled(refreshes)
}

/**
 * 未保存 draft があれば保存完了を待ち、失敗時は後続 action を実行しません。
 *
 * @param guard - 現在の editor draft guard です。
 * @param action - Draft 保存後にだけ実行する action です。
 * @returns Action を実行できた場合は true、保存失敗時は false です。
 */
export async function runAfterSavingDocumentDraft(
  guard: DocumentDraftSaveGuard | undefined,
  action: () => void | Promise<void>,
) {
  if (
    guard?.hasUnsavedChanges() &&
    !(await guard.savePendingChanges())
  ) {
    return false
  }

  await action()
  return true
}

/**
 * Reject された mutation の後も停止せず、Document mutation を厳密な FIFO で
 * 実行する queue を作成します。
 *
 * @returns Document mutation を直列化する enqueue 関数です。
 */
export function createDocumentMutationQueue(): DocumentMutationQueue {
  let tail: Promise<unknown> = Promise.resolve()

  return <T,>(mutation: () => Promise<T>) => {
    const queued = tail.then(mutation, mutation)
    tail = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }
}

/**
 * Flat Document node 一覧を parent/position に従う tree へ変換します。
 *
 * 存在しない親や folder ではない親を参照する node は scope root へ戻し、
 * parent cycle は切断して UI の再帰を安全に保ちます。
 *
 * @param documents - Permission filter 済み Document node 一覧です。
 * @param scope - 表示対象の Workspace または Project scope です。
 * @returns 表示順に並んだ tree roots です。
 */
export function buildDocumentTree(
  documents: readonly DocumentSummary[],
  scope: DocumentScope,
) {
  const scopedDocuments = documents.filter(
    (document) => isSameDocumentScope(document.scope, scope),
  )
  const documentsById = new Map(
    scopedDocuments.map((document) => [document.id, document]),
  )
  const childrenByParentId = new Map<string | undefined, DocumentSummary[]>()

  for (const document of scopedDocuments) {
    const parent = document.parentId
      ? documentsById.get(document.parentId)
      : undefined
    const safeParentId =
      parent?.kind === 'folder' &&
      !createsDocumentCycle(document.id, parent.id, documentsById)
        ? parent.id
        : undefined
    const siblings = childrenByParentId.get(safeParentId) ?? []
    siblings.push(document)
    childrenByParentId.set(safeParentId, siblings)
  }

  for (const siblings of childrenByParentId.values()) {
    siblings.sort(compareDocumentPosition)
  }

  const buildBranch = (
    document: DocumentSummary,
    ancestors: ReadonlySet<string>,
  ): DocumentTreeBranch => {
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(document.id)
    const children = (childrenByParentId.get(document.id) ?? [])
      .filter((child) => !nextAncestors.has(child.id))
      .map((child) => buildBranch(child, nextAncestors))

    return { children, document }
  }

  return (childrenByParentId.get(undefined) ?? []).map((document) =>
    buildBranch(document, new Set()),
  )
}

/**
 * Explicit relation と Whiteboard Work Item card から同じ target を最初の
 * 出現順で一つにまとめます。
 *
 * @param relations - Document に保存された relation 一覧です。
 * @param whiteboardObjects - Whiteboard に保存された object 一覧です。
 * @returns Backlink API を一度ずつ呼ぶ canonical target 一覧です。
 */
export function deduplicateDocumentRelationTargets(
  relations: readonly DocumentRelation[],
  whiteboardObjects: readonly WhiteboardObject[] = [],
): DocumentRelation['target'][] {
  const targets = new Map<string, DocumentRelation['target']>()

  const candidates: DocumentRelation['target'][] = [
    ...relations.map(({ target }) => target),
    ...whiteboardObjects.flatMap(
      (object): DocumentRelation['target'][] =>
        object.type === 'work-item'
          ? [{
              kind: 'work-item',
              workItemId: object.workItemId,
            }]
          : [],
    ),
  ]
  for (const target of candidates) {
    const key =
      target.kind === 'work-item'
        ? `work-item:${target.workItemId}`
        : target.kind === 'project'
          ? `project:${target.projectId}`
          : `goal:${target.goalId}`
    if (!targets.has(key)) {
      targets.set(key, target)
    }
  }

  return [...targets.values()]
}

/**
 * Operation batch が explicit/system backlink index を変更し得るか判定します。
 *
 * @param operations - 保存する canonical Document operations です。
 * @returns Relation、Work Item card、relation source の変更を含む場合は true です。
 */
export function changesDocumentBacklinks(
  operations: readonly DocumentOperation[],
): boolean {
  return operations.some(
    ({ type }) =>
      type === 'upsert-relation' ||
      type === 'delete-relation' ||
      type === 'insert-object' ||
      type === 'update-object' ||
      type === 'delete-object' ||
      type === 'delete-block',
  )
}

/**
 * Document operation を現在の local record へ決定的に適用します。
 *
 * @param document - Operation 適用前の Document record です。
 * @param operations - Server へ送信する順序付き operation 一覧です。
 * @returns Operation 適用後の新しい Document record です。
 */
export function applyDocumentOperationsLocally(
  document: DocumentRecord,
  operations: readonly DocumentOperation[],
) {
  let relations = [...document.relations]
  let blocks =
    document.kind === 'page' || document.kind === 'template'
      ? [...document.blocks]
      : []
  let whiteboard =
    document.kind === 'whiteboard'
      ? normalizeWhiteboard(document.whiteboard)
      : normalizeWhiteboard(undefined)

  for (const operation of operations) {
    if (operation.type === 'insert-block') {
      blocks.splice(
        clampIndex(operation.index, blocks.length),
        0,
        operation.block,
      )
      continue
    }

    if (operation.type === 'update-block') {
      const existingIndex = blocks.findIndex(
        (block) => block.id === operation.blockId,
      )
      if (existingIndex >= 0) {
        blocks[existingIndex] = operation.block
      }
      continue
    }

    if (operation.type === 'delete-block') {
      blocks = blocks.filter((block) => block.id !== operation.blockId)
      continue
    }

    if (operation.type === 'move-block') {
      const currentIndex = blocks.findIndex(
        (block) => block.id === operation.blockId,
      )
      if (currentIndex >= 0) {
        const [block] = blocks.splice(currentIndex, 1)
        if (block) {
          blocks.splice(clampIndex(operation.index, blocks.length), 0, block)
        }
      }
      continue
    }

    if (
      operation.type === 'insert-object' ||
      operation.type === 'update-object'
    ) {
      whiteboard = {
        ...whiteboard,
        objects: upsertById(whiteboard.objects, operation.object),
      }
      continue
    }

    if (operation.type === 'delete-object') {
      whiteboard = {
        ...whiteboard,
        connectors: whiteboard.connectors.filter(
          (connector) =>
            connector.from.objectId !== operation.objectId &&
            connector.to.objectId !== operation.objectId,
        ),
        frames: whiteboard.frames.map((frame) => ({
          ...frame,
          objectIds: frame.objectIds.filter(
            (objectId) => objectId !== operation.objectId,
          ),
        })),
        objects: whiteboard.objects.filter(
          (object) => object.id !== operation.objectId,
        ),
      }
      continue
    }

    if (operation.type === 'upsert-connector') {
      const objectIds = new Set(whiteboard.objects.map((object) => object.id))
      if (
        objectIds.has(operation.connector.from.objectId) &&
        objectIds.has(operation.connector.to.objectId)
      ) {
        whiteboard = {
          ...whiteboard,
          connectors: upsertById(
            whiteboard.connectors,
            operation.connector,
          ),
        }
      }
      continue
    }

    if (operation.type === 'delete-connector') {
      whiteboard = {
        ...whiteboard,
        connectors: whiteboard.connectors.filter(
          (connector) => connector.id !== operation.connectorId,
        ),
      }
      continue
    }

    if (operation.type === 'upsert-frame') {
      whiteboard = {
        ...whiteboard,
        frames: upsertById(whiteboard.frames, operation.frame),
      }
      continue
    }

    if (operation.type === 'delete-frame') {
      whiteboard = {
        ...whiteboard,
        frames: whiteboard.frames.filter(
          (frame) => frame.id !== operation.frameId,
        ),
      }
      continue
    }

    if (operation.type === 'upsert-relation') {
      relations = upsertById(relations, operation.relation)
      continue
    }

    if (operation.type === 'delete-relation') {
      relations = relations.filter(
        (relation) => relation.id !== operation.relationId,
      )
    }
  }

  if (document.kind === 'page' || document.kind === 'template') {
    return { ...document, blocks, relations }
  }

  if (document.kind === 'whiteboard') {
    return { ...document, relations, whiteboard }
  }

  return { ...document, relations }
}

/**
 * 新規追加する typed block の初期値を作成します。
 *
 * @param type - 追加する block 種別です。
 * @returns 一意な ID を持つ空 block です。
 */
export function createDocumentBlock(type: DocumentBlock['type']): DocumentBlock {
  const id = createDocumentClientId(`block-${type}`)

  if (type === 'heading') {
    return { id, level: 2, text: '', type }
  }

  if (type === 'table') {
    return {
      columns: ['Column 1', 'Column 2'],
      id,
      rows: [
        {
          cells: [
            { id: createDocumentClientId('cell'), text: '' },
            { id: createDocumentClientId('cell'), text: '' },
          ],
          id: createDocumentClientId('row'),
        },
      ],
      type,
    }
  }

  if (type === 'code') {
    return { code: '', id, language: 'text', type }
  }

  if (type === 'checklist') {
    return {
      id,
      items: [
        {
          checked: false,
          id: createDocumentClientId('check'),
          text: '',
        },
      ],
      type,
    }
  }

  if (type === 'embed') {
    return { id, title: '', type, url: '' }
  }

  if (type === 'diagram') {
    return { format: 'text', id, source: '', type }
  }

  return { id, text: '', type: 'paragraph' }
}

/**
 * Whiteboard toolbar から追加する object を作成します。
 *
 * @param type - Object の描画種別です。
 * @param offset - 重なりを避けるための追加順 offset です。
 * @returns 初期位置と表示内容を持つ object です。
 */
export function createWhiteboardObject(
  type: WhiteboardObject['type'],
  offset = 0,
): WhiteboardObject {
  const bounds = {
    height: 100,
    width: 180,
    x: 80 + (offset % 6) * 36,
    y: 80 + (offset % 5) * 32,
  }
  const base = {
    bounds,
    id: createDocumentClientId(`whiteboard-${type}`),
    zIndex: offset,
  }

  if (type === 'note') {
    return {
      ...base,
      style: { fill: '#fef3c7' },
      text: 'New note',
      type,
    }
  }

  if (type === 'work-item') {
    return {
      ...base,
      style: { fill: '#e5f7f4' },
      type,
      workItemId: '',
    }
  }

  if (type === 'shape') {
    return {
      ...base,
      shape: 'rectangle',
      style: { fill: '#dbeafe' },
      text: 'Shape',
      type,
    }
  }

  return {
    ...base,
    style: { fill: '#ffffff' },
    text: 'Text',
    type,
  }
}

/**
 * Whiteboard toolbar から追加する frame を作成します。
 *
 * @param offset - 重なりを避けるための追加順 offset です。
 * @returns 初期矩形と title を持つ frame です。
 */
export function createWhiteboardFrame(offset = 0): WhiteboardFrame {
  return {
    bounds: {
      height: 240,
      width: 360,
      x: 54 + (offset % 5) * 34,
      y: 54 + (offset % 4) * 30,
    },
    id: createDocumentClientId('whiteboard-frame'),
    objectIds: [],
    title: 'Frame',
  }
}

/**
 * 二つの Whiteboard object を結ぶ connector を作成します。
 *
 * @param fromObjectId - 始点 object ID です。
 * @param toObjectId - 終点 object ID です。
 * @returns 新しい connector です。
 */
export function createWhiteboardConnector(
  fromObjectId: string,
  toObjectId: string,
): WhiteboardConnector {
  return {
    from: { objectId: fromObjectId },
    id: createDocumentClientId('connector'),
    to: { objectId: toObjectId },
  }
}

/**
 * Autosave operation の idempotency key を生成します。
 *
 * @returns Editor instance 内で一意な operation ID です。
 */
export function createDocumentOperationId() {
  return createDocumentClientId('operation')
}

/**
 * Embed card で開いてよい URL を検証します。
 *
 * Same-origin relative path と HTTPS URL のみを許可し、javascript/data/http
 * scheme を拒否します。
 *
 * @param value - User が入力した URL です。
 * @param origin - Relative path の解決に使う application origin です。
 * @returns 安全な場合の絶対 URL、危険または不正な場合は undefined です。
 */
export function resolveSafeEmbedUrl(
  value: string,
  origin = globalThis.location?.origin ?? 'http://localhost',
) {
  const trimmedValue = value.trim()
  if (!trimmedValue) {
    return undefined
  }

  try {
    const parsed = new URL(trimmedValue, origin)
    const isSameOrigin = parsed.origin === origin
    const isSecureExternal = parsed.protocol === 'https:'

    return isSameOrigin || isSecureExternal ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

/**
 * Document kind に応じた初期 title を返します。
 *
 * @param kind - 作成対象の Document kind です。
 * @param labels - 各 kind の翻訳済み label です。
 * @returns 新規 node title です。
 */
export function createDefaultDocumentTitle(
  kind: DocumentKind,
  labels: Record<DocumentKind, string>,
) {
  return labels[kind]
}

function normalizeWhiteboard(
  whiteboard: WhiteboardContent | undefined,
): WhiteboardContent {
  return whiteboard ?? { connectors: [], frames: [], objects: [] }
}

function upsertById<TValue extends { id: string }>(
  values: readonly TValue[],
  value: TValue,
) {
  const existingIndex = values.findIndex((candidate) => candidate.id === value.id)
  if (existingIndex < 0) {
    return [...values, value]
  }

  const nextValues = [...values]
  nextValues[existingIndex] = value
  return nextValues
}

function createsDocumentCycle(
  documentId: string,
  parentId: string,
  documentsById: ReadonlyMap<string, DocumentSummary>,
) {
  const visited = new Set<string>([documentId])
  let currentId: string | undefined = parentId

  while (currentId) {
    if (visited.has(currentId)) {
      return true
    }

    visited.add(currentId)
    currentId = documentsById.get(currentId)?.parentId
  }

  return false
}

function isSameDocumentScope(left: DocumentScope, right: DocumentScope) {
  return (
    left.type === right.type &&
    (left.type === 'workspace' ||
      (right.type === 'project' && left.projectId === right.projectId))
  )
}

function compareDocumentPosition(
  left: DocumentSummary,
  right: DocumentSummary,
) {
  return (
    left.position.localeCompare(right.position) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
  )
}

function clampIndex(value: number, length: number) {
  return Math.max(0, Math.min(length, Math.trunc(value)))
}

function createDocumentClientId(prefix: string) {
  const randomValue =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${randomValue}`
}
