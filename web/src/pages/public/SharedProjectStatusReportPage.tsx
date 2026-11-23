import { useState } from 'react'
import { useParams } from 'react-router'
import { createProjectStatusReportFileName } from '../../projects/model/projectStatusReport'
import { usePublicProjectStatusReportPdf } from '../../projects/mutations/usePublicProjectStatusReportPdf'
import { usePublicProjectStatusReport } from '../../projects/queries/usePublicProjectStatusReport'
import { saveProjectStatusReportFile } from '../../projects/ui/useProjectStatusReportPrint'
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
  const { published, isLoading, isUnavailable, hasFailed, isRetrying, retry } = usePublicProjectStatusReport(token)
  const pdf = usePublicProjectStatusReportPdf(token)
  return (
    <SharedProjectStatusReportScreen
      hasFailed={hasFailed}
      isLoading={isLoading}
      isRetrying={isRetrying}
      isUnavailable={isUnavailable}
      locale={locale}
      onDownloadPdf={async () => {
        if (!published) return
        saveProjectStatusReportFile(
          await pdf.download(),
          createProjectStatusReportFileName(published.report, 'pdf'),
        )
      }}
      onRetry={retry}
      onLocaleChange={(nextLocale) => {
        setLocale(nextLocale)
        setLocalePreference(nextLocale)
      }}
      published={published}
    />
  )
}
