import { RouterProvider } from 'react-router/dom'
import { ServiceWorkerUpdateNotice } from './pwa/ServiceWorkerUpdateNotice'
import { createAppRouter } from './router'

const router = createAppRouter()

function App() {
  return (
    <>
      <RouterProvider router={router} />
      <ServiceWorkerUpdateNotice />
    </>
  )
}

export default App
