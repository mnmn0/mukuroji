import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** Rolldown entry name of the service worker bundle. */
const serviceWorkerEntryName = 'sw'

/**
 * Fails the build when the service worker bundle imports another chunk.
 *
 * A classic service worker cannot use `import`, so any module shared with the app would
 * silently break registration in browsers without module worker support.
 *
 * @returns Vite plugin that validates the emitted `sw.js`.
 */
function selfContainedServiceWorker(): Plugin {
  return {
    name: 'mukuroji-self-contained-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const worker = Object.values(bundle).find(
        (output) => output.type === 'chunk' && output.isEntry && output.name === serviceWorkerEntryName,
      )

      // Builds that reuse this config with their own inputs, such as Storybook, have no worker.
      if (worker === undefined || worker.type !== 'chunk') {
        return
      }

      if (worker.fileName !== 'sw.js') {
        this.error(`The service worker entry must be emitted as sw.js, not ${worker.fileName}.`)
      }

      if (worker.imports.length > 0 || worker.dynamicImports.length > 0) {
        this.error(
          `sw.js must be self-contained but imports ${[...worker.imports, ...worker.dynamicImports].join(', ')}. `
          + 'Do not import modules from src/service-worker in app code.',
        )
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), selfContainedServiceWorker()],
  build: {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        [serviceWorkerEntryName]: fileURLToPath(new URL('./src/service-worker/sw.ts', import.meta.url)),
      },
      output: {
        // The worker must keep a stable root URL so its scope covers the whole app and the
        // browser can detect updates by comparing bytes; app chunks keep content hashes.
        entryFileNames: (chunk) =>
          chunk.name === serviceWorkerEntryName ? 'sw.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
