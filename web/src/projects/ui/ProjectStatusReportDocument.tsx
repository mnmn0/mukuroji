import { createProjectStatusReportOutline, type ProjectStatusReport } from '@mukuroji/contracts'

/** Props of {@link ProjectStatusReportDocument}. */
export type ProjectStatusReportDocumentProps = {
  /** Report to show. */
  report: ProjectStatusReport
}

/**
 * Shows a status report as a document, with the same text the Markdown, PDF, and slide
 * exports write.
 *
 * @param props - Report.
 * @returns The report article.
 */
export function ProjectStatusReportDocument({ report }: ProjectStatusReportDocumentProps) {
  const outline = createProjectStatusReportOutline(report)
  return (
    <article className="grid gap-5 text-[var(--workbench-text)]" data-testid="project-status-report" lang={report.locale}>
      <header className="grid gap-1">
        <h1 className="break-words text-2xl font-semibold">{outline.title}</h1>
        <p className="text-sm font-medium text-[var(--workbench-muted)]">{outline.subtitle}</p>
      </header>
      {outline.sections.map((section) => (
        <section className="grid gap-2" data-testid={`project-status-report-${section.section}`} key={section.section}>
          <h2 className="border-b border-[var(--workbench-border)] pb-1 text-base font-semibold">{section.heading}</h2>
          <ul className="grid gap-1 pl-5 text-sm leading-6">
            {section.lines.map((line, index) => (
              <li
                className={line.startsWith('  ') ? 'ml-4 list-[circle] text-[var(--workbench-muted)]' : 'list-disc'}
                // The lines of a section never reorder, so their position identifies them.
                key={`${section.section}-${index}`}
              >
                <span className="whitespace-pre-wrap break-words">{line.trim()}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  )
}
