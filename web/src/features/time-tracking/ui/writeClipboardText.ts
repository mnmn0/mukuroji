/**
 * Writes text to the system clipboard.
 *
 * @param text - Text to copy.
 * @returns Resolves once copied; rejects when the clipboard is unavailable or refused.
 */
export async function writeClipboardText(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error('Clipboard unavailable')
  await navigator.clipboard.writeText(text)
}
