// Applies the saved color theme before the first paint so returning dark-mode users do not
// see a light flash while the application bundle loads. It is a classic same-origin script,
// not inline, so a strict script-src 'self' CSP still allows it. Keep the storage key and the
// accepted values in sync with src/shared/lib/preferences/theme.ts.
;(function () {
  try {
    var preference = window.localStorage.getItem('mukuroji.theme')
    if (preference === 'light' || preference === 'dark' || preference === 'system') {
      document.documentElement.dataset.theme = preference
    }
  } catch (error) {
    // Storage is unavailable; the application applies the default theme when it starts.
  }
})()
