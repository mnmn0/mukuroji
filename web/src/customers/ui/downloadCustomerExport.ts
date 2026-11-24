import type { CustomerWorkspaceExport } from '@mukuroji/contracts'

/**
 * Builds the offered file name of a Customer export from its export instant.
 *
 * @param exportedAt ISO instant the server stamped on the export.
 * @returns A file name such as `customers-export-2026-11-24.json`.
 */
export function createCustomerExportFileName(exportedAt: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(exportedAt)?.[0] ?? 'export'
  return `customers-export-${day}.json`
}

/**
 * Offers one Customer export as a UTF-8 JSON file download.
 *
 * @param value Export returned by the Customer API.
 */
export function downloadCustomerExport(value: CustomerWorkspaceExport): void {
  const objectUrl = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: 'application/json;charset=utf-8',
  }))
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = createCustomerExportFileName(value.exportedAt)
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}
