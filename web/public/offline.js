// Kept outside offline.html so a strict script-src 'self' CSP still allows retry and auto-reload.
document.getElementById('retry').addEventListener('click', () => window.location.reload())
window.addEventListener('online', () => window.location.reload())
