import { useState } from 'react'
import { useParams } from 'react-router'
import useSWR from 'swr'
import {
  exportPublicProjectStatusReportPdf,
  getPublicProjectStatusReport,
} from '../../projects/api/statusReports'
import { createProjectStatusReportFileName } from '../../projects/model/projectStatusReport'
import { saveProjectStatusReportFile } from '../../projects/ui/ProjectStatusReportDocument'
import { SharedProjectStatusReportScreen } from '../../projects/ui/SharedProjectStatusReportScreen'
import { getInitialLocale, setLocalePreference, type Locale } from '../../shared/i18n/i18n'

/**
 * Renders the read-only report of a share link from the token in the URL, without sign-in.
 *
 * @returns The public report page.
 */
export function SharedProjectStatusReportPage() {
  const token = useParams().shareToken ?? ''
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale())
  const published = useSWR(
    token ? ['public-project-status', token] as const : null,
    ([, currentToken]) => getPublicProjectStatusReport(currentToken),
    { shouldRetryOnError: false, revalidateOnFocus: false },
  )
  return (
    <SharedProjectStatusReportScreen
      isLoading={published.isLoading}
      isUnavailable={!token || Boolean(published.error)}
      locale={locale}
      onDownloadPdf={async () => {
        if (!published.data) return
        saveProjectStatusReportFile(
          await exportPublicProjectStatusReportPdf(token),
          createProjectStatusReportFileName(published.data.report, 'pdf'),
        )
      }}
      onLocaleChange={(nextLocale) => {
        setLocale(nextLocale)
        setLocalePreference(nextLocale)
      }}
      published={published.data}
    />
  )
}
