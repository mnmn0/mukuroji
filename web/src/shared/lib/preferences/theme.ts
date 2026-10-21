/**
 * Color themes the user can choose for the application.
 */
export const themePreferenceOptions = ['light', 'dark', 'system'] as const

/**
 * Color theme selected by the user; `system` follows the operating system setting.
 */
export type ThemePreference = (typeof themePreferenceOptions)[number]

/** Theme used before the user chooses one, preserving the original light appearance. */
const defaultThemePreference: ThemePreference = 'light'
/** Browser storage key that persists the theme on this device. */
const storageKey = 'mukuroji.theme'
/**
 * Browser chrome colors that match `--workbench-canvas` in `index.css`. Keep them in sync with
 * the stylesheet, `public/theme-bootstrap.js`, and `index.html`.
 */
const themeColors = { dark: '#0e1412', light: '#f7f9f8' }

/**
 * Resolves the initial theme from the saved preference.
 *
 * @returns The saved theme, or `light` when none is saved or storage is unavailable.
 */
export function getInitialThemePreference(): ThemePreference {
  try {
    const savedPreference = window.localStorage.getItem(storageKey)
    return isThemePreference(savedPreference) ? savedPreference : defaultThemePreference
  } catch {
    return defaultThemePreference
  }
}

/**
 * Checks whether a value is a supported theme preference.
 *
 * @param value - Candidate value, usually read from storage.
 * @returns Whether the value is `light`, `dark`, or `system`.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return themePreferenceOptions.some((option) => option === value)
}

/**
 * Applies a theme to the HTML root, where the stylesheet selects the matching colors.
 *
 * @param preference - Theme to apply.
 */
export function applyThemePreference(preference: ThemePreference) {
  document.documentElement.dataset.theme = preference
  applyThemeColor(preference)
}

/**
 * Updates the `theme-color` metas so the browser chrome follows the applied theme.
 *
 * `index.html` declares one meta per `prefers-color-scheme` media query. An explicit theme sets
 * both to that theme's canvas color; `system` restores each meta to its media query's color.
 *
 * @param preference - Theme applied to the page.
 */
function applyThemeColor(preference: ThemePreference) {
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const scheme = preference === 'system'
      ? meta.getAttribute('media')?.includes('dark') ? 'dark' : 'light'
      : preference
    meta.setAttribute('content', themeColors[scheme])
  }
}

/**
 * Saves the selected theme and applies it to the current page.
 *
 * @param preference - Theme selected by the user.
 */
export function setThemePreference(preference: ThemePreference) {
  try {
    window.localStorage.setItem(storageKey, preference)
  } catch {
    // The theme still applies to this page when storage is unavailable.
  }
  applyThemePreference(preference)
}
