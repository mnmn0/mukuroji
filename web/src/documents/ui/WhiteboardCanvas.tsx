import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import type {
  PublicWhiteboardContent,
  WhiteboardFrame,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import { createWorkItemSearchPath } from '../../shared/routing/paths'
import type {
  WhiteboardConnector,
  WhiteboardContent,
  WhiteboardObject,
} from '../api'
import {
  createWhiteboardConnector,
  createWhiteboardFrame,
  createWhiteboardObject,
} from '../model/document'
import {
  createCanonicalWorkItemId,
  parseCanonicalWorkItemId,
} from '../model/relations'
import { moveWhiteboardObjectWithinCanvas } from '../model/whiteboardGeometry'

/**
 * Interactive Whiteboard canvas の props です。
 */
export type WhiteboardCanvasProps = {
  /**
   * API から取得した Whiteboard content です。
   */
  content: WhiteboardContent
  /**
   * API capability に基づく編集可否です。
   */
  editable: boolean
  /**
   * 表示文言を解決する翻訳関数です。
   */
  t: (key: MessageKey) => string
  /**
   * Object 作成/移動/更新 callback です。
   */
  onUpsertObject: (object: WhiteboardObject) => void
  /**
   * Object 削除 callback です。
   */
  onDeleteObject: (objectId: string) => void
  /**
   * Connector 作成/更新 callback です。
   */
  onUpsertConnector: (connector: WhiteboardConnector) => void
  /**
   * Connector 削除 callback です。
   */
  onDeleteConnector: (connectorId: string) => void
  /**
   * Frame 作成/更新 callback です。
   */
  onUpsertFrame: (frame: WhiteboardFrame) => void
  /**
   * Frame 削除 callback です。
   */
  onDeleteFrame: (frameId: string) => void
  /**
   * Focus 中 object ID 変更 callback です。
   */
  onActiveAnchorChange?: (anchorId?: string) => void
  /**
   * Work Item object の path を開く callback です。
   */
  onNavigate?: (path: string) => void
}

/**
 * Public share 用 read-only Whiteboard の props です。
 */
export type WhiteboardReadOnlyProps = {
  /**
   * 描画する Whiteboard content です。
   */
  content: WhiteboardContent | PublicWhiteboardContent
  /**
   * 表示文言を解決する翻訳関数です。
   */
  t: (key: MessageKey) => string
  /**
   * Work Item link を開く callback です。
   */
  onNavigate?: (path: string) => void
}

/**
 * Object drag 中に保持する pointer と開始位置です。
 */
type WhiteboardDragState = {
  /**
   * Drag 対象 object ID です。
   */
  objectId: string
  /**
   * Pointer down 時の client X 座標です。
   */
  pointerX: number
  /**
   * Pointer down 時の client Y 座標です。
   */
  pointerY: number
  /**
   * Drag 開始時の object X 座標です。
   */
  objectX: number
  /**
   * Drag 開始時の object Y 座標です。
   */
  objectY: number
}

/**
 * Floating toolbar から追加できる canvas element 種別です。
 */
type WhiteboardTool = WhiteboardObject['type'] | 'frame'

const whiteboardWidth = 1400
const whiteboardHeight = 900
const whiteboardTools = [
  'note',
  'text',
  'shape',
  'frame',
  'work-item',
] as const satisfies readonly WhiteboardTool[]

/**
 * Miro/Excalidraw 型 floating toolbar と SVG object/connector editor です。
 */
export function WhiteboardCanvas({
  content,
  editable,
  onActiveAnchorChange,
  onDeleteConnector,
  onDeleteFrame,
  onDeleteObject,
  onNavigate,
  onUpsertConnector,
  onUpsertFrame,
  onUpsertObject,
  t,
}: WhiteboardCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragStateRef = useRef<WhiteboardDragState | undefined>(undefined)
  const [dragPreviewObjects, setDragPreviewObjects] =
    useState<WhiteboardObject[] | undefined>(undefined)
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([])
  const [selectedConnectorId, setSelectedConnectorId] = useState<string>()
  const [selectedFrameId, setSelectedFrameId] = useState<string>()
  const [isMultiSelectEnabled, setIsMultiSelectEnabled] = useState(false)
  const [isWorkItemComposerOpen, setIsWorkItemComposerOpen] =
    useState(false)
  const [workItemTeamId, setWorkItemTeamId] = useState('')
  const [workItemIssueId, setWorkItemIssueId] = useState('')
  const objects = dragPreviewObjects ?? content.objects
  const frames = content.frames
  const objectsRef = useRef(objects)

  useEffect(() => {
    objectsRef.current = objects
  }, [objects])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current
      const svg = svgRef.current
      if (!dragState || !svg) return

      const bounds = svg.getBoundingClientRect()
      const scaleX = whiteboardWidth / Math.max(bounds.width, 1)
      const scaleY = whiteboardHeight / Math.max(bounds.height, 1)
      const nextX =
        dragState.objectX + (event.clientX - dragState.pointerX) * scaleX
      const nextY =
        dragState.objectY + (event.clientY - dragState.pointerY) * scaleY

      setDragPreviewObjects((current) =>
        (current ?? objectsRef.current).map((object) =>
          object.id === dragState.objectId
            ? {
                ...object,
                bounds: {
                  ...object.bounds,
                  x: clamp(
                    nextX,
                    0,
                    whiteboardWidth - object.bounds.width,
                  ),
                  y: clamp(
                    nextY,
                    0,
                    whiteboardHeight - object.bounds.height,
                  ),
                },
              }
            : object,
        ),
      )
    }
    const handlePointerUp = () => {
      const dragState = dragStateRef.current
      if (!dragState) return
      const object = objectsRef.current.find(
        (candidate) => candidate.id === dragState.objectId,
      )
      dragStateRef.current = undefined
      setDragPreviewObjects(undefined)
      if (object) onUpsertObject(object)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [onUpsertObject])

  const selectedObject = objects.find(
    (object) => object.id === selectedObjectIds.at(-1),
  )
  const selectedConnector = content.connectors.find(
    (connector) => connector.id === selectedConnectorId,
  )
  const selectedFrame = frames.find((frame) => frame.id === selectedFrameId)

  const addElement = (type: WhiteboardTool) => {
    if (type === 'work-item') {
      setWorkItemTeamId('')
      setWorkItemIssueId('')
      setIsWorkItemComposerOpen(true)
      return
    }
    if (type === 'frame') {
      const frame = {
        ...createWhiteboardFrame(frames.length),
        objectIds: [...selectedObjectIds],
        title: t('documents.whiteboard.defaultFrame'),
      }
      setSelectedFrameId(frame.id)
      setSelectedConnectorId(undefined)
      onUpsertFrame(frame)
      return
    }

    const createdObject = createWhiteboardObject(type, objects.length)
    const object = {
      ...createdObject,
      text: t(
        createdObject.type === 'note'
          ? 'documents.whiteboard.defaultNote'
          : createdObject.type === 'shape'
            ? 'documents.whiteboard.defaultShape'
            : 'documents.whiteboard.defaultText',
      ),
    }
    setSelectedObjectIds([object.id])
    setSelectedConnectorId(undefined)
    setSelectedFrameId(undefined)
    onUpsertObject(object)
  }

  const createWorkItemObject = () => {
    const workItemId = createCanonicalWorkItemId(
      workItemTeamId,
      workItemIssueId,
    )
    if (!workItemId) return
    const object = {
      ...createWhiteboardObject('work-item', objects.length),
      workItemId,
    }
    setSelectedObjectIds([object.id])
    setSelectedConnectorId(undefined)
    setSelectedFrameId(undefined)
    setIsWorkItemComposerOpen(false)
    onUpsertObject(object)
  }

  const createConnector = () => {
    const [fromObjectId, toObjectId] = selectedObjectIds.slice(-2)
    if (!fromObjectId || !toObjectId || fromObjectId === toObjectId) return

    const connector = createWhiteboardConnector(fromObjectId, toObjectId)
    setSelectedConnectorId(connector.id)
    setSelectedFrameId(undefined)
    onUpsertConnector(connector)
  }

  const selectObject = (objectId: string, append = false) => {
    setSelectedObjectIds((current) =>
      append
        ? current.includes(objectId)
          ? current.filter((id) => id !== objectId)
          : [...current, objectId]
        : [objectId],
    )
    setSelectedConnectorId(undefined)
    setSelectedFrameId(undefined)
    onActiveAnchorChange?.(objectId)
  }

  const moveSelectedObjects = (
    fallbackObjectId: string,
    deltaX: number,
    deltaY: number,
  ) => {
    const objectIds = selectedObjectIds.includes(fallbackObjectId)
      ? selectedObjectIds
      : [fallbackObjectId]
    for (const object of objects) {
      if (objectIds.includes(object.id)) {
        onUpsertObject(
          moveWhiteboardObjectWithinCanvas(object, deltaX, deltaY),
        )
      }
    }
  }

  const handleDelete = () => {
    if (selectedConnectorId) {
      onDeleteConnector(selectedConnectorId)
      setSelectedConnectorId(undefined)
      return
    }
    if (selectedFrameId) {
      onDeleteFrame(selectedFrameId)
      setSelectedFrameId(undefined)
      return
    }

    for (const objectId of selectedObjectIds) onDeleteObject(objectId)
    setSelectedObjectIds([])
  }

  return (
    <div
      className="relative h-full min-h-[560px] overflow-hidden bg-[#f8faf9]"
      data-testid="whiteboard-canvas"
      onKeyDown={(event) => {
        if (
          editable &&
          (event.key === 'Delete' || event.key === 'Backspace') &&
          event.target === event.currentTarget
        ) {
          handleDelete()
        }
      }}
      tabIndex={0}
    >
      {editable ? (
        <div
          aria-label={t('documents.whiteboard.toolbar')}
          className="absolute left-1/2 top-4 z-20 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-xl border border-[var(--workbench-border)] bg-white/95 p-1.5 shadow-[0_12px_36px_rgba(23,32,29,0.14)] backdrop-blur"
          role="toolbar"
        >
          {whiteboardTools.map((type) => (
            <button
              className="flex h-10 flex-none items-center gap-2 rounded-lg px-3 text-xs font-semibold text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary)]"
              key={type}
              onClick={() => addElement(type)}
              title={t(`documents.whiteboard.${type}`)}
              type="button"
            >
              <span aria-hidden="true">{whiteboardToolGlyphs[type]}</span>
              <span className="max-[720px]:sr-only">
                {t(`documents.whiteboard.${type}`)}
              </span>
            </button>
          ))}
          <span className="mx-1 h-7 w-px flex-none bg-[var(--workbench-border)]" />
          <button
            aria-pressed={isMultiSelectEnabled}
            className="flex h-10 flex-none items-center gap-2 rounded-lg px-3 text-xs font-semibold text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary)]"
            onClick={() =>
              setIsMultiSelectEnabled((current) => !current)
            }
            title={t('documents.whiteboard.multiSelect')}
            type="button"
          >
            <span aria-hidden="true">⌗</span>
            <span className="max-[720px]:sr-only">
              {t('documents.whiteboard.multiSelect')}
            </span>
          </button>
          <button
            className="flex h-10 flex-none items-center gap-2 rounded-lg px-3 text-xs font-semibold text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={selectedObjectIds.length < 2}
            onClick={createConnector}
            title={t('documents.whiteboard.connector')}
            type="button"
          >
            <span aria-hidden="true">↗</span>
            <span className="max-[720px]:sr-only">
              {t('documents.whiteboard.connector')}
            </span>
          </button>
          <button
            className="flex h-10 flex-none items-center gap-2 rounded-lg px-3 text-xs font-semibold text-[var(--workbench-muted)] hover:bg-red-50 hover:text-[var(--workbench-danger)] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={
              !selectedConnectorId &&
              !selectedFrameId &&
              selectedObjectIds.length === 0
            }
            onClick={handleDelete}
            title={t('documents.whiteboard.delete')}
            type="button"
          >
            ×
          </button>
        </div>
      ) : null}
      {editable && isWorkItemComposerOpen ? (
        <form
          className="absolute left-1/2 top-20 z-30 grid w-[min(360px,calc(100%-32px))] -translate-x-1/2 gap-3 rounded-xl border border-[var(--workbench-border)] bg-white p-4 shadow-[0_16px_44px_rgba(23,32,29,0.18)]"
          onSubmit={(event) => {
            event.preventDefault()
            createWorkItemObject()
          }}
        >
          <strong className="text-sm text-[var(--workbench-text)]">
            {t('documents.whiteboard.addWorkItem')}
          </strong>
          <p className="m-0 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
            {t('documents.whiteboard.workItemHint')}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('documents.whiteboard.teamId')}
              <input
                autoFocus
                className="workbench-input h-10 px-3 text-sm"
                onChange={(event) =>
                  setWorkItemTeamId(event.target.value)
                }
                value={workItemTeamId}
              />
            </label>
            <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('documents.whiteboard.issueId')}
              <input
                className="workbench-input h-10 px-3 text-sm"
                onChange={(event) =>
                  setWorkItemIssueId(event.target.value)
                }
                value={workItemIssueId}
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button
              className="workbench-button min-h-9 px-3"
              onClick={() => setIsWorkItemComposerOpen(false)}
              type="button"
            >
              {t('documents.whiteboard.cancelWorkItem')}
            </button>
            <button
              className="workbench-button-primary min-h-9 px-3 disabled:opacity-50"
              disabled={
                createCanonicalWorkItemId(
                  workItemTeamId,
                  workItemIssueId,
                ) === undefined
              }
              type="submit"
            >
              {t('documents.whiteboard.saveWorkItem')}
            </button>
          </div>
        </form>
      ) : null}

      <WhiteboardSvg
        connectors={content.connectors}
        frames={frames}
        objects={objects}
        t={t}
        selectedConnectorId={selectedConnectorId}
        selectedFrameId={selectedFrameId}
        selectedObjectIds={selectedObjectIds}
        svgRef={svgRef}
        onNavigate={onNavigate}
        onObjectPointerDown={
          editable
            ? (event, object) => {
                event.preventDefault()
                const append =
                  isMultiSelectEnabled ||
                  event.shiftKey ||
                  event.metaKey ||
                  event.ctrlKey
                selectObject(
                  object.id,
                  append,
                )
                dragStateRef.current = {
                  objectId: object.id,
                  objectX: object.bounds.x,
                  objectY: object.bounds.y,
                  pointerX: event.clientX,
                  pointerY: event.clientY,
                }
              }
            : undefined
        }
        onSelectConnector={
          editable
            ? (connectorId) => {
                setSelectedConnectorId(connectorId)
                setSelectedFrameId(undefined)
                setSelectedObjectIds([])
              }
            : undefined
        }
        onSelectFrame={
          editable
            ? (frameId) => {
                setSelectedFrameId(frameId)
                setSelectedConnectorId(undefined)
                setSelectedObjectIds([])
              }
            : undefined
        }
        onSelectObject={
          editable
            ? selectObject
            : undefined
        }
        onMoveObject={
          editable
            ? moveSelectedObjects
            : undefined
        }
      />

      {editable &&
      (selectedObject || selectedConnector || selectedFrame) ? (
        <WhiteboardInspector
          connector={selectedConnector}
          frame={selectedFrame}
          object={selectedObject}
          t={t}
          onNavigate={onNavigate}
          onConnectorChange={onUpsertConnector}
          onFrameChange={onUpsertFrame}
          onMoveObject={(deltaX, deltaY) =>
            selectedObject &&
            moveSelectedObjects(selectedObject.id, deltaX, deltaY)
          }
          onObjectChange={onUpsertObject}
        />
      ) : null}

      <div className="absolute bottom-4 left-4 rounded-lg border border-[var(--workbench-border)] bg-white/90 px-3 py-2 text-xs font-semibold text-[var(--workbench-muted)] shadow-sm">
        {t('documents.whiteboard.hint')}
      </div>
    </div>
  )
}

/**
 * Public share で Whiteboard content を read-only SVG として描画します。
 */
export function WhiteboardReadOnly({
  content,
  onNavigate,
  t,
}: WhiteboardReadOnlyProps) {
  const normalizedContent: WhiteboardContent = {
    connectors: content.connectors,
    frames: content.frames,
    objects: content.objects.map((object): WhiteboardObject => {
      if (object.type === 'work-item' && !('workItemId' in object)) {
        return {
          bounds: object.bounds,
          id: object.id,
          ...(object.style ? { style: object.style } : {}),
          type: 'work-item',
          workItemId: '',
          zIndex: object.zIndex,
        }
      }
      return object
    }),
  }

  return (
    <div className="mx-auto aspect-[14/9] w-full max-w-[1120px] overflow-hidden rounded-xl border border-[var(--workbench-border)] bg-[#f8faf9] shadow-sm">
      <WhiteboardSvg
        connectors={normalizedContent.connectors}
        frames={normalizedContent.frames}
        objects={normalizedContent.objects}
        selectedObjectIds={[]}
        t={t}
        onNavigate={onNavigate}
      />
    </div>
  )
}

function WhiteboardSvg({
  connectors,
  frames,
  objects,
  onNavigate,
  onObjectPointerDown,
  onSelectConnector,
  onSelectFrame,
  onMoveObject,
  onSelectObject,
  selectedConnectorId,
  selectedFrameId,
  selectedObjectIds,
  svgRef,
  t,
}: {
  connectors: WhiteboardConnector[]
  frames: WhiteboardFrame[]
  objects: WhiteboardObject[]
  onNavigate?: (path: string) => void
  onObjectPointerDown?: (
    event: ReactPointerEvent<SVGGElement>,
    object: WhiteboardObject,
  ) => void
  onSelectConnector?: (connectorId: string) => void
  onSelectFrame?: (frameId: string) => void
  onMoveObject?: (
    objectId: string,
    deltaX: number,
    deltaY: number,
  ) => void
  onSelectObject?: (objectId: string, append?: boolean) => void
  selectedConnectorId?: string
  selectedFrameId?: string
  selectedObjectIds: string[]
  svgRef?: RefObject<SVGSVGElement | null>
  t: (key: MessageKey) => string
}) {
  const objectsById = useMemo(
    () => new Map(objects.map((object) => [object.id, object])),
    [objects],
  )

  return (
    <svg
      aria-label={t('documents.whiteboard.canvas')}
      className="h-full w-full touch-none"
      ref={svgRef}
      role={
        onSelectObject || onSelectConnector || onSelectFrame
          ? 'application'
          : 'img'
      }
      viewBox={`0 0 ${whiteboardWidth} ${whiteboardHeight}`}
    >
      <defs>
        <pattern
          height="24"
          id="whiteboard-grid"
          patternUnits="userSpaceOnUse"
          width="24"
        >
          <circle cx="1" cy="1" fill="#d9e1de" r="1" />
        </pattern>
        <marker
          id="whiteboard-arrow"
          markerHeight="8"
          markerWidth="8"
          orient="auto"
          refX="7"
          refY="4"
        >
          <path d="M0,0 L8,4 L0,8 z" fill="#65716d" />
        </marker>
      </defs>
      <rect
        fill="url(#whiteboard-grid)"
        height={whiteboardHeight}
        width={whiteboardWidth}
      />
      {frames.map((frame) => (
        <g
          aria-label={frame.title}
          className={onSelectFrame ? 'cursor-pointer' : ''}
          key={frame.id}
          onClick={() => onSelectFrame?.(frame.id)}
          onKeyDown={(event) => {
            if (
              onSelectFrame &&
              (event.key === 'Enter' || event.key === ' ')
            ) {
              event.preventDefault()
              onSelectFrame(frame.id)
            }
          }}
          role={onSelectFrame ? 'button' : undefined}
          tabIndex={onSelectFrame ? 0 : undefined}
        >
          <rect
            fill="#ffffff80"
            height={frame.bounds.height}
            rx="16"
            stroke={
              selectedFrameId === frame.id ? '#0f766e' : '#aab9b4'
            }
            strokeDasharray="10 7"
            strokeWidth={selectedFrameId === frame.id ? 4 : 2}
            width={frame.bounds.width}
            x={frame.bounds.x}
            y={frame.bounds.y}
          />
          <text
            fill="#46524e"
            fontSize="18"
            fontWeight="700"
            x={frame.bounds.x + 16}
            y={frame.bounds.y + 28}
          >
            {frame.title}
          </text>
        </g>
      ))}
      {connectors.map((connector) => {
        const fromObject = objectsById.get(connector.from.objectId)
        const toObject = objectsById.get(connector.to.objectId)
        if (!fromObject || !toObject) return null

        const from = objectCenter(fromObject)
        const to = objectCenter(toObject)
        const selected = selectedConnectorId === connector.id
        return (
          <g
            aria-label={
              connector.label || t('documents.whiteboard.connector')
            }
            className={onSelectConnector ? 'cursor-pointer' : ''}
            key={connector.id}
            onClick={() => onSelectConnector?.(connector.id)}
            onKeyDown={(event) => {
              if (
                onSelectConnector &&
                (event.key === 'Enter' || event.key === ' ')
              ) {
                event.preventDefault()
                onSelectConnector(connector.id)
              }
            }}
            role={onSelectConnector ? 'button' : undefined}
            tabIndex={onSelectConnector ? 0 : undefined}
          >
            <line
              aria-hidden="true"
              stroke="transparent"
              strokeWidth="24"
              x1={from.x}
              x2={to.x}
              y1={from.y}
              y2={to.y}
            />
            <line
              markerEnd="url(#whiteboard-arrow)"
              stroke={selected ? '#0f766e' : '#65716d'}
              strokeDasharray={
                connector.lineStyle === 'dashed' ? '8 6' : undefined
              }
              strokeWidth={selected ? 4 : 2.5}
              x1={from.x}
              x2={to.x}
              y1={from.y}
              y2={to.y}
            />
            {connector.label ? (
              <text
                fill="#65716d"
                fontSize="16"
                fontWeight="600"
                textAnchor="middle"
                x={(from.x + to.x) / 2}
                y={(from.y + to.y) / 2 - 8}
              >
                {connector.label}
              </text>
            ) : null}
          </g>
        )
      })}
      {[...objects]
        .sort((left, right) => left.zIndex - right.zIndex)
        .map((object) => (
          <WhiteboardObjectNode
            key={object.id}
            object={object}
            selected={selectedObjectIds.includes(object.id)}
            t={t}
            onNavigate={onNavigate}
            onMove={onMoveObject}
            onPointerDown={onObjectPointerDown}
            onSelect={onSelectObject}
          />
        ))}
    </svg>
  )
}

function WhiteboardObjectNode({
  object,
  onNavigate,
  onMove,
  onPointerDown,
  onSelect,
  selected,
  t,
}: {
  object: WhiteboardObject
  onNavigate?: (path: string) => void
  onMove?: (
    objectId: string,
    deltaX: number,
    deltaY: number,
  ) => void
  onPointerDown?: (
    event: ReactPointerEvent<SVGGElement>,
    object: WhiteboardObject,
  ) => void
  onSelect?: (objectId: string, append?: boolean) => void
  selected: boolean
  t: (key: MessageKey) => string
}) {
  const fill = object.style?.fill ?? '#ffffff'
  const text =
    object.type === 'work-item'
      ? object.workItemId || t('documents.whiteboard.work-item')
      : object.text
  const workItemPath =
    object.type === 'work-item' && object.workItemId
      ? createWorkItemSearchPath(object.workItemId)
      : undefined

  return (
    <g
      aria-label={
        text || t(`documents.whiteboard.${object.type}`)
      }
      className={onPointerDown ? 'cursor-grab active:cursor-grabbing' : ''}
      onDoubleClick={() => workItemPath && onNavigate?.(workItemPath)}
      onKeyDown={(event) => {
        const movement =
          event.key === 'ArrowUp'
            ? [0, -1]
            : event.key === 'ArrowDown'
              ? [0, 1]
              : event.key === 'ArrowLeft'
                ? [-1, 0]
                : event.key === 'ArrowRight'
                  ? [1, 0]
                  : undefined
        if (onMove && movement) {
          event.preventDefault()
          const distance = event.shiftKey ? 20 : 5
          onMove(
            object.id,
            movement[0] * distance,
            movement[1] * distance,
          )
        } else if (
          onSelect &&
          (event.key === 'Enter' || event.key === ' ')
        ) {
          event.preventDefault()
          onSelect(
            object.id,
            event.shiftKey || event.metaKey || event.ctrlKey,
          )
        } else if (
          event.key === 'Enter' &&
          workItemPath
        ) {
          onNavigate?.(workItemPath)
        }
      }}
      onPointerDown={(event) => onPointerDown?.(event, object)}
      role={
        onSelect
          ? 'button'
          : object.type === 'work-item'
            ? 'link'
            : undefined
      }
      tabIndex={onSelect || object.type === 'work-item' ? 0 : undefined}
      transform={`translate(${object.bounds.x} ${object.bounds.y})`}
    >
      {object.type === 'shape' && object.shape === 'ellipse' ? (
        <ellipse
          cx={object.bounds.width / 2}
          cy={object.bounds.height / 2}
          fill={fill}
          rx={object.bounds.width / 2}
          ry={object.bounds.height / 2}
          stroke={selected ? '#0f766e' : object.style?.stroke ?? '#dde4e1'}
          strokeWidth={selected ? 4 : 2}
        />
      ) : (
        <rect
          fill={fill}
          height={object.bounds.height}
          rx="10"
          stroke={
            selected
              ? '#0f766e'
              : object.type === 'work-item'
                ? '#99d7cf'
                : object.style?.stroke ?? '#dde4e1'
          }
          strokeWidth={selected ? 4 : 2}
          width={object.bounds.width}
        />
      )}
      <foreignObject
        height={object.bounds.height}
        pointerEvents="none"
        width={object.bounds.width}
      >
        <div className="flex h-full w-full flex-col justify-center overflow-hidden p-4 font-sans">
          {object.type === 'work-item' && workItemPath ? (
            <span className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[#0f766e]">
              {t('documents.whiteboard.work-item')}
            </span>
          ) : null}
          <span className="whitespace-pre-wrap text-sm font-semibold leading-6 text-[#17201d]">
            {text}
          </span>
          {object.type === 'work-item' ? (
            <span className="mt-2 text-xs font-semibold text-[#65716d]">
              {t('documents.whiteboard.openWorkItem')}
            </span>
          ) : null}
        </div>
      </foreignObject>
    </g>
  )
}

function WhiteboardInspector({
  connector,
  frame,
  object,
  onConnectorChange,
  onFrameChange,
  onMoveObject,
  onNavigate,
  onObjectChange,
  t,
}: {
  connector?: WhiteboardConnector
  frame?: WhiteboardFrame
  object?: WhiteboardObject
  onConnectorChange: (connector: WhiteboardConnector) => void
  onFrameChange: (frame: WhiteboardFrame) => void
  onMoveObject: (deltaX: number, deltaY: number) => void
  onNavigate?: (path: string) => void
  onObjectChange: (object: WhiteboardObject) => void
  t: (key: MessageKey) => string
}) {
  return (
    <aside className="absolute bottom-4 right-4 z-20 w-[min(290px,calc(100%-32px))] rounded-xl border border-[var(--workbench-border)] bg-white/95 p-4 shadow-[0_16px_44px_rgba(23,32,29,0.16)] backdrop-blur">
      <p className="m-0 text-xs font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
        {t('documents.whiteboard.inspector')}
      </p>
      {object ? (
        <div className="mt-3 grid gap-3">
          {object.type === 'work-item' ? (
            <CanonicalWorkItemEditor
              key={object.id}
              object={object}
              onChange={onObjectChange}
              t={t}
            />
          ) : (
            <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('documents.whiteboard.text')}
              <textarea
                className="workbench-input min-h-20 resize-y p-2.5 text-sm"
                onChange={(event) =>
                  onObjectChange(
                    updateWhiteboardObjectText(
                      object,
                      event.target.value,
                    ),
                  )
                }
                value={object.text ?? ''}
              />
            </label>
          )}
          <div
            aria-label={t('documents.whiteboard.move')}
            className="grid grid-cols-4 gap-1"
            role="toolbar"
          >
            {([
              ['moveLeft', -10, 0, '←'],
              ['moveUp', 0, -10, '↑'],
              ['moveDown', 0, 10, '↓'],
              ['moveRight', 10, 0, '→'],
            ] as const).map(([key, deltaX, deltaY, glyph]) => (
              <button
                aria-label={t(`documents.whiteboard.${key}`)}
                className="grid h-10 place-items-center rounded-md border border-[var(--workbench-border)] bg-white text-sm font-bold text-[var(--workbench-muted)] hover:text-[var(--workbench-primary)]"
                key={key}
                onClick={() => onMoveObject(deltaX, deltaY)}
                type="button"
              >
                {glyph}
              </button>
            ))}
          </div>
          {object.type === 'work-item' && object.workItemId ? (
            <button
              className="workbench-button-secondary min-h-10 px-3"
              onClick={() =>
                onNavigate?.(
                  createWorkItemSearchPath(object.workItemId),
                )
              }
              type="button"
            >
              {t('documents.whiteboard.openWorkItem')}
            </button>
          ) : null}
          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('documents.whiteboard.color')}
            <input
              className="h-10 w-full rounded-md border border-[var(--workbench-border)] bg-white"
              onChange={(event) =>
                onObjectChange({
                  ...object,
                  style: {
                    ...object.style,
                    fill: event.target.value,
                  },
                })
              }
              type="color"
              value={normalizeColor(object.style?.fill)}
            />
          </label>
        </div>
      ) : null}
      {frame ? (
        <label className="mt-3 grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('documents.whiteboard.text')}
          <input
            className="workbench-input h-10 px-3 text-sm"
            onChange={(event) =>
              onFrameChange({ ...frame, title: event.target.value })
            }
            value={frame.title}
          />
        </label>
      ) : null}
      {connector ? (
        <label className="mt-3 grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('documents.whiteboard.connectorLabel')}
          <input
            className="workbench-input h-10 px-3 text-sm"
            onChange={(event) =>
              onConnectorChange({
                ...connector,
                label: event.target.value,
              })
            }
            value={connector.label ?? ''}
          />
        </label>
      ) : null}
    </aside>
  )
}

function CanonicalWorkItemEditor({
  object,
  onChange,
  t,
}: {
  object: Extract<WhiteboardObject, { type: 'work-item' }>
  onChange: (object: WhiteboardObject) => void
  t: (key: MessageKey) => string
}) {
  const parsed = parseCanonicalWorkItemId(object.workItemId)
  const [teamId, setTeamId] = useState(parsed?.teamId ?? '')
  const [issueId, setIssueId] = useState(parsed?.issueId ?? '')
  const canonicalId = createCanonicalWorkItemId(teamId, issueId)

  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (canonicalId) {
          onChange({ ...object, workItemId: canonicalId })
        }
      }}
    >
      <span className="text-xs font-semibold text-[var(--workbench-muted)]">
        {t('documents.whiteboard.workItemPath')}
      </span>
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
          {t('documents.whiteboard.teamId')}
          <input
            className="workbench-input h-9 px-2 text-xs"
            onChange={(event) => setTeamId(event.target.value)}
            value={teamId}
          />
        </label>
        <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
          {t('documents.whiteboard.issueId')}
          <input
            className="workbench-input h-9 px-2 text-xs"
            onChange={(event) => setIssueId(event.target.value)}
            value={issueId}
          />
        </label>
      </div>
      <button
        className="workbench-button-secondary min-h-9 px-3 disabled:opacity-50"
        disabled={
          canonicalId === undefined ||
          canonicalId === object.workItemId
        }
        type="submit"
      >
        {t('documents.whiteboard.saveWorkItem')}
      </button>
    </form>
  )
}

const whiteboardToolGlyphs: Record<WhiteboardTool, string> = {
  frame: '▣',
  note: '▤',
  shape: '□',
  text: 'T',
  'work-item': '✓',
}

function updateWhiteboardObjectText(
  object: WhiteboardObject,
  text: string,
): WhiteboardObject {
  if (object.type === 'work-item') return object
  return { ...object, text }
}

function objectCenter(object: WhiteboardObject) {
  return {
    x: object.bounds.x + object.bounds.width / 2,
    y: object.bounds.y + object.bounds.height / 2,
  }
}

function normalizeColor(value?: string) {
  return value && /^#[0-9a-f]{6}$/iu.test(value) ? value : '#ffffff'
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
