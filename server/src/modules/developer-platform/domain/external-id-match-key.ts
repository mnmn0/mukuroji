/**
 * Returns the key that identifies a linked external resource within its provider. GitHub owner and
 * repository names are case-insensitive, so `Acme/App#12` and `acme/app#12` name the same issue and
 * share one key; every other provider compares its IDs as they are.
 *
 * @param provider - Connector provider of the link.
 * @param externalId - External resource ID as stored on the link.
 * @returns The comparison key for the resource.
 */
export function externalIdMatchKey(provider: string, externalId: string): string {
  if (provider !== 'github') return externalId
  const separator = externalId.lastIndexOf('#')
  return separator < 0 ? externalId : `${externalId.slice(0, separator).toLowerCase()}${externalId.slice(separator)}`
}
