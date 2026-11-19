/**
 * Build-time environment values, such as `import.meta.env`. The build identity is read from
 * `VITE_WEB_BUILD_COMMIT_SHA`, which `scripts/deploy-web.sh` passes to `vite build`.
 */
export type WebBuildEnvironment = Readonly<Record<string, unknown>>

/**
 * Identity of the Web build that the browser is running.
 */
export type WebBuildInfo = {
  /** Full lowercase 40-character commit SHA, or undefined for local and test builds. */
  readonly commitSha: string | undefined
}

const commitShaPattern = /^[0-9a-f]{40}$/

/**
 * Reads the commit SHA embedded at build time.
 *
 * Values that are not one full lowercase Git SHA are ignored so a stray variable cannot
 * put arbitrary text on the Help screen.
 *
 * @param environment - Environment values to read. Defaults to `import.meta.env`.
 * @returns The build identity, with an undefined SHA for builds made without one.
 */
export function readWebBuildInfo(
  environment: WebBuildEnvironment = import.meta.env,
): WebBuildInfo {
  const value = environment.VITE_WEB_BUILD_COMMIT_SHA
  if (typeof value !== 'string' || !commitShaPattern.test(value)) {
    return { commitSha: undefined }
  }
  return { commitSha: value }
}
