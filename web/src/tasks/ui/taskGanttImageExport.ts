import {
  resolveTaskGanttImagePixelRatio,
  type TaskGanttImage,
} from '../model/taskGanttImage'

/** File format offered by the Gantt image export. */
export type TaskGanttImageFormat = 'png' | 'svg'

/** Raised when a chart is too large for the browser to rasterize as one PNG. */
export class TaskGanttImageTooLargeError extends Error {
  /** Creates the error with a stable name for callers that show a message. */
  constructor() {
    super('The Gantt chart is too large for one PNG image.')
    this.name = 'TaskGanttImageTooLargeError'
  }
}

/**
 * Saves a Gantt image as a PNG or SVG file through a temporary download link.
 *
 * @param image - SVG document of the whole chart.
 * @param format - File format to save.
 * @param fileName - File name without an extension.
 * @returns Resolves once the download has been handed to the browser.
 * @throws TaskGanttImageTooLargeError when a PNG would exceed the browser's canvas limits.
 */
export async function downloadTaskGanttImage(
  image: TaskGanttImage,
  format: TaskGanttImageFormat,
  fileName: string,
): Promise<void> {
  const svgBlob = new Blob([image.svg], { type: 'image/svg+xml;charset=utf-8' })
  if (format === 'svg') {
    saveBlob(svgBlob, `${fileName}.svg`)
    return
  }
  const ratio = resolveTaskGanttImagePixelRatio(image.width, image.height)
  if (ratio === undefined) throw new TaskGanttImageTooLargeError()
  const pngBlob = await rasterizeSvg(svgBlob, image, ratio)
  saveBlob(pngBlob, `${fileName}.png`)
}

/**
 * Draws an SVG document onto a canvas and encodes it as PNG.
 *
 * @param svgBlob - SVG document.
 * @param image - Size of the document in CSS pixels.
 * @param ratio - Device pixels per CSS pixel.
 * @returns PNG data.
 */
async function rasterizeSvg(svgBlob: Blob, image: TaskGanttImage, ratio: number): Promise<Blob> {
  const url = URL.createObjectURL(svgBlob)
  try {
    const element = new Image()
    element.decoding = 'async'
    const loaded = new Promise<void>((resolve, reject) => {
      element.onload = () => resolve()
      element.onerror = () => reject(new Error('The Gantt image could not be drawn.'))
    })
    element.src = url
    await loaded
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(image.width * ratio)
    canvas.height = Math.ceil(image.height * ratio)
    const context = canvas.getContext('2d')
    if (!context) throw new TaskGanttImageTooLargeError()
    context.scale(ratio, ratio)
    context.drawImage(element, 0, 0, image.width, image.height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new TaskGanttImageTooLargeError())
      }, 'image/png')
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Hands a blob to the browser as a file download.
 *
 * @param blob - File content.
 * @param fileName - File name with its extension.
 */
function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  // The download has started from the click, so the object URL can be released afterwards.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
