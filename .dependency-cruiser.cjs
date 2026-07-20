const serverModules = [
  'analytics',
  'audit',
  'authentication',
  'automation',
  'collaboration',
  'developer-platform',
  'directory',
  'documents',
  'enterprise-identity',
  'files',
  'notifications',
  'planning',
  'realtime',
  'request-intake',
  'work-items',
  'workspace-access',
  'workspace-search',
];

const serverModuleBoundaryRules = serverModules.map((moduleName) => ({
  name: `server-${moduleName}-internal-boundary`,
  comment: `Other modules must use modules/${moduleName}/index.ts.`,
  severity: 'error',
  from: {
    path: '^server/src/modules/',
    pathNot: `(?:^server/src/modules/${moduleName}/|\\.test\\.ts$)`,
  },
  to: {
    path: `^server/src/modules/${moduleName}/(?!index\\.ts$)`,
  },
}));

/**
 * Workspace and server package-boundary dependency rules.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-server-to-web',
      severity: 'error',
      from: { path: '^server/' },
      to: { path: '^web/' },
    },
    {
      name: 'no-web-to-cdk',
      severity: 'error',
      from: { path: '^web/' },
      to: { path: '^cdk/' },
    },
    {
      name: 'no-cdk-to-web',
      severity: 'error',
      from: { path: '^cdk/' },
      to: { path: '^web/' },
    },
    {
      name: 'no-server-module-to-app',
      severity: 'error',
      from: {
        path: '^server/src/modules/',
        pathNot: '\\.test\\.ts$',
      },
      to: { path: '^server/src/(?:app/|index\\.ts$)' },
    },
    {
      name: 'server-domain-is-pure',
      severity: 'error',
      from: { path: '^server/src/modules/[^/]+/domain/' },
      to: {
        path:
          '^(?:node:|node_modules/|server/src/(?:app/|handlers/|infrastructure/)|server/src/modules/[^/]+/(?:application|adapter-in|adapter-out)/)',
      },
    },
    {
      name: 'server-application-does-not-depend-on-adapters',
      severity: 'error',
      from: { path: '^server/src/modules/[^/]+/application/' },
      to: {
        path:
          '^(?:node_modules/(?:hono|@aws-sdk)|server/src/(?:app/|handlers/)|server/src/modules/[^/]+/adapter-(?:in|out)/)',
      },
    },
    {
      name: 'server-adapter-in-does-not-depend-on-app',
      severity: 'error',
      from: { path: '^server/src/modules/[^/]+/adapter-in/' },
      to: { path: '^server/src/(?:app/|index\\.ts$)' },
    },
    {
      name: 'server-adapter-out-does-not-depend-on-http',
      severity: 'error',
      from: { path: '^server/src/modules/[^/]+/adapter-out/' },
      to: { path: '^(?:node_modules/hono|server/src/(?:app/|handlers/))' },
    },
    {
      name: 'server-handlers-do-not-use-compatibility-index',
      severity: 'error',
      from: { path: '^server/src/handlers/' },
      to: { path: '^server/src/index\\.ts$' },
    },
    {
      name: 'server-backfills-do-not-use-http',
      severity: 'error',
      from: { path: '^server/scripts/backfills/' },
      to: {
        path:
          '^server/src/(?:app/|handlers/)|^server/src/modules/[^/]+/adapter-in/',
      },
    },
    ...serverModuleBoundaryRules,
  ],
  options: {
    tsPreCompilationDeps: true,
    doNotFollow: {
      path: ['node_modules', 'dist', 'cdk.out', 'coverage', 'storybook-static'],
    },
    exclude: ['node_modules', 'dist', 'cdk.out', 'coverage', 'storybook-static'],
    moduleSystems: ['es6', 'cjs'],
  },
};
