/**
 * Builds the distributable coding agent MCP: a single-file Node bundle, `mcp.mjs`, and
 * `mcp.mjs.LICENSES.txt` with the license of every third-party package the bundle inlines.
 *
 * Usage: `bun scripts/build-coding-agent-mcp.ts [--outdir <dir>]` (default `server/dist`).
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Repository root, resolved from this script's location. */
const repositoryRoot = resolve(import.meta.dir, '..')

/** Source entry point of the stdio server. */
const entryPoint = join(repositoryRoot, 'server/src/handlers/coding-agent-mcp.ts')

/** One third-party package inlined into the bundle. */
type BundledPackage = {
  /** Package name. */
  name: string
  /** Installed version. */
  version: string
  /** SPDX license expression from the package manifest. */
  license: string
  /** Full text of the package's license file. */
  licenseText: string
}

/**
 * Reads the output directory from the command line.
 *
 * @param args - Command-line arguments after the script path.
 * @returns Absolute output directory.
 */
function readOutdir(args: readonly string[]): string {
  const index = args.indexOf('--outdir')
  if (index === -1) return join(repositoryRoot, 'server/dist')
  const value = args[index + 1]
  if (!value) throw new Error('--outdir needs a directory.')
  return resolve(value)
}

/**
 * Finds the package directory of a bundled input path, the part up to the package name after the
 * last `node_modules/`.
 *
 * @param input - Input path from the build metafile.
 * @returns Package directory, or undefined for first-party sources.
 */
function readPackageDirectory(input: string): string | undefined {
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)
  return match?.[1]
}

/**
 * Reads the manifest and license file of one bundled package. A package without a license file
 * fails the build, so a bundle is never published without its notices.
 *
 * @param directory - Package directory as the metafile names it, relative to the working directory.
 * @returns Package name, version, license, and license text.
 */
async function readBundledPackage(directory: string): Promise<BundledPackage> {
  const absolute = resolve(process.cwd(), directory)
  const manifest: unknown = JSON.parse(await readFile(join(absolute, 'package.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null) throw new Error(`${directory} has no readable package.json.`)
  const name = Reflect.get(manifest, 'name')
  const version = Reflect.get(manifest, 'version')
  const license = Reflect.get(manifest, 'license')
  if (typeof name !== 'string' || typeof version !== 'string' || typeof license !== 'string') {
    throw new Error(`${directory} does not declare its name, version, and license.`)
  }
  const licenseFile = (await readdir(absolute)).find((file) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(file))
  if (!licenseFile) throw new Error(`${name}@${version} has no license file to include.`)
  return { name, version, license, licenseText: (await readFile(join(absolute, licenseFile), 'utf8')).trim() }
}

/**
 * Builds the bundle and its license notices.
 *
 * @param outdir - Output directory.
 * @returns Paths of the written files.
 */
async function buildCodingAgentMcp(outdir: string): Promise<string[]> {
  const result = await Bun.build({ entrypoints: [entryPoint], target: 'node', outdir, naming: 'mcp.mjs', metafile: true })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error('The MCP bundle failed to build.')
  }
  const directories = new Set(
    Object.keys(result.metafile?.inputs ?? {}).flatMap((input) => readPackageDirectory(input) ?? []),
  )
  const packages = (await Promise.all([...directories].map(readBundledPackage)))
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))
  const notices = [
    'Third-party software included in mcp.mjs',
    '',
    ...packages.flatMap((bundled) => [
      '-'.repeat(72),
      `${bundled.name}@${bundled.version} (${bundled.license})`,
      '-'.repeat(72),
      bundled.licenseText,
      '',
    ]),
  ].join('\n')
  const licensesPath = join(outdir, 'mcp.mjs.LICENSES.txt')
  await writeFile(licensesPath, notices)
  return [join(outdir, 'mcp.mjs'), licensesPath]
}

for (const path of await buildCodingAgentMcp(readOutdir(process.argv.slice(2)))) console.log(path)
