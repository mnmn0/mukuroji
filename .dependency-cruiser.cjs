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
  'file-upload-policy',
  'files',
  'notifications',
  'planning',
  'realtime',
  'request-intake',
  'restore-drill',
  'work-item-workflow',
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
 * Workspace, Web layer, Contracts, and server module dependency rules.
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
      name: 'no-server-to-cdk',
      severity: 'error',
      from: { path: '^server/' },
      to: { path: '^cdk/' },
    },
    {
      name: 'no-web-to-server',
      severity: 'error',
      from: { path: '^web/' },
      to: { path: '^server/' },
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
      name: 'no-cdk-to-server',
      severity: 'error',
      from: { path: '^cdk/' },
      to: { path: '^server/' },
    },
    {
      name: 'contracts-do-not-depend-on-consumers',
      comment: 'Contracts must stay independent from the web, server, and CDK workspaces.',
      severity: 'error',
      from: { path: '^contracts/' },
      to: { path: '^(?:web|server|cdk)/' },
    },
    {
      name: 'contracts-domain-does-not-use-public-barrel',
      comment: 'Contract domain modules must import their concrete sibling modules instead of src/index.ts.',
      severity: 'error',
      from: { path: '^contracts/src/(?!index\\.ts$)' },
      to: { path: '^contracts/src/index\\.ts$' },
    },
    {
      name: 'web-shared-does-not-depend-on-higher-layers',
      comment: 'Shared code may depend only on other shared modules, assets, contracts, or external packages.',
      severity: 'error',
      from: { path: '^web/src/shared/' },
      to: { path: '^web/src/(?!shared/|assets/)' },
    },
    {
      name: 'web-model-is-framework-independent',
      comment: 'Web model modules must stay independent from React, routing, SWR, and higher UI/data layers.',
      severity: 'error',
      from: { path: '^web/src/.*/model/' },
      to: {
        path:
          '^(?:node_modules/(?:react(?:-dom)?|react-router(?:-dom)?|swr)(?:/|$)|node_modules/\\.bun/[^/]+/node_modules/(?:react(?:-dom)?|react-router(?:-dom)?|swr)(?:/|$)|web/src/.*/(?:ui|queries|mutations)/)',
      },
    },
    {
      name: 'web-api-is-transport-only',
      comment: 'Web API modules must not depend on React, routing, SWR, or page composition.',
      severity: 'error',
      from: { path: '^web/src/.*/api(?:/|\\.ts$)' },
      to: {
        path:
          '^(?:node_modules/(?:react(?:-dom)?|react-router(?:-dom)?|swr)(?:/|$)|node_modules/\\.bun/[^/]+/node_modules/(?:react(?:-dom)?|react-router(?:-dom)?|swr)(?:/|$)|web/src/pages/)',
      },
    },
    {
      name: 'web-pages-do-not-depend-on-pages',
      comment: 'Runtime page modules must compose lower layers instead of importing another page; Storybook stories may mount page entry points.',
      severity: 'error',
      from: {
        path: '^web/src/pages/',
        pathNot: '\\.stories\\.[cm]?[jt]sx?$',
      },
      to: { path: '^web/src/pages/' },
    },
    {
      name: 'web-business-domains-do-not-depend-on-pages',
      comment: 'Business domains, including features and entities, must not depend on route-level page composition.',
      severity: 'error',
      from: {
        path: '^web/src/(?!app/|pages/|shared/|assets/)[^/]+/',
      },
      to: { path: '^web/src/pages/' },
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
      name: 'server-documents-http-does-not-depend-on-dynamodb',
      comment: 'Documents HTTP routes must use application ports instead of DynamoDB implementation details.',
      severity: 'error',
      from: { path: '^server/src/modules/documents/adapter-in/http/' },
      to: { path: '^server/src/modules/documents/adapter-out/dynamodb/' },
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
    {
      name: 'server-automation-public-boundary',
      comment: 'Server consumers outside Automation must use modules/automation/index.ts.',
      severity: 'error',
      from: {
        path: '^server/src/',
        pathNot: '^server/src/modules/automation/',
      },
      to: {
        path: '^server/src/modules/automation/(?!index\\.ts$)',
      },
    },
    ...serverModuleBoundaryRules,
  ],
  options: {
    tsPreCompilationDeps: true,
    doNotFollow: {
      path: [
        '^node_modules/',
        '^(?:dist|coverage|storybook-static|cdk\\.out)(?:/|$)',
        '^(?:web|server|contracts|cdk)/(?:dist|coverage|storybook-static|cdk\\.out)(?:/|$)',
      ],
    },
    exclude: [
      '^(?:dist|coverage|storybook-static|cdk\\.out)(?:/|$)',
      '^(?:web|server|contracts|cdk)/(?:dist|coverage|storybook-static|cdk\\.out)(?:/|$)',
    ],
    moduleSystems: ['es6', 'cjs'],
  },
};
