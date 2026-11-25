import { getFileTypeDefinition, type FileTypeId, type FileTypeRejection } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Message that explains each rejection reason. */
const REJECTION_REASON_KEYS: Record<FileTypeRejection['reason'], MessageKey> = {
  dangerous: 'files.error.typeDangerous',
  unrecognized: 'files.error.typeUnrecognized',
  'not-allowed': 'files.error.typeNotAllowed',
}

/**
 * Lists the extensions of File types, as people recognize them.
 *
 * @param ids - File type identifiers in display order.
 * @returns Extensions such as `.md, .markdown, .xlsx`, or an empty string when there are none.
 */
export function formatFileTypeExtensions(ids: readonly FileTypeId[]): string {
  return ids
    .flatMap((id) => getFileTypeDefinition(id).extensions)
    .map((extension) => `.${extension}`)
    .join(', ')
}

/**
 * Explains why a file was refused and what may be attached instead.
 *
 * @param rejection - Details of the `415 FileTypeNotAllowed` response.
 * @param t - Translator.
 * @returns One sentence with the reason, followed by the accepted extensions.
 */
export function describeFileTypeRejection(
  rejection: FileTypeRejection,
  t: (key: MessageKey) => string,
): string {
  const reason = t(REJECTION_REASON_KEYS[rejection.reason])
  const extensions = formatFileTypeExtensions(rejection.allowedFileTypes)
  return extensions
    ? `${reason} ${t('files.error.allowedTypes').replace('{types}', extensions)}`
    : `${reason} ${t('files.error.noAllowedTypes')}`
}
