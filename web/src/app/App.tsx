import { RouterProvider } from 'react-router/dom'
import { LiveAnnouncer } from '../shared/ui/LiveAnnouncer'
import { ServiceWorkerUpdateNotice } from './pwa/ServiceWorkerUpdateNotice'
import { createAppRouter } from './router'

const router = createAppRouter()

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
