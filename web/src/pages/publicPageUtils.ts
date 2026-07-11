/**
 * 指定文字列をブラウザの clipboard へコピーします。
 */
export async function copyTextToClipboard(value: string) {
  if (!navigator.clipboard) {
    throw new Error('Clipboard API is unavailable.')
  }

  await navigator.clipboard.writeText(value)
}

/**
 * 公開フォームで入力されたメールアドレスの基本形式を検証します。
 */
export function isValidEmailAddress(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}
