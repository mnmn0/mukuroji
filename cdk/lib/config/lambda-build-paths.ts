import * as path from 'node:path';

/**
 * Stable source paths used by Node.js Lambda bundling.
 */
export interface LambdaBuildPaths {
  /** Repository root passed to the Node.js bundler. */
  readonly projectRoot: string;
  /** Workspace lockfile used to calculate Lambda asset dependencies. */
  readonly depsLockFilePath: string;
  /** Directory containing the server Lambda handler entrypoints. */
  readonly serverHandlersDirectory: string;
}

/**
 * Resolves Lambda bundling paths from the TypeScript source layout.
 *
 * @returns Stable paths shared by every Node.js Lambda subsystem.
 */
export function buildLambdaBuildPaths(): LambdaBuildPaths {
  return {
    projectRoot: path.join(__dirname, '../../..'),
    depsLockFilePath: path.join(__dirname, '../../../bun.lock'),
    serverHandlersDirectory: path.join(__dirname, '../../../server/src/handlers'),
  };
}

/**
 * Resolves a server Lambda handler without coupling subsystem modules to their directory depth.
 *
 * @param paths - Shared Lambda bundling paths.
 * @param handlerFile - Handler filename relative to `server/src/handlers`.
 * @returns Absolute path accepted by `NodejsFunction`.
 */
export function resolveLambdaHandlerEntry(
  paths: LambdaBuildPaths,
  handlerFile: string,
): string {
  return path.join(paths.serverHandlersDirectory, handlerFile);
}
