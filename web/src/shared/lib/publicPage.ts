/**
 * Copies text to the browser clipboard.
 *
 * @param value - The text to copy.
 * @returns A promise that resolves when the text has been copied.
 * @throws When the Clipboard API is unavailable or rejects the write operation.
 */
export async function copyTextToClipboard(value: string) {
  if (!navigator.clipboard) {
    throw new Error('Clipboard API is unavailable.')
  }

  await navigator.clipboard.writeText(value)
}

/**
 * Validates the basic format of an email address entered in a public form.
 *
 * @param value - The email address to validate.
 * @returns Whether the value matches the expected basic email format.
 */
export function isValidEmailAddress(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}
