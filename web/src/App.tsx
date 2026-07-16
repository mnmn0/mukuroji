import { RouterProvider } from 'react-router/dom'
import { createAppRouter } from './routes/router'

const router = createAppRouter()

function App() {
  return <RouterProvider router={router} />
}

export default App
