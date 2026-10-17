// Applies the saved color theme before the first paint so returning dark-mode users do not
// see a light flash while the application bundle loads. It is a classic same-origin script,
// not inline, so a strict script-src 'self' CSP still allows it. Keep the storage key, the
// accepted values, and the theme colors in sync with src/shared/lib/preferences/theme.ts.
;(function () {
  var themeColors = { dark: '#0e1412', light: '#f7f9f8' }
  var preference = 'light'
  try {
    var savedPreference = window.localStorage.getItem('mukuroji.theme')
    if (savedPreference === 'light' || savedPreference === 'dark' || savedPreference === 'system') {
      preference = savedPreference
      document.documentElement.dataset.theme = savedPreference
    }
  } catch {
    // Storage is unavailable; the application applies the default theme when it starts.
  }
  // index.html declares one theme-color meta per color scheme. An explicit theme points both at
  // its canvas color, while `system` keeps each meta on its media query's color.
  var metas = document.querySelectorAll('meta[name="theme-color"]')
  for (var index = 0; index < metas.length; index += 1) {
    var meta = metas[index]
    var scheme = preference === 'system'
      ? ((meta.getAttribute('media') || '').indexOf('dark') >= 0 ? 'dark' : 'light')
      : preference
    meta.setAttribute('content', themeColors[scheme])
  }
})()
