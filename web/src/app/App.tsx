import { RouterProvider } from 'react-router/dom'
import { LiveAnnouncer } from '../shared/ui/LiveAnnouncer'
import { ServiceWorkerUpdateNotice } from './pwa/ServiceWorkerUpdateNotice'
import { createAppRouter } from './router'

const router = createAppRouter()

/**
 * Mounts the application router together with the app-wide update notice and live regions.
 *
 * @returns The application root.
 */
function App() {
  return (
    <>
      <RouterProvider router={router} />
      <ServiceWorkerUpdateNotice />
      <LiveAnnouncer />
    </>
  )
}

export default App
