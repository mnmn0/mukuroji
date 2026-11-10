// Kept outside offline.html so a strict script-src 'self' CSP still allows retry and auto-reload.
// It runs in the head, before the first paint, so the saved color theme applies without a flash.
// Keep the storage key, the accepted values, and the theme colors in sync with
// src/shared/lib/preferences/theme.ts and theme-bootstrap.js.
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
    // Storage is unavailable; the page keeps the default light theme like the application.
  }
  var metas = document.querySelectorAll('meta[name="theme-color"]')
  for (var index = 0; index < metas.length; index += 1) {
    var meta = metas[index]
    var scheme = preference === 'system'
      ? ((meta.getAttribute('media') || '').indexOf('dark') >= 0 ? 'dark' : 'light')
      : preference
    meta.setAttribute('content', themeColors[scheme])
  }
})()

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('retry').addEventListener('click', () => window.location.reload())
})
window.addEventListener('online', () => window.location.reload())
