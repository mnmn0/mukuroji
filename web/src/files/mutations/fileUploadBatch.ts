import type { FileTypeRejection } from '@mukuroji/contracts'
import { FilesApiError } from '../api/errors'

/**
 * Uploads selected files one by one. When `onFileTypeRejected` is given, a file the server refuses
 * because of its type is reported and skipped, and the rest still upload; any other failure stops
 * the batch and is rethrown.
 *
 * @param files - Files in the order the user selected them.
 * @param uploadOne - Uploads one file and resolves once it is stored.
 * @param onFileTypeRejected - Receives each type rejection; without it, a rejection stops the batch.
 * @returns Resolves when every file was uploaded or skipped.
 */
export async function uploadFilesInOrder(
  files: readonly File[],
  uploadOne: (file: File) => Promise<void>,
  onFileTypeRejected?: (rejection: FileTypeRejection, file: File) => void,
): Promise<void> {
  for (const file of files) {
    try {
      await uploadOne(file)
    } catch (error) {
      if (onFileTypeRejected && error instanceof FilesApiError && error.fileTypeRejection) {
        onFileTypeRejected(error.fileTypeRejection, file)
        continue
      }
      throw error
    }
  }
}
