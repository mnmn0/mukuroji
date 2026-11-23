import { RouterProvider } from 'react-router/dom'
import { LiveAnnouncer } from '../shared/ui/LiveAnnouncer'
import { MaintenanceNotice } from './maintenance/MaintenanceNotice'
import { BuildDriftNotice } from './release/BuildDriftNotice'
import { ConnectivityNotice } from './pwa/ConnectivityNotice'
import { ServiceWorkerUpdateNotice } from './pwa/ServiceWorkerUpdateNotice'
import { installClientErrorReporting } from './observability/clientErrorReporting'
import { createAppRouter } from './router'

const router = createAppRouter()
installClientErrorReporting(router)

/**
 * Mounts the application router together with the app-wide maintenance, update, build drift, and
 * offline notices and live regions.
 *
 * @returns The application root.
 */
function App() {
  return (
    <>
      <RouterProvider router={router} />
      <MaintenanceNotice />
      <ServiceWorkerUpdateNotice />
      <BuildDriftNotice />
      <ConnectivityNotice />
      <LiveAnnouncer />
    </>
  )
}

export default App
