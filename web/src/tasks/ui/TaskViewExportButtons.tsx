import type { MessageKey } from '../../shared/i18n/i18n'
import { triggerDeveloperExportDownload } from '../../developer-platform/ui/developerExportDownload'
import {
  createTaskViewExportFile,
  taskViewExportFormats,
  type TaskViewExportFormat,
  type TaskViewExportTable,
} from '../../task-views/model/taskViewExport'

/** Props for the export buttons of a view. */
type TaskViewExportButtonsProps = {
  /** Builds the rows and columns the view shows when a button is pressed. */
  createTable: () => TaskViewExportTable
  /** File name without the date and extension. */
  fileBaseName: string
  /** Test id of the button group. */
  testId: string
  /** Translator used for labels. */
  t: (key: MessageKey) => string
}

/** Message key of each export button. */
const exportLabelKeys: Record<TaskViewExportFormat, MessageKey> = {
  csv: 'tasks.export.csv',
  xlsx: 'tasks.export.xlsx',
}

/**
 * Renders the "export as CSV / Excel" buttons of a view, hidden on paper.
 *
 * The file holds the rows and columns the view shows, with the filters and columns of the view
 * applied, so a member exports only the Work Items and values they can already read.
 *
 * @param props - Table builder, file name, test id, and translator.
 * @returns The export button group.
 */
export function TaskViewExportButtons({ createTable, fileBaseName, testId, t }: TaskViewExportButtonsProps) {
  /** Builds the file of the current view and starts its download. */
  const exportView = (format: TaskViewExportFormat) => {
    const file = createTaskViewExportFile(createTable(), format, fileBaseName)
    triggerDeveloperExportDownload(file.blob, file.fileName)
  }
  return (
    <div
      aria-label={t('tasks.export.group')}
      className="flex items-center gap-2"
      data-print-hidden=""
      data-testid={testId}
      role="group"
    >
      {taskViewExportFormats.map((format) => (
        <button
          className="rounded-md border border-[var(--workbench-border)] bg-surface px-2.5 py-1 text-xs font-semibold text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]"
          data-testid={`${testId}-${format}`}
          key={format}
          onClick={() => exportView(format)}
          type="button"
        >
          {t(exportLabelKeys[format])}
        </button>
      ))}
    </div>
  )
}
