/** Editor create 成功時だけ入力 reset を実行します。 */
export async function submitAutomationEditorCreate(
  request: () => Promise<unknown> | unknown,
  reset: () => void,
) {
  try {
    await request()
  } catch {
    return false
  }
  reset()
  return true
}
