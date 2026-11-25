import { describe, expect, test } from 'bun:test'
import type { FileTypeRejection } from '@mukuroji/contracts'
import { FilesApiError } from '../src/files/api/errors'
import { uploadFilesInOrder } from '../src/files/mutations/fileUploadBatch'

const rejection: FileTypeRejection = { reason: 'dangerous', allowedFileTypes: ['pdf'] }

/**
 * Uploads every file except `script.js`, which the server refuses because of its type.
 *
 * @param uploaded - Receives the names of the stored files.
 * @returns The per-file upload function.
 */
function createUploader(uploaded: string[]) {
  return async (file: File) => {
    if (file.name === 'script.js') {
      throw new FilesApiError(415, 'This file type cannot be attached.', 'FileTypeNotAllowed', rejection)
    }
    if (file.name === 'broken.pdf') throw new FilesApiError(500, 'files.error.upload')
    uploaded.push(file.name)
  }
}

describe('uploading selected files in order', () => {
  test('skips a file refused because of its type and still uploads the rest', async () => {
    const uploaded: string[] = []
    const rejected: Array<{ name: string; rejection: FileTypeRejection }> = []
    await uploadFilesInOrder(
      [new File(['x'], 'script.js'), new File(['x'], 'report.pdf')],
      createUploader(uploaded),
      (refused, file) => rejected.push({ name: file.name, rejection: refused }),
    )
    expect(uploaded).toEqual(['report.pdf'])
    expect(rejected).toEqual([{ name: 'script.js', rejection }])
  })

  test('stops at a type rejection when nobody handles it, and at any other failure', async () => {
    const uploaded: string[] = []
    await expect(uploadFilesInOrder(
      [new File(['x'], 'script.js'), new File(['x'], 'report.pdf')],
      createUploader(uploaded),
    )).rejects.toMatchObject({ code: 'FileTypeNotAllowed' })
    await expect(uploadFilesInOrder(
      [new File(['x'], 'broken.pdf'), new File(['x'], 'report.pdf')],
      createUploader(uploaded),
      () => undefined,
    )).rejects.toMatchObject({ status: 500 })
    expect(uploaded).toEqual([])
  })
})
