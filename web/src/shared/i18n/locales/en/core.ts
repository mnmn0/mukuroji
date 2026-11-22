/**
 * English messages for the core domain.
 */
export const coreMessages = {
  'app.title': 'mukuroji',
  'app.update.available': 'A new version is available. Reload to update.',
  'app.update.reload': 'Reload',
  'app.update.dismiss': 'Later',
  'app.buildDrift.available': 'This screen and the server run different versions. Reload to bring this screen up to date.',
  'app.buildDrift.persisting': 'This screen and the server still run different versions after reloading. An update may be in progress, so reload again in a few minutes.',
  'app.connectivity.offline': 'You’re offline. What you see may be out of date, and changes can’t be saved until the connection is back.',
  'app.connectivity.online': 'You’re back online. Loading the latest content.',
  'app.maintenance.readOnly': 'Maintenance in progress: you can view everything, but changes can’t be saved. What you entered stays on this screen, so don’t reload; save it again when the maintenance ends.',
  'app.maintenance.stopped': 'Maintenance in progress: the service is temporarily unavailable. This is not an outage. What you entered stays on this screen, so don’t reload; try again when the maintenance ends.',
  'app.maintenance.ended': 'The maintenance has ended. You can save changes again.',
  'language.aria': 'Select display language',
  'sidebar.nav.focus': 'Focus',
  'sidebar.nav.updates': 'Updates',
} as const
// Update Feed navigation is separate from the event Inbox.
