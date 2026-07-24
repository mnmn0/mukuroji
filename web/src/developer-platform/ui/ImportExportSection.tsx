import type { FormEvent } from 'react'
import type { ImportDryRunReport, ImportJob } from '@mukuroji/contracts'
import { interpolate } from '../model/displayFormatting'
import {
  updateImportMapping,
  type DeveloperExportFormat,
  type DeveloperImportFieldMapping,
  type DeveloperImportFormat,
} from '../model/transfers'
import { SectionHeader } from './DeveloperPlatformSectionParts'
import { StatusBadge } from './DeveloperPlatformStatus'
import type {
  DeveloperImportProjectOption,
  DeveloperPlatformLabels,
  DeveloperPlatformOption,
} from './DeveloperPlatformView'

/**
 * Renders import mapping, dry-run reports, committed import status, and export actions.
 *
 * @param props - Import/export data, controlled form values, and action callbacks.
 * @returns The pure import/export section view.
 */
export function ImportExportSection({
  busyOperation,
  canExport,
  canImport,
  exportingFormat,
  format,
  importFile,
  importMappings,
  importProjectId,
  importProjectOptions,
  importTeamId,
  importTeamOptions,
  labels,
  latestImport,
  previewReport,
  onCommit,
  onExport,
  onFileChange,
  onFormatChange,
  onMappingChange,
  onProjectChange,
  onSubmit,
  onTeamChange,
}: {
  busyOperation?: string
  canExport: boolean
  canImport: boolean
  exportingFormat?: DeveloperExportFormat
  format: DeveloperImportFormat
  importFile?: File
  importMappings: DeveloperImportFieldMapping[]
  importProjectId: string
  importProjectOptions: DeveloperImportProjectOption[]
  importTeamId: string
  importTeamOptions: DeveloperPlatformOption[]
  labels: DeveloperPlatformLabels
  latestImport?: ImportJob
  previewReport?: ImportDryRunReport
  onCommit?: () => void
  onExport?: (format: DeveloperExportFormat) => Promise<void>
  onFileChange: (file?: File) => void
  onFormatChange: (format: DeveloperImportFormat) => void
  onMappingChange: (mapping: DeveloperImportFieldMapping[]) => void
  onProjectChange: (projectId: string) => void
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void
  onTeamChange: (teamId: string) => void
}) {
  const report = previewReport ?? latestImport?.report
  const reportStatus = previewReport
    ? previewReport.valid
      ? 'completed'
      : 'failed'
    : latestImport?.status

  return (
    <div className="grid min-w-0 gap-6">
      <section className="min-w-0">
        <SectionHeader
          description={labels.helpText.imports}
          title={labels.headings.imports}
        />
        <div className="mt-4 grid grid-cols-2 gap-3 max-[620px]:grid-cols-1">
          {(['csv', 'json'] as const).map((sourceFormat) => (
            <button
              aria-pressed={format === sourceFormat}
              className={`rounded-lg border p-4 text-left transition ${
                format === sourceFormat
                  ? 'border-[var(--workbench-primary)] bg-teal-50'
                  : 'border-[var(--workbench-border)] hover:border-[var(--workbench-border-strong)]'
              }`}
              disabled={!canImport}
              key={sourceFormat}
              onClick={() => onFormatChange(sourceFormat)}
              type="button"
            >
              <strong className="block text-sm text-[var(--workbench-text)]">
                {labels.headings[`source-${sourceFormat}`]}
              </strong>
              <span className="mt-2 block text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                {labels.helpText[`source-${sourceFormat}`]}
              </span>
            </button>
          ))}
        </div>

        {canImport && onSubmit ? (
          <form
            className="mt-4 grid gap-4 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4"
            onSubmit={onSubmit}
          >
            {importTeamOptions.length || importProjectOptions.length ? (
              <div className="grid grid-cols-2 gap-3 max-[620px]:grid-cols-1">
                {importTeamOptions.length ? (
                  <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                    {labels.fields.importTeam}
                    <select
                      className="workbench-input min-h-10 bg-white px-3 normal-case tracking-normal"
                      required
                      value={importTeamId}
                      onChange={(event) =>
                        onTeamChange(event.target.value)
                      }
                    >
                      {importTeamOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {importProjectOptions.length ? (
                  <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                    {labels.fields.importProject}
                    <select
                      className="workbench-input min-h-10 bg-white px-3 normal-case tracking-normal"
                      value={importProjectId}
                      onChange={(event) =>
                        onProjectChange(event.target.value)
                      }
                    >
                      <option value="">
                        {labels.placeholders.importProject}
                      </option>
                      {importProjectOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
            ) : null}
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
              {labels.fields.importFile}
              <input
                accept={
                  format === 'csv'
                    ? '.csv,text/csv'
                    : '.json,application/json'
                }
                className="workbench-input min-h-10 bg-white px-3 py-2 normal-case tracking-normal"
                required
                type="file"
                onChange={(event) =>
                  onFileChange(event.target.files?.[0])
                }
              />
            </label>

            <div className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold text-[var(--workbench-text)]">
                    {labels.headings.mapping}
                  </h4>
                  <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
                    {labels.helpText.mapping}
                  </p>
                </div>
                <button
                  className="workbench-button-secondary min-h-9 px-3"
                  onClick={() =>
                    onMappingChange([
                      ...importMappings,
                      { sourceField: '', targetField: '' },
                    ])
                  }
                  type="button"
                >
                  {labels.actions.addMapping}
                </button>
              </div>

              {importMappings.map((mapping, index) => (
                <div
                  className="grid grid-cols-[1fr_24px_1fr_auto] items-end gap-2 max-[660px]:grid-cols-1"
                  key={index}
                >
                  <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
                    {labels.fields.sourceField}
                    <input
                      className="workbench-input min-h-9 bg-white px-3"
                      placeholder={labels.placeholders.sourceField}
                      required
                      value={mapping.sourceField}
                      onChange={(event) =>
                        onMappingChange(
                          updateImportMapping(
                            importMappings,
                            index,
                            'sourceField',
                            event.target.value,
                          ),
                        )
                      }
                    />
                  </label>
                  <span
                    aria-hidden="true"
                    className="pb-2 text-center text-[var(--workbench-muted)] max-[660px]:hidden"
                  >
                    →
                  </span>
                  <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
                    {labels.fields.targetField}
                    <select
                      className="workbench-input min-h-9 bg-white px-3"
                      required
                      value={mapping.targetField}
                      onChange={(event) =>
                        onMappingChange(
                          updateImportMapping(
                            importMappings,
                            index,
                            'targetField',
                            event.target.value,
                          ),
                        )
                      }
                    >
                      <option value="">
                        {labels.placeholders.targetField}
                      </option>
                      {labels.importFieldOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="workbench-button-secondary min-h-9 px-3"
                    onClick={() =>
                      onMappingChange(
                        importMappings.filter(
                          (_, mappingIndex) => mappingIndex !== index,
                        ),
                      )
                    }
                    type="button"
                  >
                    {labels.actions.removeMapping}
                  </button>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--workbench-border)] pt-4">
              <p className="text-xs font-medium text-[var(--workbench-muted)]">
                {importFile?.name ?? labels.helpText.noFile}
              </p>
              <button
                className="workbench-button-primary min-h-10 px-4 disabled:opacity-50"
                disabled={
                  !importFile ||
                  !importTeamId ||
                  !importMappings.length ||
                  busyOperation === 'import:dry-run'
                }
                type="submit"
              >
                {labels.actions.dryRun}
              </button>
            </div>
          </form>
        ) : (
          <p className="mt-4 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4 text-sm font-medium text-[var(--workbench-muted)]">
            {labels.helpText.importReadOnly}
          </p>
        )}
      </section>

      {report || latestImport ? (
        <section className="border-t border-[var(--workbench-border)] pt-6">
          <SectionHeader
            description={labels.helpText.importReport}
            title={labels.headings.importReport}
          />
          <div
            className={`mt-4 rounded-lg border p-4 ${
              report?.invalidRows
                ? 'border-red-200 bg-red-50'
                : 'border-emerald-200 bg-emerald-50'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold text-[var(--workbench-text)]">
                {report
                  ? interpolate(labels.importReportSummary, {
                      invalid: report.invalidRows,
                      total: report.totalRows,
                      valid: report.validRows,
                    })
                  : latestImport?.error?.detail ??
                    latestImport?.error?.title ??
                    labels.helpText.importPending}
              </p>
              {reportStatus ? (
                <StatusBadge
                  labels={labels}
                  status={reportStatus}
                />
              ) : null}
            </div>
            {report?.errors.length ? (
              <ul className="mt-4 grid gap-2">
                {report.errors.map((error, index) => (
                  <li
                    className="rounded-md border border-red-200 bg-white px-3 py-2 text-xs text-red-800"
                    key={`${error.row}-${error.code}-${index}`}
                  >
                    <strong>
                      {labels.tableHeaders.row} {error.row}
                      {error.field ? ` · ${error.field}` : ''}
                    </strong>
                    <span className="ml-2">{error.message}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {canImport &&
            onCommit &&
            report &&
            report.invalidRows === 0 &&
            previewReport?.valid ? (
              <button
                className="workbench-button-primary mt-4 min-h-10 px-4"
                disabled={busyOperation?.startsWith('import:commit')}
                onClick={onCommit}
                type="button"
              >
                {labels.actions.commitImport}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="border-t border-[var(--workbench-border)] pt-6">
        <SectionHeader
          description={labels.helpText.exports}
          title={labels.headings.exports}
        />
        <div className="mt-4 flex flex-wrap gap-3">
          {(['csv', 'json'] as const).map((exportFormat) => (
            <button
              className="workbench-button-secondary min-h-10 px-4 disabled:opacity-50"
              disabled={
                !canExport ||
                !onExport ||
                exportingFormat === exportFormat
              }
              key={exportFormat}
              onClick={() => void onExport?.(exportFormat)}
              type="button"
            >
              {labels.actions[`export-${exportFormat}`]}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
