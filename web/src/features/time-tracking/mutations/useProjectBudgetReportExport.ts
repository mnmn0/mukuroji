import { useCallback, useState } from 'react'
import { downloadProjectBudgetReportCsv, type ProjectBudgetReportInput } from '../api/projectBudgetReport'

/** State and action of the Project budget report CSV export. */
export type ProjectBudgetReportExport = {
  /** Whether a download is in progress. */
  isExporting: boolean
  /** Whether the last download failed. */
  hasExportError: boolean
  /** Downloads the CSV of the given report and offers it as a file. */
  exportCsv: (input: ProjectBudgetReportInput) => void
}

/**
 * Offers a CSV body as a file download.
 *
 * @param blob - CSV body.
 * @param fileName - Offered file name.
 */
function triggerCsvDownload(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}

/**
 * Creates the CSV export of one Project's budget report, tracking whether it runs and whether
 * it failed.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @returns Export state and action.
 */
export function useProjectBudgetReportExport(
  accessToken: string | undefined,
  teamId: string | undefined,
  projectId: string | undefined,
): ProjectBudgetReportExport {
  const [isExporting, setIsExporting] = useState(false)
  const [hasExportError, setHasExportError] = useState(false)
  const exportCsv = useCallback((input: ProjectBudgetReportInput) => {
    if (!accessToken || !teamId || !projectId) return
    setIsExporting(true)
    setHasExportError(false)
    void downloadProjectBudgetReportCsv(accessToken, teamId, projectId, input)
      .then((blob) => triggerCsvDownload(blob, `project-budget-${projectId}-${input.from}-${input.to}.csv`))
      .catch(() => setHasExportError(true))
      .finally(() => setIsExporting(false))
  }, [accessToken, projectId, teamId])
  return { isExporting, hasExportError, exportCsv }
}
