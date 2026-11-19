import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setupLocalEnvironment } from './local-env'

/**
 * One long-running development process started by `bun run dev`.
 */
interface DevProcessDefinition {
  /** Label printed before each output line. */
  readonly label: string
  /** Root `package.json` script that starts the process. */
  readonly script: string
  /** ANSI color code for the label. */
  readonly color: number
}

/**
 * A started development process and how it ended.
 */
interface RunningDevProcess {
  /** The definition the process was started from. */
  readonly definition: DevProcessDefinition
  /** The child process, which leads its own process group. */
  readonly child: ChildProcess
  /** Resolves with the exit code (or 1 for a signal) once the process has exited. */
  readonly exited: Promise<number>
}

const devProcesses: readonly DevProcessDefinition[] = [
  { label: 'server', script: 'server:dev', color: 36 },
  { label: 'workers', script: 'workers:dev', color: 35 },
  { label: 'web', script: 'web:dev', color: 32 },
]

/** Time to let processes finish their current batch after SIGTERM before they are killed. */
const shutdownGraceMilliseconds = 20_000

const repositoryRoot = resolve(import.meta.dir, '..')

/**
 * Formats the colored label that prefixes a process's output lines.
 *
 * @param definition - The process the line came from.
 * @returns The label padded to the longest label.
 */
function formatLabel(definition: DevProcessDefinition): string {
  const width = Math.max(...devProcesses.map((entry) => entry.label.length))
  const label = definition.label.padEnd(width)
  return process.stdout.isTTY ? `\u001b[${definition.color}m[${label}]\u001b[0m` : `[${label}]`
}

/**
 * Sends a signal to a child's whole process group so `bun run` wrappers and their children stop together.
 *
 * @param child - The process group leader.
 * @param signal - The signal to send.
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals | 0): boolean {
  if (child.pid === undefined) return false
  try {
    process.kill(-child.pid, signal)
    return true
  } catch {
    // The whole group has already exited.
    return false
  }
}

/**
 * Waits until no process remains in any of the groups, killing them once the deadline passes.
 *
 * The `bun run` wrapper can exit before its children, such as a worker finishing its current batch,
 * so waiting for the group leaders alone would leave those children running.
 *
 * @param running - The started processes whose groups to wait for.
 * @param deadline - Time in epoch milliseconds after which remaining groups are killed.
 */
async function waitForGroups(running: readonly RunningDevProcess[], deadline: number): Promise<void> {
  while (running.some((entry) => signalGroup(entry.child, 0))) {
    if (Date.now() >= deadline) {
      for (const entry of running) signalGroup(entry.child, 'SIGKILL')
      return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
}

/**
 * Starts one development process in its own process group and prefixes its output.
 *
 * @param definition - The process to start.
 * @returns The running process.
 */
function startDevProcess(definition: DevProcessDefinition): RunningDevProcess {
  const child = spawn(process.execPath, ['run', definition.script], {
    cwd: repositoryRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const label = formatLabel(definition)
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue
    createInterface({ input: stream }).on('line', (line) => {
      process.stdout.write(`${label} ${line}\n`)
    })
  }
  const exited = new Promise<number>((resolveExit) => {
    child.on('error', (error) => {
      process.stderr.write(`${label} failed to start: ${error.message}\n`)
      resolveExit(1)
    })
    child.on('exit', (code) => resolveExit(code ?? 1))
  })
  return { definition, child, exited }
}

/**
 * Starts Floci and waits for its ready hooks, using the same script as `bun run floci:up`.
 *
 * @returns Whether Floci became ready.
 */
function startFloci(): boolean {
  const result = spawnSync('sh', ['floci/up.sh'], { cwd: repositoryRoot, stdio: 'inherit' })
  if (result.error) console.error(`Could not run floci/up.sh: ${result.error.message}`)
  return result.status === 0
}

/**
 * Prepares `.env`, starts Floci, then runs the server, workers and Web until one exits or the user stops them.
 *
 * @returns The exit code: the first process's non-zero code, or 0 after a normal stop.
 */
async function main(): Promise<number> {
  const { generated, secrets } = setupLocalEnvironment(repositoryRoot)
  if (generated.length > 0) console.log(`.env: generated ${generated.join(', ')}.`)
  // Bun loaded `.env` into this process before setup ran, so an empty secret it inherited would
  // override the generated value in Docker Compose and the child processes. Pass the file values instead.
  for (const [name, value] of Object.entries(secrets)) {
    if (!process.env[name]) process.env[name] = value
  }
  if (!startFloci()) return 1

  const running = devProcesses.map(startDevProcess)
  console.log('Started server, workers and Web: http://localhost:5173 . Press Ctrl+C to stop them.')
  console.log('Floci keeps running so the next start is fast; stop it with `bun run dev:down`.')

  let stopping = false
  let exitCode = 0
  let deadline = Number.POSITIVE_INFINITY
  /**
   * Asks every process group to stop; groups that outlive the grace period are killed.
   * A second request, such as pressing Ctrl+C again, kills the remaining groups at once.
   */
  const stopAll = (): void => {
    if (stopping) {
      deadline = 0
      for (const entry of running) signalGroup(entry.child, 'SIGKILL')
      return
    }
    stopping = true
    deadline = Date.now() + shutdownGraceMilliseconds
    for (const entry of running) signalGroup(entry.child, 'SIGTERM')
  }
  process.on('SIGINT', stopAll)
  process.on('SIGTERM', stopAll)

  for (const entry of running) {
    void entry.exited.then((code) => {
      if (stopping) return
      console.error(`${formatLabel(entry.definition)} exited with code ${code}; stopping the others.`)
      exitCode = code === 0 ? 1 : code
      stopAll()
    })
  }

  await Promise.all(running.map((entry) => entry.exited))
  await waitForGroups(running, deadline)
  return exitCode
}

if (import.meta.main) {
  try {
    process.exit(await main())
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
