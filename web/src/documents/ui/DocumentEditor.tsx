import { useState, type ReactNode } from 'react'
import type {
  DocumentBlock,
  DocumentChecklistBlock,
  DocumentChecklistItem,
  DocumentCodeBlock,
  DocumentDiagramBlock,
  DocumentEmbedBlock,
  DocumentHeadingBlock,
  DocumentParagraphBlock,
  DocumentRelation,
  DocumentTableBlock,
} from '@mukuroji/contracts'
import { DocumentLinkedText } from './DocumentLinkedText'
import { SafeMarkdown } from '../../shared/ui/SafeMarkdown'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { DocumentRecord } from '../api'
import {
  isChecklistItemOverdue,
  resolveChecklistAssigneeLabel,
  updateChecklistItemOwnership,
  type ChecklistAssigneeOption,
} from '../model/checklistItems'
import { findChecklistItemWorkItemId } from '../model/checklistWorkItems'
import { formatLocalCalendarDate } from '../model/builtInTemplates'
import {
  createDocumentBlock,
  resolveSafeEmbedUrl,
  type DocumentSaveStatus,
} from '../model/document'

/**
 * Rich text blocks を持つ page/template detail です。
 */
type RichTextDocument = Extract<
  DocumentRecord,
  { kind: 'page' | 'template' }
>

/**
 * Actions that turn checklist items into Work Items and open the linked ones.
 */
export type ChecklistWorkItemControls = {
  /** Relations of the Document, used to find items that already have a Work Item. */
  relations: readonly DocumentRelation[]
  /** Starts creating a Work Item from an item; omission hides the action. */
  onCreate?: (blockId: string, item: DocumentChecklistItem) => void
  /** Opens the Work Item linked to an item; omission hides the link. */
  onOpen?: (workItemId: string) => void
  /**
   * Members offered as item owners, also used to show owner names; omission
   * hides the owner and deadline fields in the editor.
   */
  assignees?: readonly ChecklistAssigneeOption[]
  /**
   * Reads the owner candidates again; present only after a member read
   * failed, so some owners may be missing from the list.
   */
  onRetryAssignees?: () => void
}

/**
 * Typed block editor の props です。
 */
export type DocumentEditorProps = {
  /**
   * Editor へ表示する Document record です。
   */
  document: RichTextDocument
  /**
   * API capability に基づく編集可否です。
   */
  editable: boolean
  /**
   * 現在の autosave 状態です。
   */
  saveStatus: DocumentSaveStatus
  /**
   * 表示文言を解決する翻訳関数です。
   */
  t: (key: MessageKey) => string
  /**
   * Block 作成/置換時の callback です。
   */
  onUpsertBlock: (block: DocumentBlock, index?: number) => void
  /**
   * Block 削除時の callback です。
   */
  onDeleteBlock: (blockId: string) => void
  /**
   * Block 並べ替え時の callback です。
   */
  onMoveBlock: (blockId: string, index: number) => void
  /**
   * Focus 中 anchor が変わったときの callback です。
   */
  onActiveAnchorChange?: (anchorId?: string) => void
  /**
   * Block anchor の comment panel を開く callback です。
   */
  onOpenComments?: (anchorId: string) => void
  /**
   * Checklist item から Work Item を作成・表示する操作です。
   */
  checklistWorkItems?: ChecklistWorkItemControls
}

/**
 * Public share で利用する read-only Document renderer の props です。
 */
export type DocumentReadOnlyContentProps = {
  /**
   * 描画する public または authenticated Document です。
   */
  document: Pick<RichTextDocument, 'blocks' | 'title' | 'updatedAt'>
  /**
   * 表示文言を解決する翻訳関数です。
   */
  t: (key: MessageKey) => string
}

const insertableBlockTypes = [
  'paragraph',
  'heading',
  'table',
  'code',
  'checklist',
  'embed',
  'diagram',
] as const satisfies readonly DocumentBlock['type'][]

/**
 * Craft 型の狭い本文 column と block ごとの操作を持つ Document editor です。
 */
export function DocumentEditor({
  checklistWorkItems,
  document,
  editable,
  onActiveAnchorChange,
  onDeleteBlock,
  onMoveBlock,
  onOpenComments,
  onUpsertBlock,
  saveStatus,
  t,
}: DocumentEditorProps) {
  const [insertIndex, setInsertIndex] = useState<number>()
  const [isPreviewing, setIsPreviewing] = useState(false)
  const canEditBlocks = editable && !isPreviewing

  /**
   * Inserts a new block of the chosen type at the open insertion point.
   *
   * @param type - Block type to insert.
   */
  const insertBlock = (type: DocumentBlock['type']) => {
    const index = insertIndex ?? document.blocks.length
    setInsertIndex(undefined)
    onUpsertBlock(createDocumentBlock(type), index)
  }

  return (
    <article
      aria-label={t('documents.editor.aria')}
      className="mx-auto w-full min-w-0 max-w-[820px] px-[clamp(16px,5vw,72px)] pb-24 pt-6 sm:pt-10"
      data-testid="document-editor"
    >
      <div className="mb-8 flex items-center justify-between gap-4">
        <p
          className={`m-0 text-xs font-semibold ${
            saveStatus === 'conflict' || saveStatus === 'error'
              ? 'text-[var(--workbench-danger)]'
              : 'text-[var(--workbench-muted)]'
          }`}
          role="status"
        >
          {t(`documents.save.${saveStatus}`)}
        </p>
        {!editable ? (
          <span className="workbench-badge">{t('documents.readOnly')}</span>
        ) : (
          <button
            aria-pressed={isPreviewing}
            className="workbench-button-secondary min-h-8 px-3 text-xs"
            onClick={() => {
              setInsertIndex(undefined)
              setIsPreviewing((current) => !current)
            }}
            type="button"
          >
            {isPreviewing ? t('documents.editor.backToEdit') : t('documents.editor.preview')}
          </button>
        )}
      </div>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
        {document.blocks.map((block, index) => (
          <div className="grid min-w-0 gap-2" key={block.id}>
            <EditableBlock
              block={block}
              checklistWorkItems={checklistWorkItems}
              editable={canEditBlocks}
              index={index}
              lastIndex={document.blocks.length - 1}
              t={t}
              onActiveAnchorChange={onActiveAnchorChange}
              onChange={onUpsertBlock}
              onDelete={() => onDeleteBlock(block.id)}
              onInsertBelow={() => setInsertIndex((current) => current === index + 1 ? undefined : index + 1)}
              onMove={(nextIndex) => onMoveBlock(block.id, nextIndex)}
              onOpenComments={
                onOpenComments ? () => onOpenComments(block.id) : undefined
              }
            />
            {canEditBlocks && insertIndex === index + 1 && index < document.blocks.length - 1 ? (
              <InsertBlockMenu onInsert={insertBlock} t={t} />
            ) : null}
          </div>
        ))}
      </div>

      {canEditBlocks ? (
        <div className="relative mt-5">
          <button
            aria-expanded={insertIndex === document.blocks.length}
            aria-haspopup="menu"
            className="flex min-h-10 items-center gap-2 rounded-md px-3 text-sm font-semibold text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary-text)]"
            onClick={() =>
              setInsertIndex((current) =>
                current === document.blocks.length ? undefined : document.blocks.length)}
            type="button"
          >
            <span
              aria-hidden="true"
              className="grid h-6 w-6 place-items-center rounded border border-[var(--workbench-border)] bg-surface"
            >
              +
            </span>
            {t('documents.editor.addBlock')}
          </button>
          {insertIndex === document.blocks.length ? (
            <div className="absolute left-0 top-12 z-20">
              <InsertBlockMenu onInsert={insertBlock} t={t} />
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

/**
 * Menu of block types that can be inserted at one position.
 *
 * @param props - Insert callback and translator.
 * @returns The block type menu.
 */
function InsertBlockMenu({
  onInsert,
  t,
}: {
  /** Inserts a block of the chosen type. */
  onInsert: (type: DocumentBlock['type']) => void
  /** Translator. */
  t: (key: MessageKey) => string
}) {
  return (
    <div
      aria-label={t('documents.editor.addBlock')}
      className="grid w-[min(520px,calc(100vw-44px))] grid-cols-2 gap-1 rounded-lg border border-[var(--workbench-border)] bg-surface p-2 shadow-[0_18px_50px_rgba(23,32,29,0.16)] sm:grid-cols-3"
      role="menu"
    >
      {insertableBlockTypes.map((type) => (
        <button
          className="flex min-h-12 items-center gap-3 rounded-md px-3 text-left text-sm font-semibold text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]"
          key={type}
          onClick={() => onInsert(type)}
          role="menuitem"
          type="button"
        >
          <span
            aria-hidden="true"
            className="grid h-7 w-7 place-items-center rounded bg-[var(--workbench-surface-muted)] text-xs text-[var(--workbench-primary-text)]"
          >
            {blockGlyphs[type]}
          </span>
          {t(`documents.block.${type}`)}
        </button>
      ))}
    </div>
  )
}

/**
 * Public share と version preview に使える安全な read-only block renderer です。
 */
export function DocumentReadOnlyContent({
  document,
  t,
}: DocumentReadOnlyContentProps) {
  return (
    <article className="mx-auto w-full max-w-[760px] px-5 py-12 sm:px-9">
      <header className="mb-10 border-b border-[var(--workbench-border)] pb-8">
        <span className="text-3xl" aria-hidden="true">
          ▤
        </span>
        <h1 className="workbench-title mt-4 text-[clamp(2rem,5vw,3.5rem)]">
          {document.title}
        </h1>
        <p className="mt-3 text-sm font-medium text-[var(--workbench-muted)]">
          {t('documents.public.updated')}{' '}
          {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
            new Date(document.updatedAt),
          )}
        </p>
      </header>
      <div className="grid gap-4">
        {document.blocks.map((block) => (
          <ReadOnlyBlock block={block} key={block.id} t={t} />
        ))}
      </div>
    </article>
  )
}

/**
 * Props of {@link DocumentReadOnlyBlock}.
 */
export type DocumentReadOnlyBlockProps = {
  /**
   * Members that name a checklist owner. A key without a matching member is shown as the key, so
   * an owner or deadline change stays visible when the member list is missing.
   */
  assignees?: readonly ChecklistAssigneeOption[]
  /** Block to render. */
  block: DocumentBlock
  /** Translator. */
  t: (key: MessageKey) => string
}

/**
 * Renders one block with the safe read-only renderer, for version comparisons.
 *
 * A comparison always shows the saved checklist owner and deadline, because a change to either
 * one counts as a change of the block.
 *
 * @param props - Block, owner names, and translator.
 * @returns The read-only block.
 */
export function DocumentReadOnlyBlock({ assignees, block, t }: DocumentReadOnlyBlockProps) {
  return <ReadOnlyBlock block={block} checklistAssignees={assignees ?? []} t={t} />
}

function EditableBlock({
  block,
  checklistWorkItems,
  editable,
  index,
  lastIndex,
  onActiveAnchorChange,
  onChange,
  onDelete,
  onInsertBelow,
  onMove,
  onOpenComments,
  t,
}: {
  /**
   * 描画対象 block です。
   */
  block: DocumentBlock
  /**
   * Opens the block type menu below this block.
   */
  onInsertBelow: () => void
  /**
   * Checklist item から Work Item を作成・表示する操作です。
   */
  checklistWorkItems?: ChecklistWorkItemControls
  /**
   * Block を編集できるかどうかです。
   */
  editable: boolean
  /**
   * 現在の block index です。
   */
  index: number
  /**
   * 最後の block index です。
   */
  lastIndex: number
  /**
   * Focus 中 anchor 変更 callback です。
   */
  onActiveAnchorChange?: (anchorId?: string) => void
  /**
   * Block 変更 callback です。
   */
  onChange: (block: DocumentBlock) => void
  /**
   * Block 削除 callback です。
   */
  onDelete: () => void
  /**
   * Block 移動 callback です。
   */
  onMove: (index: number) => void
  /**
   * Comment panel を開く callback です。
   */
  onOpenComments?: () => void
  /**
   * 翻訳関数です。
   */
  t: (key: MessageKey) => string
}) {
  return (
    <section
      className="group relative min-w-0 rounded-lg border border-transparent px-3 py-2 transition focus-within:border-[var(--workbench-border)] focus-within:bg-surface hover:border-[var(--workbench-border)]"
      data-block-id={block.id}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          onActiveAnchorChange?.()
        }
      }}
      onFocus={() => onActiveAnchorChange?.(block.id)}
    >
      {editable ? (
        <div className="mb-2 hidden items-center gap-0.5 group-hover:flex group-focus-within:flex sm:absolute sm:-left-[42px] sm:top-2 sm:mb-0">
          <button
            aria-label={t('documents.editor.moveUp')}
            className="grid h-7 w-7 place-items-center rounded text-xs text-[var(--workbench-muted)] hover:bg-surface hover:text-[var(--workbench-primary-text)] disabled:opacity-30"
            disabled={index === 0}
            onClick={() => onMove(index - 1)}
            type="button"
          >
            ↑
          </button>
          <button
            aria-label={t('documents.editor.moveDown')}
            className="grid h-7 w-7 place-items-center rounded text-xs text-[var(--workbench-muted)] hover:bg-surface hover:text-[var(--workbench-primary-text)] disabled:opacity-30"
            disabled={index === lastIndex}
            onClick={() => onMove(index + 1)}
            type="button"
          >
            ↓
          </button>
        </div>
      ) : null}
      {editable ? (
        <div className="absolute -right-1 top-1 hidden items-center gap-1 group-hover:flex group-focus-within:flex">
          <button
            aria-label={t('documents.editor.insertBelow')}
            className="grid h-7 w-7 place-items-center rounded bg-surface text-xs text-[var(--workbench-muted)] shadow-sm hover:text-[var(--workbench-primary-text)]"
            onClick={onInsertBelow}
            type="button"
          >
            +
          </button>
          {onOpenComments ? (
            <button
              aria-label={t('documents.context.comments')}
              className="grid h-7 w-7 place-items-center rounded bg-surface text-xs text-[var(--workbench-muted)] shadow-sm hover:text-[var(--workbench-primary-text)]"
              onClick={onOpenComments}
              type="button"
            >
              ◌
            </button>
          ) : null}
          <button
            aria-label={t('documents.editor.deleteBlock')}
            className="grid h-7 w-7 place-items-center rounded bg-surface text-xs text-[var(--workbench-muted)] shadow-sm hover:text-[var(--workbench-danger)]"
            onClick={onDelete}
            type="button"
          >
            ×
          </button>
        </div>
      ) : null}
      <BlockBody
        block={block}
        checklistWorkItems={checklistWorkItems}
        editable={editable}
        t={t}
        onChange={onChange}
      />
    </section>
  )
}

function BlockBody({
  block,
  checklistWorkItems,
  editable,
  onChange,
  t,
}: {
  /**
   * 描画対象 block です。
   */
  block: DocumentBlock
  /**
   * Checklist item から Work Item を作成・表示する操作です。
   */
  checklistWorkItems?: ChecklistWorkItemControls
  /**
   * 編集可否です。
   */
  editable: boolean
  /**
   * Block 変更 callback です。
   */
  onChange: (block: DocumentBlock) => void
  /**
   * 翻訳関数です。
   */
  t: (key: MessageKey) => string
}) {
  if (!editable) {
    return (
      <ReadOnlyBlock
        block={block}
        checklistWorkItems={
          checklistWorkItems
            ? {
                assignees: checklistWorkItems.assignees,
                onOpen: checklistWorkItems.onOpen,
                relations: checklistWorkItems.relations,
              }
            : undefined
        }
        t={t}
      />
    )
  }

  if (block.type === 'heading') {
    return <HeadingBlockEditor block={block} onChange={onChange} t={t} />
  }
  if (block.type === 'table') {
    return <TableBlockEditor block={block} onChange={onChange} t={t} />
  }
  if (block.type === 'code') {
    return <CodeBlockEditor block={block} onChange={onChange} t={t} />
  }
  if (block.type === 'checklist') {
    return (
      <ChecklistBlockEditor
        block={block}
        checklistWorkItems={checklistWorkItems}
        onChange={onChange}
        t={t}
      />
    )
  }
  if (block.type === 'embed') {
    return <EmbedBlockEditor block={block} onChange={onChange} t={t} />
  }
  if (block.type === 'diagram') {
    return <DiagramBlockEditor block={block} onChange={onChange} t={t} />
  }

  return <ParagraphBlockEditor block={block} onChange={onChange} t={t} />
}

function ParagraphBlockEditor({
  block,
  onChange,
  t,
}: {
  block: DocumentParagraphBlock
  onChange: (block: DocumentBlock) => void
  t: (key: MessageKey) => string
}) {
  return (
    <textarea
      aria-label={t('documents.block.paragraph')}
      className="min-h-10 w-full min-w-0 resize-y border-0 bg-transparent px-0 py-1 text-[1rem] leading-7 text-[var(--workbench-text)] outline-none placeholder:text-[var(--workbench-muted-soft)] [field-sizing:content]"
      onChange={(event) => onChange({ ...block, text: event.target.value })}
      placeholder={t('documents.editor.paragraphPlaceholder')}
      rows={Math.max(1, block.text.split('\n').length)}
      value={block.text}
    />
  )
}

function HeadingBlockEditor({
  block,
  onChange,
  t,
}: {
  block: DocumentHeadingBlock
  onChange: (block: DocumentBlock) => void
  t: (key: MessageKey) => string
}) {
  return (
    <div className="flex items-start gap-2">
      <select
        aria-label={t('documents.editor.headingLevel')}
        className="mt-1 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-1.5 py-1 text-xs font-semibold text-[var(--workbench-muted)]"
        onChange={(event) =>
          onChange({
            ...block,
            level: Number(event.target.value) as 1 | 2 | 3,
          })
        }
        value={block.level}
      >
        <option value="1">H1</option>
        <option value="2">H2</option>
        <option value="3">H3</option>
      </select>
      <input
        aria-label={t('documents.block.heading')}
        className={`min-w-0 flex-1 border-0 bg-transparent px-0 font-semibold leading-tight text-[var(--workbench-text)] outline-none placeholder:text-[var(--workbench-muted-soft)] ${
          block.level === 1
            ? 'text-3xl'
            : block.level === 2
              ? 'text-2xl'
              : 'text-xl'
        }`}
        onChange={(event) => onChange({ ...block, text: event.target.value })}
        placeholder={t('documents.editor.headingPlaceholder')}
        value={block.text}
      />
    </div>
  )
}

function TableBlockEditor({
  block,
  onChange,
  t,
}: {
  block: DocumentTableBlock
  onChange: (block: DocumentBlock) => void
  t: (key: MessageKey) => string
}) {
  const updateColumn = (columnIndex: number, text: string) => {
    const columns = [...block.columns]
    columns[columnIndex] = text
    onChange({ ...block, columns })
  }
  const updateCell = (rowIndex: number, cellIndex: number, text: string) => {
    const rows = block.rows.map((row, currentRowIndex) =>
      currentRowIndex === rowIndex
        ? {
            ...row,
            cells: row.cells.map((cell, currentCellIndex) =>
              currentCellIndex === cellIndex ? { ...cell, text } : cell,
            ),
          }
        : row,
    )
    onChange({ ...block, rows })
  }
  const addRow = () => {
    onChange({
      ...block,
      rows: [
        ...block.rows,
        {
          cells: block.columns.map(() => ({
            id: createLocalId('cell'),
            text: '',
          })),
          id: createLocalId('row'),
        },
      ],
    })
  }
  const addColumn = () => {
    onChange({
      ...block,
      columns: [
        ...block.columns,
        `${t('documents.editor.column')} ${block.columns.length + 1}`,
      ],
      rows: block.rows.map((row) => ({
        ...row,
        cells: [...row.cells, { id: createLocalId('cell'), text: '' }],
      })),
    })
  }

  /**
   * Removes one row from the table.
   *
   * @param rowIndex - Index of the row to remove.
   * @returns Nothing; the changed block is passed to `onChange`.
   */
  const deleteRow = (rowIndex: number) => {
    onChange({ ...block, rows: block.rows.filter((_, index) => index !== rowIndex) })
  }
  /**
   * Removes one column and its cell in every row. The last remaining column is kept.
   *
   * @param columnIndex - Index of the column to remove.
   * @returns Nothing; the changed block is passed to `onChange`.
   */
  const deleteColumn = (columnIndex: number) => {
    if (block.columns.length <= 1) return
    onChange({
      ...block,
      columns: block.columns.filter((_, index) => index !== columnIndex),
      rows: block.rows.map((row) => ({
        ...row,
        cells: row.cells.filter((_, index) => index !== columnIndex),
      })),
    })
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--workbench-border)]">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse">
          <thead>
            <tr className="bg-[var(--workbench-surface-muted)]">
              {block.columns.map((column, columnIndex) => (
                <th
                  className="border-b border-r border-[var(--workbench-border)] p-0 last:border-r-0"
                  key={`${block.id}-column-${columnIndex}`}
                >
                  <div className="flex items-center">
                    <input
                      aria-label={`${t('documents.editor.column')} ${columnIndex + 1}`}
                      className="min-w-0 flex-1 border-0 bg-transparent px-3 py-2.5 text-left text-xs font-bold text-[var(--workbench-muted)] outline-none"
                      onChange={(event) =>
                        updateColumn(columnIndex, event.target.value)
                      }
                      value={column}
                    />
                    {block.columns.length > 1 ? (
                      <TableRemoveButton
                        label={`${t('documents.editor.deleteColumn')} ${columnIndex + 1}`}
                        onClick={() => deleteColumn(columnIndex)}
                      />
                    ) : null}
                  </div>
                </th>
              ))}
              <th aria-hidden="true" className="w-8 border-b border-[var(--workbench-border)]" />
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={row.id}>
                {row.cells.map((cell, cellIndex) => (
                  <td
                    className="border-b border-r border-[var(--workbench-border)] p-0 last:border-r-0"
                    key={cell.id}
                  >
                    <input
                      aria-label={`${t('documents.editor.cell')} ${rowIndex + 1}-${cellIndex + 1}`}
                      className="w-full border-0 bg-surface px-3 py-3 text-sm font-medium text-[var(--workbench-text)] outline-none focus:bg-tone-f8fffd"
                      onChange={(event) =>
                        updateCell(rowIndex, cellIndex, event.target.value)
                      }
                      value={cell.text}
                    />
                  </td>
                ))}
                <td className="w-8 border-b border-[var(--workbench-border)] p-0 text-center">
                  <TableRemoveButton
                    label={`${t('documents.editor.deleteRow')} ${rowIndex + 1}`}
                    onClick={() => deleteRow(rowIndex)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2 bg-[var(--workbench-surface-muted)] p-2">
        <SmallEditorButton label={t('documents.editor.addRow')} onClick={addRow} />
        <SmallEditorButton
          label={t('documents.editor.addColumn')}
          onClick={addColumn}
        />
      </div>
    </div>
  )
}

function CodeBlockEditor({
  block,
  onChange,
  t,
}: {
  block: DocumentCodeBlock
  onChange: (block: DocumentBlock) => void
  t: (key: MessageKey) => string
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-700 bg-slate-900">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
        <input
          aria-label={t('documents.editor.codeLanguage')}
          className="ml-auto w-28 border-0 bg-transparent text-right font-mono text-xs text-fg-slate-300 outline-none"
          onChange={(event) =>
            onChange({ ...block, language: event.target.value })
          }
          value={block.language ?? ''}
        />
      </div>
      <textarea
        aria-label={t('documents.block.code')}
        className="min-h-32 w-full resize-y border-0 bg-transparent p-4 font-mono text-sm leading-6 text-fg-slate-100 outline-none"
        onChange={(event) => onChange({ ...block, code: event.target.value })}
        placeholder={t('documents.editor.codePlaceholder')}
        value={block.code}
      />
    </div>
  )
}

function ChecklistBlockEditor({
  block,
  checklistWorkItems,
  onChange,
  t,
}: {
  block: DocumentChecklistBlock
  checklistWorkItems?: ChecklistWorkItemControls
  onChange: (block: DocumentBlock) => void
  t: (key: MessageKey) => string
}) {
  const assignees = checklistWorkItems?.assignees
  const today = formatLocalCalendarDate(new Date())
  const onRetryAssignees = checklistWorkItems?.onRetryAssignees
  return (
    <div className="grid gap-2">
      {assignees && onRetryAssignees ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-fg-red-800"
          role="alert"
        >
          <span>{t('documents.checklistWorkItem.assigneesError')}</span>
          <button
            className="workbench-button-secondary min-h-8 px-3 text-xs"
            onClick={onRetryAssignees}
            type="button"
          >
            {t('documents.checklistWorkItem.retryAssignees')}
          </button>
        </div>
      ) : null}
      {block.items.map((item, index) => (
        <div
          className="grid gap-1 rounded-md px-2 py-1.5 hover:bg-[var(--workbench-surface-muted)]"
          key={item.id}
        >
          <label className="flex min-h-6 items-start gap-3">
            <input
              checked={item.checked}
              className="mt-1 h-4 w-4 accent-[var(--workbench-primary)]"
              onChange={(event) =>
                onChange({
                  ...block,
                  items: block.items.map((candidate) =>
                    candidate.id === item.id
                      ? { ...candidate, checked: event.target.checked }
                      : candidate,
                  ),
                })
              }
              type="checkbox"
            />
            <input
              aria-label={`${t('documents.block.checklist')} ${index + 1}`}
              className={`min-w-0 flex-1 border-0 bg-transparent text-sm font-medium outline-none ${
                item.checked
                  ? 'text-[var(--workbench-muted)] line-through'
                  : 'text-[var(--workbench-text)]'
              }`}
              onChange={(event) =>
                onChange({
                  ...block,
                  items: block.items.map((candidate) =>
                    candidate.id === item.id
                      ? { ...candidate, text: event.target.value }
                      : candidate,
                  ),
                })
              }
              placeholder={t('documents.editor.checklistPlaceholder')}
              value={item.text}
            />
            <ChecklistItemWorkItemAction
              blockId={block.id}
              controls={checklistWorkItems}
              item={item}
              t={t}
            />
            <button
              aria-label={t('documents.editor.deleteChecklistItem')}
              className="grid h-7 w-7 place-items-center rounded text-[var(--workbench-muted)] hover:bg-surface hover:text-[var(--workbench-danger)]"
              onClick={() =>
                onChange({
                  ...block,
                  items: block.items.filter(
                    (candidate) => candidate.id !== item.id,
                  ),
                })
              }
              type="button"
            >
              ×
            </button>
          </label>
          {assignees ? (
            <ChecklistItemOwnershipFields
              assignees={assignees}
              index={index}
              item={item}
              overdue={isChecklistItemOverdue(item, today)}
              t={t}
              onChange={(change) =>
                onChange(updateChecklistItemOwnership(block, item.id, change))
              }
            />
          ) : null}
        </div>
      ))}
      <button
        className="justify-self-start rounded-md px-2 py-1.5 text-xs font-semibold text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary-text)]"
        onClick={() =>
          onChange({
            ...block,
            items: [
              ...block.items,
              { checked: false, id: createLocalId('check'), text: '' },
            ],
          })
        }
        type="button"
      >
        + {t('documents.editor.addChecklistItem')}
      </button>
    </div>
  )
}

/**
 * Owner and deadline pickers shown under one editable checklist item.
 *
 * @param props - Offered owners, item, position, overdue state, and change callback.
 * @returns The two compact fields.
 */
function ChecklistItemOwnershipFields({
  assignees,
  index,
  item,
  onChange,
  overdue,
  t,
}: {
  /** Members offered as owners. */
  assignees: readonly ChecklistAssigneeOption[]
  /** Zero-based item position, used in the accessible names. */
  index: number
  /** Item whose owner and deadline are edited. */
  item: DocumentChecklistItem
  /** Saves an owner or deadline change. */
  onChange: (change: { assigneeMemberKey?: string, dueDate?: string }) => void
  /** Whether the open item is past its deadline. */
  overdue: boolean
  /** Resolves display text. */
  t: (key: MessageKey) => string
}) {
  const position = String(index + 1)
  // A saved owner who is no longer offered stays selectable, so editing the
  // deadline never clears the owner as a side effect.
  const hasUnlistedAssignee =
    item.assigneeMemberKey !== undefined &&
    !assignees.some((option) => option.id === item.assigneeMemberKey)
  const fieldClassName =
    'min-h-7 rounded border border-[var(--workbench-border)] bg-surface px-2 text-xs font-medium text-[var(--workbench-text)]'
  return (
    <div className="flex flex-wrap items-center gap-2 pl-7">
      <select
        aria-label={t('documents.checklistItem.assigneeLabel').replace('{position}', position)}
        className={`${fieldClassName} max-w-[220px]`}
        onChange={(event) => onChange({ assigneeMemberKey: event.target.value })}
        value={item.assigneeMemberKey ?? ''}
      >
        <option value="">{t('documents.checklistItem.noAssignee')}</option>
        {hasUnlistedAssignee ? (
          <option value={item.assigneeMemberKey}>{item.assigneeMemberKey}</option>
        ) : null}
        {assignees.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <input
        aria-label={t('documents.checklistItem.dueDateLabel').replace('{position}', position)}
        className={`${fieldClassName} ${
          overdue ? 'border-[var(--workbench-danger)] text-[var(--workbench-danger)]' : ''
        }`}
        max="9999-12-31"
        onChange={(event) => {
          // Browsers accept years past 9999 in date inputs; such a value
          // would make the whole save fail, so only calendar dates are kept.
          const { value } = event.target
          if (value === '' || /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
            onChange({ dueDate: value })
          }
        }}
        type="date"
        value={item.dueDate ?? ''}
      />
      {overdue ? (
        <span className="text-xs font-semibold text-[var(--workbench-danger)]">
          {t('documents.checklistItem.overdue')}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Shows the owner and deadline saved on a checklist item to read-only viewers.
 *
 * @param props - Item, offered owners, today's date, and translator.
 * @returns The owner and deadline text, or nothing when neither is set.
 */
function ChecklistItemOwnershipSummary({
  assignees,
  item,
  t,
  today,
}: {
  /** Members used to resolve the owner name. */
  assignees: readonly ChecklistAssigneeOption[]
  /** Item whose owner and deadline are shown. */
  item: DocumentChecklistItem
  /** Resolves display text. */
  t: (key: MessageKey) => string
  /** Viewer's local `YYYY-MM-DD` date. */
  today: string
}) {
  const assigneeLabel = resolveChecklistAssigneeLabel(assignees, item.assigneeMemberKey)
  if (!assigneeLabel && !item.dueDate) return null
  const overdue = isChecklistItemOverdue(item, today)
  return (
    <span className="flex flex-wrap gap-2 text-xs font-medium text-[var(--workbench-muted)]">
      {assigneeLabel ? (
        <span>{t('documents.checklistItem.assignee').replace('{name}', assigneeLabel)}</span>
      ) : null}
      {item.dueDate ? (
        <span className={overdue ? 'font-semibold text-[var(--workbench-danger)]' : ''}>
          {t(overdue ? 'documents.checklistItem.dueOverdue' : 'documents.checklistItem.due')
            .replace('{date}', item.dueDate)}
        </span>
      ) : null}
    </span>
  )
}

/**
 * Shows the Work Item linked to a checklist item, or the action that creates one.
 *
 * @param props - Checklist block ID, item, controls, and translator.
 * @returns The link, the create button, or nothing.
 */
function ChecklistItemWorkItemAction({
  blockId,
  controls,
  item,
  t,
}: {
  /** Checklist block that contains the item. */
  blockId: string
  /** Create and open actions; omission renders nothing. */
  controls?: ChecklistWorkItemControls
  /** Checklist item the action belongs to. */
  item: DocumentChecklistItem
  /** Resolves display text. */
  t: (key: MessageKey) => string
}) {
  if (!controls) return null
  const workItemId = findChecklistItemWorkItemId(
    controls.relations,
    blockId,
    item.id,
  )
  const actionClassName =
    'flex-none rounded px-2 py-1 text-xs font-semibold text-[var(--workbench-primary-text)] hover:bg-surface'
  if (workItemId) {
    const { onOpen } = controls
    return onOpen ? (
      <button
        className={actionClassName}
        onClick={(event) => {
          event.preventDefault()
          onOpen(workItemId)
        }}
        type="button"
      >
        {t('documents.checklistWorkItem.open')}
      </button>
    ) : (
      <span className="workbench-badge flex-none">
        {t('documents.checklistWorkItem.linked')}
      </span>
    )
  }
  const { onCreate } = controls
  if (!onCreate || item.text.trim().length === 0) return null
  return (
    <button
      className={actionClassName}
      onClick={(event) => {
        event.preventDefault()
        onCreate(blockId, item)
      }}
      type="button"
    >
      {t('documents.checklistWorkItem.create')}
    </button>
  )
}

function EmbedBlockEditor({
  block,
  onChange,
  t,
}: {
  block: DocumentEmbedBlock
  onChange: (block: DocumentBlock) => void
  t: (key: MessageKey) => string
}) {
  const safeUrl = resolveSafeEmbedUrl(block.url)

  return (
    <div className="rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr]">
        <input
          aria-label={t('documents.editor.embedTitle')}
          className="workbench-input min-h-10 px-3"
          onChange={(event) =>
            onChange({ ...block, title: event.target.value })
          }
          placeholder={t('documents.editor.embedTitle')}
          value={block.title ?? ''}
        />
        <input
          aria-label={t('documents.editor.embedUrl')}
          className="workbench-input min-h-10 px-3"
          onChange={(event) =>
            onChange({ ...block, url: event.target.value })
          }
          placeholder="https://"
          type="url"
          value={block.url}
        />
      </div>
      {safeUrl ? (
        <a
          className="mt-3 flex items-center gap-3 rounded-md border border-[var(--workbench-border)] bg-surface px-4 py-3 text-sm font-semibold text-[var(--workbench-primary-text)] no-underline hover:underline"
          href={safeUrl}
          rel="noreferrer"
          target={safeUrl.startsWith(window.location.origin) ? undefined : '_blank'}
        >
          <span aria-hidden="true">↗</span>
          <span className="min-w-0 truncate">
            {block.title || safeUrl}
          </span>
        </a>
      ) : block.url ? (
        <p className="m-0 mt-3 text-xs font-semibold text-[var(--workbench-danger)]">
          {t('documents.editor.embedUnsafe')}
        </p>
      ) : null}
    </div>
  )
}

function DiagramBlockEditor({
  block,
  onChange,
  t,
}: {
  block: DocumentDiagramBlock
  onChange: (block: DocumentBlock) => void
  t: (key: MessageKey) => string
}) {
  return (
    <div className="grid overflow-hidden rounded-lg border border-[var(--workbench-border)] md:grid-cols-2">
      <div className="border-b border-[var(--workbench-border)] bg-slate-900 p-3 md:border-b-0 md:border-r">
        <select
          aria-label={t('documents.editor.diagramFormat')}
          className="mb-2 rounded border border-white/15 bg-white/10 px-2 py-1 font-mono text-xs text-white"
          onChange={(event) =>
            onChange({
              ...block,
              format: event.target.value === 'mermaid' ? 'mermaid' : 'text',
            })
          }
          value={block.format}
        >
          <option value="text">text</option>
          {block.format === 'mermaid' ? <option value="mermaid">mermaid</option> : null}
        </select>
        <textarea
          aria-label={t('documents.block.diagram')}
          className="min-h-36 w-full resize-y border-0 bg-transparent font-mono text-xs leading-6 text-fg-slate-100 outline-none"
          onChange={(event) =>
            onChange({ ...block, source: event.target.value })
          }
          placeholder="A → B"
          value={block.source}
        />
      </div>
      <DiagramPreview
        format={block.format}
        source={block.source}
        t={t}
        title={t('documents.editor.preview')}
      />
    </div>
  )
}

function ReadOnlyBlock({
  block,
  checklistAssignees,
  checklistWorkItems,
  t,
}: {
  block: DocumentBlock
  /**
   * Members that name a checklist owner when the checklist controls offer none. Passing it shows
   * the saved owner and deadline even without the controls.
   */
  checklistAssignees?: readonly ChecklistAssigneeOption[]
  /** Open actions for checklist items with a Work Item; creation is never offered here. */
  checklistWorkItems?: ChecklistWorkItemControls
  t: (key: MessageKey) => string
}) {
  if (block.type === 'heading') {
    const content = block.text || t('documents.editor.untitledBlock')
    if (block.level === 1) {
      return <h2 className="mb-1 mt-8 text-3xl font-semibold">{content}</h2>
    }
    if (block.level === 2) {
      return <h3 className="mb-1 mt-7 text-2xl font-semibold">{content}</h3>
    }
    return <h4 className="mb-1 mt-6 text-xl font-semibold">{content}</h4>
  }

  if (block.type === 'table') {
    return (
      <div className="overflow-x-auto rounded-lg border border-[var(--workbench-border)]">
        <table className="w-full min-w-[420px] border-collapse text-left">
          <thead className="bg-[var(--workbench-surface-muted)]">
            <tr>
              {block.columns.map((column, index) => (
                <th
                  className="border-b border-r border-[var(--workbench-border)] px-3 py-2.5 text-xs font-bold text-[var(--workbench-muted)] last:border-r-0"
                  key={`${block.id}-readonly-column-${index}`}
                >
                  <DocumentLinkedText text={column} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row) => (
              <tr key={row.id}>
                {row.cells.map((cell) => (
                  <td
                    className="border-b border-r border-[var(--workbench-border)] px-3 py-3 text-sm font-medium last:border-r-0"
                    key={cell.id}
                  >
                    <DocumentLinkedText text={cell.text} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  if (block.type === 'code') {
    return (
      <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 font-mono text-sm leading-6 text-fg-slate-100">
        <code>{block.code}</code>
      </pre>
    )
  }

  if (block.type === 'checklist') {
    const today = formatLocalCalendarDate(new Date())
    const ownershipAssignees = checklistWorkItems?.assignees ?? checklistAssignees
    return (
      <ul className="m-0 grid list-none gap-2 p-0">
        {block.items.map((item) => (
          <li className="flex items-start gap-3 text-sm font-medium" key={item.id}>
            <span aria-hidden="true">{item.checked ? '☑' : '☐'}</span>
            <span className="grid min-w-0 gap-0.5">
              <span className={item.checked ? 'text-[var(--workbench-muted)] line-through' : ''}>
                <DocumentLinkedText text={item.text} />
              </span>
              {ownershipAssignees ? (
                <ChecklistItemOwnershipSummary
                  assignees={ownershipAssignees}
                  item={item}
                  t={t}
                  today={today}
                />
              ) : null}
            </span>
            <ChecklistItemWorkItemAction
              blockId={block.id}
              controls={
                checklistWorkItems
                  ? { onOpen: checklistWorkItems.onOpen, relations: checklistWorkItems.relations }
                  : undefined
              }
              item={item}
              t={t}
            />
          </li>
        ))}
      </ul>
    )
  }

  if (block.type === 'embed') {
    const safeUrl = resolveSafeEmbedUrl(block.url)
    return safeUrl ? (
      <a
        className="workbench-panel flex items-center gap-3 px-4 py-4 text-sm font-semibold text-[var(--workbench-primary-text)] no-underline hover:underline"
        href={safeUrl}
        rel="noreferrer"
      >
        <span aria-hidden="true">↗</span>
        {block.title || safeUrl}
      </a>
    ) : null
  }

  if (block.type === 'diagram') {
    return (
      <DiagramPreview
        format={block.format}
        source={block.source}
        t={t}
        title={t('documents.block.diagram')}
      />
    )
  }

  return (
    <SafeMarkdown
      bodyMarkdown={block.text}
      className="text-[1rem] leading-8 [&_p]:m-0 [&_p]:whitespace-pre-wrap"
      complexityNotice={t('documents.editor.markdownTooComplex')}
      rawHtml="escape"
    />
  )
}

/**
 * Draws a text flow diagram (`A → B`). Mermaid source is shown as source, because no Mermaid
 * renderer is bundled and drawing it as a flow would misrepresent it.
 *
 * @param props - Diagram format, source, and caption.
 * @returns The diagram figure.
 */
function DiagramPreview({
  format,
  source,
  t,
  title,
}: {
  /** Stored diagram format. */
  format: DocumentDiagramBlock['format']
  /** Diagram source. */
  source: string
  /** Translator. */
  t: (key: MessageKey) => string
  /** Accessible caption. */
  title: string
}) {
  if (format === 'mermaid') {
    return (
      <figure className="m-0 grid gap-2 bg-tone-f8fffd p-4">
        <figcaption className="text-xs font-semibold text-[var(--workbench-muted)]">
          {t('documents.editor.mermaidSource')}
        </figcaption>
        <pre className="m-0 overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-xs leading-6 text-fg-slate-100">
          <code>{source}</code>
        </pre>
      </figure>
    )
  }
  const steps = source
    .split(/(?:→|->|\n)/u)
    .map((step) => step.trim())
    .filter(Boolean)

  return (
    <figure className="m-0 grid min-h-36 content-center gap-3 bg-tone-f8fffd p-5">
      <figcaption className="sr-only">{title}</figcaption>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {steps.length > 0 ? (
          steps.map((step, index) => (
            <span className="contents" key={`${step}-${index}`}>
              {index > 0 ? (
                <span aria-hidden="true" className="text-[var(--workbench-muted-soft)]">
                  →
                </span>
              ) : null}
              <span className="rounded-md border border-tone-99d7cf bg-surface px-3 py-2 text-xs font-semibold text-[var(--workbench-text)] shadow-sm">
                {step}
              </span>
            </span>
          ))
        ) : (
          <span className="text-sm font-medium text-[var(--workbench-muted)]">
            {title}
          </span>
        )}
      </div>
    </figure>
  )
}

/**
 * Small button that removes one table row or column.
 *
 * @param props - Accessible label and click handler.
 * @returns The remove button.
 */
function TableRemoveButton({
  label,
  onClick,
}: {
  /** Accessible label naming the row or column. */
  label: string
  /** Removes the row or column. */
  onClick: () => void
}) {
  return (
    <button
      aria-label={label}
      className="grid h-7 w-7 flex-none place-items-center rounded text-xs text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-danger)]"
      onClick={onClick}
      title={label}
      type="button"
    >
      ×
    </button>
  )
}

function SmallEditorButton({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  return (
    <button
      className="rounded-md border border-[var(--workbench-border)] bg-surface px-2.5 py-1.5 text-xs font-semibold text-[var(--workbench-muted)] hover:border-tone-99d7cf hover:text-[var(--workbench-primary-text)]"
      onClick={onClick}
      type="button"
    >
      + {label}
    </button>
  )
}

const blockGlyphs: Record<DocumentBlock['type'], ReactNode> = {
  checklist: '☑',
  code: '</>',
  diagram: '◇',
  embed: '↗',
  heading: 'H',
  paragraph: '¶',
  table: '▦',
}

function createLocalId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}
