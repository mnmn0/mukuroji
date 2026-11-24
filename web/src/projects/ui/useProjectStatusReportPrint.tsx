import type { ProjectStatusReport } from '@mukuroji/contracts'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ProjectStatusReportDocument } from './ProjectStatusReportDocument'

/**
 * Prints a report on A4 paper without the workbench around it.
 *
 * The report is rendered into a `.document-print-root` element directly under `body`, which the
 * Document print styles show alone on A4, and the print dialog opens once it is in place.
 *
 * @returns The print function and the portal element to render.
 */
export function useProjectStatusReportPrint() {
  const [printing, setPrinting] = useState<ProjectStatusReport>()
  useEffect(() => {
    if (!printing) return undefined
    const restore = () => setPrinting(undefined)
    window.addEventListener('afterprint', restore, { once: true })
    const frame = window.requestAnimationFrame(() => window.print())
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('afterprint', restore)
    }
  }, [printing])
  return {
    print: (report: ProjectStatusReport) => setPrinting(report),
    portal: printing
      ? createPortal(
          <div className="document-print-root">
            <ProjectStatusReportDocument report={printing} />
          </div>,
          document.body,
        )
      : null,
  }
}

/**
 * Saves a file the browser built or downloaded.
 *
 * @param blob - File content.
 * @param fileName - Suggested file name.
 */
export function saveProjectStatusReportFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.rel = 'noopener noreferrer'
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
