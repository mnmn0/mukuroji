import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
} from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

/**
 * PDF.js worker を設定し、署名付き URL から PDF 読み込み task を作成します。
 */
export function createPdfLoadingTask(url: string): PDFDocumentLoadingTask {
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  return getDocument({ url })
}
