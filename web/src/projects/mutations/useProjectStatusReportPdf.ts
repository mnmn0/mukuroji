import type { ProjectStatusReport } from '@mukuroji/contracts'
import { useCallback } from 'react'
import { exportProjectStatusReportPdf } from '../api/statusReports'

/**
 * Exports a Project status report as a PDF that the server renders from the report the caller
 * built.
 *
 * @param accessToken - Session access token; the export fails while it is missing.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project the report is about.
 * @returns The export action, which resolves to the PDF file.
 */
export function useProjectStatusReportPdf(accessToken: string | undefined, teamId: string, projectId: string) {
  const download = useCallback(async (report: ProjectStatusReport) => {
    if (!accessToken) throw new Error('The session is not ready.')
    return exportProjectStatusReportPdf(accessToken, teamId, projectId, report)
  }, [accessToken, projectId, teamId])
  return { download }
}
