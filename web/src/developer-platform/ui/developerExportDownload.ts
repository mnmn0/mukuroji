/**
 * Browser primitives used to start and clean up a Developer Platform export.
 */
export type DeveloperExportDownloadEnvironment = {
  /** Creates an object URL for an exported Blob. */
  createObjectUrl: (blob: Blob) => string
  /** Creates the anchor used to initiate the browser download. */
  createAnchor: () => Pick<HTMLAnchorElement, 'click' | 'download' | 'href'>
  /** Schedules cleanup after the browser has handled the click. */
  scheduleCleanup: (cleanup: () => void) => void
  /** Releases a previously created object URL. */
  revokeObjectUrl: (objectUrl: string) => void
}

const browserDeveloperExportDownloadEnvironment: DeveloperExportDownloadEnvironment = {
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  createAnchor: () => document.createElement('a'),
  scheduleCleanup: (cleanup) => {
    window.setTimeout(cleanup, 0)
  },
  revokeObjectUrl: (objectUrl) => URL.revokeObjectURL(objectUrl),
}

/**
 * Starts a browser download and defers object URL cleanup to the next task.
 *
 * @param blob - Export payload returned by the Developer Platform API.
 * @param fileName - File name offered by the browser download.
 * @param environment - Browser operations, injectable for deterministic tests.
 * @returns Nothing.
 */
export function triggerDeveloperExportDownload(
  blob: Blob,
  fileName: string,
  environment = browserDeveloperExportDownloadEnvironment,
): void {
  const objectUrl = environment.createObjectUrl(blob)
  const anchor = environment.createAnchor()

  anchor.href = objectUrl
  anchor.download = fileName
  anchor.click()
  environment.scheduleCleanup(() => {
    environment.revokeObjectUrl(objectUrl)
  })
}
