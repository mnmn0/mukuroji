import { RouterProvider } from 'react-router/dom'
import { LiveAnnouncer } from '../shared/ui/LiveAnnouncer'
import { MaintenanceNotice } from './MaintenanceNotice'
import { ConnectivityNotice } from './pwa/ConnectivityNotice'
import { ServiceWorkerUpdateNotice } from './pwa/ServiceWorkerUpdateNotice'
import { createAppRouter } from './router'

const router = createAppRouter()

/**
 * Mounts the application router together with the app-wide maintenance, update, and offline notices
 * and live regions.
 *
 * @returns The application root.
 */
function App() {
  return (
    <>
      <RouterProvider router={router} />
      <MaintenanceNotice />
      <ServiceWorkerUpdateNotice />
      <ConnectivityNotice />
      <LiveAnnouncer />
    </>
  )
}

export default App
