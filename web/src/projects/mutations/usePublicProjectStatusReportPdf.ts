import { useCallback } from 'react'
import { exportPublicProjectStatusReportPdf } from '../api/statusReports'

/**
 * Downloads the PDF of a public share link, which the server renders from the stored snapshot
 * and counts as a view.
 *
 * @param token - Share token from the URL.
 * @returns The download action, which resolves to the PDF file.
 */
export function usePublicProjectStatusReportPdf(token: string) {
  const download = useCallback(() => exportPublicProjectStatusReportPdf(token), [token])
  return { download }
}
