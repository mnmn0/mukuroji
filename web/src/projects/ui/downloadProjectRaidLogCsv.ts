/**
 * Offers CSV text as a UTF-8 file download.
 *
 * @param csv - CSV text.
 * @param fileName - Offered file name.
 */
export function downloadProjectRaidLogCsv(csv: string, fileName: string) {
  // The byte order mark makes Excel read the UTF-8 file, including Japanese text, correctly.
  const objectUrl = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}
