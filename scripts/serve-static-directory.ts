import { existsSync, statSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'

/**
 * Resolves a request path to a file inside the served directory.
 *
 * @param root - Absolute directory being served.
 * @param pathname - Decoded URL path.
 * @returns The file path, or undefined when the path escapes the root or does not exist.
 */
export function resolveStaticFile(root: string, pathname: string): string | undefined {
  const relativePath = normalize(pathname === '/' ? '/index.html' : pathname)
  const candidate = resolve(join(root, relativePath))
  if (candidate !== root && !candidate.startsWith(`${root}/`)) return undefined
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return undefined
  return candidate
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? 'web/storybook-static')
  const port = Number(process.argv[3] ?? '6007')
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Port must be an integer between 1 and 65535.')
  }
  Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname)
      const file = resolveStaticFile(root, pathname)
      return file ? new Response(Bun.file(file)) : new Response('Not found', { status: 404 })
    },
  })
  console.log(`Serving ${root} on http://127.0.0.1:${port}`)
}
