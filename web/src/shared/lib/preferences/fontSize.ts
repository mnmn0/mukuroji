/**
 * アプリ全体で選択できるフォントサイズ設定の候補です。
 */
export const fontSizePreferenceOptions = [
  'compact',
  'standard',
  'comfortable',
] as const

/**
 * ユーザーが選択できるフォントサイズ設定です。
 */
export type FontSizePreference = (typeof fontSizePreferenceOptions)[number]

const defaultFontSizePreference: FontSizePreference = 'standard'
const storageKey = 'mukuroji.fontSize'

/**
 * 保存済み設定から初期フォントサイズ設定を解決します。
 */
export function getInitialFontSizePreference(): FontSizePreference {
  const savedPreference = window.localStorage.getItem(storageKey)

  return isFontSizePreference(savedPreference)
    ? savedPreference
    : defaultFontSizePreference
}

/**
 * 指定された値がフォントサイズ設定として扱えるかを判定します。
 */
export function isFontSizePreference(value: unknown): value is FontSizePreference {
  return typeof value === 'string' && fontSizePreferenceOptions.includes(value as FontSizePreference)
}

/**
 * フォントサイズ設定を HTML root の data 属性へ反映します。
 */
export function applyFontSizePreference(preference: FontSizePreference) {
  document.documentElement.dataset.fontSize = preference
}

/**
 * ユーザーが選択したフォントサイズ設定を保存し、現在の画面へ反映します。
 */
export function setFontSizePreference(preference: FontSizePreference) {
  window.localStorage.setItem(storageKey, preference)
  applyFontSizePreference(preference)
}
