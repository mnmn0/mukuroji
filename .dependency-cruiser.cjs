/**
 * Workspace dependency rules.
 *
 * The source tree is currently transitioning toward explicit module layers,
 * so this config starts with rules that are safe for the existing layout.
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
