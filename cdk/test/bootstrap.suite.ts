/** Registers deterministic bootstrap and custom resource tests. */
import { expect, test } from '@jest/globals';
import {
  createCanonicalWorkItemTransactItems,
  createProjectDirectoryTransactItems,
  createWorkspaceAccessTransactItems,
  createWorkspaceBootstrapTransactItems,
  createWorkspaceDemoMemberTransactItems,
} from '../lib/bootstrap-data';
import {
  serializeAwsSdkCall,
  synthesizedTemplate,
} from './test-support';

test('workspace metadata owner alias and project manager rows are idempotently bootstrapped', () => {
  const template = synthesizedTemplate;
  const [, bootstrap] = Object.entries(template.findResources('Custom::AWS')).find(([, candidate]) =>
    JSON.stringify(candidate).includes('workspace-bootstrap-v2'),
  ) ?? [];

  if (!bootstrap) {
    throw new Error('Workspace bootstrap custom resource was not found.');
  }

  const createPayload = serializeAwsSdkCall(bootstrap.Properties.Create);

  expect(createPayload).toContain('transactWriteItems');
  expect(createPayload).toContain('WORKSPACE#METADATA');
  expect(createPayload).toContain('workspace-metadata');
  expect(createPayload).toContain('WORKSPACE_MEMBER#');
  expect(createPayload).toContain('workspace-member');
  expect(createPayload).toContain('EMAIL_ALIAS#');
  expect(createPayload).toContain('email-alias');
  expect(createPayload).toContain('InitialOwnerEmail');
  expect(createPayload).toContain('InitialOwnerUsername');
  expect(createPayload).toContain('WorkspaceDirectoryId');
  expect(createPayload).toContain('PROJECT_MEMBER#refero#');
  expect(createPayload).toContain('PROJECT_MEMBER#product-roadmap#');
  expect(createPayload).toContain('PROJECT_MEMBER#shared-launch#');
  expect(createPayload).toContain('PROJECT_MEMBER#brand-refresh#');
  expect(createPayload).toContain('WEBHOOK_TEAM_GRANT#');
  expect(createPayload).toContain('WEBHOOK_ACL#TEAM_MEMBER#');
  expect(createPayload.match(/":role":\{"S":"manager"\}/g)).toHaveLength(4);
  expect(createPayload.match(/":timestamp":\{"S":"2026-07-11T00:00:00.000Z"\}/g)).toHaveLength(5);
  expect(createPayload.match(/"Update"/g)).toHaveLength(7);
  expect(createPayload.match(/"Put"/g)).toHaveLength(10);
  expect(createPayload.match(/"entryType":\{"S":"webhook-team-grant"\}/g))
    .toHaveLength(5);
  expect(createPayload.match(
    /"entryType":\{"S":"webhook-team-grant-cleanup"\}/g,
  )).toHaveLength(5);
  expect(createPayload.match(/"teamSourceEntryKey"/g)).toHaveLength(5);
  expect(createPayload.match(/"projectSourceEntryKey"/g)).toHaveLength(5);
  expect(createPayload).toContain(
    '"teamSourceEntryKey":{"S":"000010#000000#TEAM#core-team"}',
  );
  expect(createPayload).toContain(
    '"projectSourceEntryKey":{"S":"000010#000030#PROJECT#shared-launch"}',
  );
  expect(createPayload).toContain(
    '"teamSourceEntryKey":{"S":"000020#000000#TEAM#design-team"}',
  );
  expect(createPayload).toContain(
    '"projectSourceEntryKey":{"S":"000020#000010#PROJECT#shared-launch"}',
  );
  expect(createPayload).toContain('createdAt = if_not_exists(createdAt, :timestamp)');
  expect(createPayload).toContain('updatedAt = if_not_exists(updatedAt, :timestamp)');
  expect(createPayload.match(/#role = :role/g)).toHaveLength(1);
  expect(createPayload.match(/#role = if_not_exists\(#role, :role\)/g)).toHaveLength(4);
  expect(createPayload).toContain('attribute_not_exists(directoryId) OR');
  expect(bootstrap.Properties.Update).toBeUndefined();
});

test('fenced table bootstrap resources keep stable IDs and a create-only pre-fence boundary', () => {
  const resources = synthesizedTemplate.findResources('Custom::AWS');
  const createOnlySeeds = [
    [
      'SeedProjectTasks637E8868',
      'canonical-work-items-seed-v1',
      'TeamIssuesTable189D851D',
    ],
    [
      'SeedProjectDirectory9B1D2A78',
      'project-directory-seed-v3',
      'ProjectDirectoryTable9ED01C01',
    ],
    [
      'BootstrapWorkspace455B1D71',
      'workspace-bootstrap-v2',
      'ProjectDirectoryTable9ED01C01',
    ],
  ];

  for (const [logicalId, physicalResourceId, tableLogicalId] of
    createOnlySeeds) {
    const resource = resources[logicalId];
    expect(resource).toBeDefined();
    const lifecycleActions = ['Create', 'Update', 'Delete'].filter(
      (action) => resource?.Properties?.[action] !== undefined,
    );
    expect(lifecycleActions).toEqual(['Create']);
    const createPayload = serializeAwsSdkCall(resource?.Properties.Create);
    expect(createPayload).toContain('transactWriteItems');
    expect(createPayload).toContain(physicalResourceId);
    expect(createPayload).toContain(`{{Ref:${tableLogicalId}}}`);
  }
});

test('bootstrap transactions synthesize enclosed DynamoDB write permissions at intended lifecycle boundaries', () => {
  const template = synthesizedTemplate;
  const customResources = template.findResources('Custom::AWS');
  const policies = template.findResources('AWS::IAM::Policy');
  const tables = template.findResources('AWS::DynamoDB::Table');
  const outputs = template.toJSON().Outputs;
  const transactionCases = [
    {
      customResourcePrefix: 'SeedProjectTasks',
      policyPrefix: 'SeedProjectTasksCustomResourcePolicy',
      itemActions: ['dynamodb:PutItem'],
      tableOutputName: 'WorkItemsTableName',
      physicalResourceId: 'canonical-work-items-seed-v1',
      runsOnUpdate: false,
    },
    {
      customResourcePrefix: 'SeedProjectDirectory',
      policyPrefix: 'SeedProjectDirectoryCustomResourcePolicy',
      itemActions: ['dynamodb:PutItem'],
      tableOutputName: 'ProjectDirectoryTableName',
      physicalResourceId: 'project-directory-seed-v3',
      runsOnUpdate: false,
    },
    {
      customResourcePrefix: 'SeedWorkspaceAccess',
      policyPrefix: 'SeedWorkspaceAccessCustomResourcePolicy',
      itemActions: ['dynamodb:UpdateItem'],
      tableOutputName: 'WorkspaceAccessTableName',
      physicalResourceId: 'workspace-access-seed-v2',
      runsOnUpdate: true,
    },
    {
      customResourcePrefix: 'BootstrapWorkspace',
      policyPrefix: 'BootstrapWorkspaceCustomResourcePolicy',
      itemActions: ['dynamodb:UpdateItem', 'dynamodb:PutItem'],
      tableOutputName: 'ProjectDirectoryTableName',
      physicalResourceId: 'workspace-bootstrap-v2',
      runsOnUpdate: false,
    },
    {
      customResourcePrefix: 'SeedWorkspaceDemoMembers',
      policyPrefix: 'SeedWorkspaceDemoMembersCustomResourcePolicy',
      itemActions: ['dynamodb:UpdateItem'],
      tableOutputName: 'WorkspaceAccessTableName',
      physicalResourceId: 'workspace-access-demo-members-seed-v2',
      runsOnUpdate: true,
    },
  ] as const;

  for (const transactionCase of transactionCases) {
    const customResource = Object.entries(customResources).find(([logicalId]) =>
      logicalId.startsWith(transactionCase.customResourcePrefix),
    )?.[1];
    const policy = Object.entries(policies).find(([logicalId]) =>
      logicalId.startsWith(transactionCase.policyPrefix),
    )?.[1] as {
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<Record<string, unknown>>;
        };
      };
    } | undefined;

    expect(customResource).toBeDefined();
    expect(customResource?.Properties.Create).toBeDefined();
    const createPayload = serializeAwsSdkCall(customResource?.Properties.Create);
    const tableLogicalId = outputs[transactionCase.tableOutputName]?.Value?.Ref;

    expect(createPayload).toContain(transactionCase.physicalResourceId);
    if (typeof tableLogicalId !== 'string') {
      throw new Error(
        `DynamoDB table output ${transactionCase.tableOutputName} was not found.`,
      );
    }
    expect(tables[tableLogicalId]).toBeDefined();
    expect(createPayload).toContain(`{{Ref:${tableLogicalId}}}`);
    if (transactionCase.runsOnUpdate) {
      expect(customResource?.Properties.Update).toEqual(customResource?.Properties.Create);
    } else {
      expect(customResource?.Properties.Update).toBeUndefined();
    }

    const statements = policy?.Properties?.PolicyDocument?.Statement ?? [];
    const tableArn = { 'Fn::GetAtt': [tableLogicalId, 'Arn'] };
    const itemActionStatements = statements.filter((statement) =>
      (Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action]
      ).some((action) =>
        transactionCase.itemActions.some((expected) => expected === action)
      ),
    );

    expect(itemActionStatements.flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action]
    )).toEqual(expect.arrayContaining([...transactionCase.itemActions]));
    expect(JSON.stringify(statements)).not.toContain('dynamodb:TransactWriteItems');
    for (const statement of itemActionStatements) {
      expect(statement).toEqual(expect.objectContaining({
        Condition: {
          'ForAnyValue:StringEquals': {
            'dynamodb:EnclosingOperation': ['TransactWriteItems'],
          },
        },
        Effect: 'Allow',
        Resource: tableArn,
      }));
    }
  }
});

test('canonical Work Item seed writes complete schema data and preserves demo data', () => {
  const template = synthesizedTemplate;
  const customResources = template.findResources('Custom::AWS');
  const transactWriteResources = Object.values(customResources).filter((resource) =>
    JSON.stringify(resource).includes('transactWriteItems'),
  );
  const canonicalWorkItemSeedEntry = Object.entries(customResources).find(([logicalId]) =>
    logicalId === 'SeedProjectTasks637E8868'
  );
  const canonicalWorkItemSeed = canonicalWorkItemSeedEntry?.[1];
  const canonicalWorkItemSeedPolicyEntry = Object.entries(
    template.findResources('AWS::IAM::Policy'),
  ).find(([logicalId]) => logicalId === 'SeedProjectTasksCustomResourcePolicy924038FB');
  const projectDirectorySeed = transactWriteResources.find((resource) =>
    JSON.stringify(resource).includes('project-directory-seed-v3'),
  );

  expect(canonicalWorkItemSeedEntry?.[0]).toBe('SeedProjectTasks637E8868');
  expect(canonicalWorkItemSeed).toBeDefined();
  expect(canonicalWorkItemSeedPolicyEntry).toBeDefined();
  expect(projectDirectorySeed).toBeDefined();
  expect(JSON.stringify(canonicalWorkItemSeed)).not.toContain('ProjectTasksTableE21F6637');
  expect(JSON.stringify(canonicalWorkItemSeedPolicyEntry)).not.toContain('ProjectTasksTableE21F6637');
  expect(JSON.stringify(transactWriteResources)).not.toContain('ProjectTasksTableE21F6637');
  expect(Object.keys(customResources).join(',')).not.toContain('SeedCanonicalWorkItems');

  const workItemPayload = serializeAwsSdkCall(canonicalWorkItemSeed?.Properties.Create);
  const directoryPayload = serializeAwsSdkCall(projectDirectorySeed?.Properties.Create);

  expect(workItemPayload).toContain('WorkspaceDirectoryId');
  expect(workItemPayload).toContain('TeamIssuesTable189D851D');
  expect(workItemPayload).toContain('attribute_not_exists(directoryTeamId)');
  expect(workItemPayload).toContain('attribute_not_exists(issueId)');
  expect(workItemPayload).toContain('core-team');
  expect(workItemPayload).toContain('assignedProjectId');
  expect(workItemPayload).toContain('2026-06-01T00:00:00.000Z');
  expect(workItemPayload.match(/schemaVersion/g)).toHaveLength(10);
  expect(workItemPayload.match(/workflowSchemaVersion/g)).toHaveLength(10);
  expect(workItemPayload.match(/workflowStatusId/g)).toHaveLength(10);
  expect(workItemPayload.match(/statusCategory/g)).toHaveLength(10);
  expect(workItemPayload.match(/customFieldValues/g)).toHaveLength(10);
  expect(workItemPayload.match(/relationIds/g)).toHaveLength(10);
  expect(workItemPayload.match(/schedule/g)).toHaveLength(10);
  expect(workItemPayload.match(/creatorMemberKey/g)).toHaveLength(10);
  expect(workItemPayload).toContain('"schemaVersion":{"N":"2"}');
  expect(workItemPayload).toContain('"mode":{"S":"due-date"}');
  expect(workItemPayload).toContain('"timeZone":{"S":"UTC"}');
  expect(workItemPayload).toContain('"dueDate":{"S":"2026-06-03"}');
  expect(workItemPayload).toContain('"statusCategory":{"S":"unstarted"}');
  expect(workItemPayload).toContain('"statusCategory":{"S":"started"}');
  expect(workItemPayload).toContain('"statusCategory":{"S":"completed"}');
  expect(workItemPayload).not.toMatch(/"status":\{"S":/);
  expect(workItemPayload).not.toContain('"titleKey"');
  expect(workItemPayload.match(/revision/g)).toHaveLength(10);
  expect(workItemPayload).not.toContain('"workItemId"');
  expect(workItemPayload).not.toContain('migrationSourceKey');
  expect(workItemPayload).not.toMatch(/"source":\{"S":/);
  expect(workItemPayload).not.toMatch(/"migrationSource":\{"S":/);
  const canonicalWorkItemSeedPolicy = canonicalWorkItemSeedPolicyEntry?.[1] as {
    Properties?: {
      PolicyDocument?: {
        Statement?: unknown[];
      };
    };
  } | undefined;
  expect(canonicalWorkItemSeedPolicy?.Properties?.PolicyDocument?.Statement).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Action: 'dynamodb:PutItem',
        Condition: {
          'ForAnyValue:StringEquals': {
            'dynamodb:EnclosingOperation': ['TransactWriteItems'],
          },
        },
        Effect: 'Allow',
        Resource: { 'Fn::GetAtt': ['TeamIssuesTable189D851D', 'Arn'] },
      }),
    ]),
  );
  expect(JSON.stringify(canonicalWorkItemSeedPolicy))
    .not.toContain('dynamodb:TransactWriteItems');
  expect(directoryPayload).toContain('WorkspaceDirectoryId');
  expect(directoryPayload.match(/"teamSourceEntryKey"/g)).toHaveLength(2);
  expect(directoryPayload.match(/"projectSourceEntryKey"/g)).toHaveLength(2);
  expect(directoryPayload).toContain(
    '"teamSourceEntryKey":{"S":"000010#000000#TEAM#core-team"}',
  );
  expect(directoryPayload).toContain(
    '"projectSourceEntryKey":{"S":"000010#000010#PROJECT#refero"}',
  );
  expect(workItemPayload).not.toContain('user#demo@example.com');
  expect(directoryPayload).not.toContain('user#demo@example.com');
  expect(canonicalWorkItemSeed?.Properties.Update).toBeUndefined();
  expect(projectDirectorySeed?.Properties.Update).toBeUndefined();
});

test('bootstrap payload builders preserve deterministic keys, conditions, and idempotency', () => {
  const workspaceAccess = createWorkspaceAccessTransactItems(
    'WorkspaceAccessTable',
    'workspace-1',
    'owner@example.com',
  );
  const workspaceMembers = createWorkspaceDemoMemberTransactItems(
    'WorkspaceAccessTable',
    'workspace-1',
  );
  const canonicalWorkItems = createCanonicalWorkItemTransactItems('WorkItemsTable', 'directory-1');
  const directoryItems = createProjectDirectoryTransactItems('DirectoryTable', 'directory-1');
  const workspaceBootstrap = createWorkspaceBootstrapTransactItems(
    'DirectoryTable',
    'directory-1',
    'owner@example.com',
    'owner',
  );

  expect(workspaceAccess).toHaveLength(2);
  expect(workspaceAccess[0].Update.Key).toEqual({
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: 'WORKSPACE' },
  });
  expect(workspaceAccess[1].Update.Key).toEqual({
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: 'MEMBER#owner@example.com' },
  });
  expect(workspaceAccess.every(({ Update }) =>
    Update.ConditionExpression?.includes('attribute_not_exists(workspaceId)') &&
    Update.UpdateExpression.includes('if_not_exists') &&
    Update.ExpressionAttributeValues?.[':createdAt']?.S === '2026-07-11T00:00:00.000Z' &&
    Update.ExpressionAttributeValues?.[':updatedAt']?.S === '2026-07-11T00:00:00.000Z',
  )).toBe(true);
  expect(workspaceAccess).toEqual(createWorkspaceAccessTransactItems(
    'WorkspaceAccessTable',
    'workspace-1',
    'owner@example.com',
  ));

  expect(workspaceMembers).toHaveLength(5);
  expect(workspaceMembers.map(({ Update }) => Update.Key.recordKey)).toEqual([
    { S: 'MEMBER#sato@example.com' },
    { S: 'MEMBER#suzuki@example.com' },
    { S: 'MEMBER#tanaka@example.com' },
    { S: 'MEMBER#yamamoto@example.com' },
    { S: 'MEMBER#viewer@example.com' },
  ]);
  expect(workspaceMembers.every(({ Update }) =>
    Update.ConditionExpression?.includes('memberKey = :memberKey') &&
    Update.UpdateExpression.includes('if_not_exists') &&
    Update.ExpressionAttributeValues?.[':createdAt']?.S === '2026-07-11T00:00:00.000Z' &&
    Update.ExpressionAttributeValues?.[':updatedAt']?.S === '2026-07-11T00:00:00.000Z',
  )).toBe(true);
  expect(workspaceMembers).toEqual(createWorkspaceDemoMemberTransactItems(
    'WorkspaceAccessTable',
    'workspace-1',
  ));

  expect(canonicalWorkItems).toHaveLength(10);
  expect(canonicalWorkItems.every(({ Put }) =>
    Put.ConditionExpression === 'attribute_not_exists(directoryTeamId) AND attribute_not_exists(issueId)' &&
    Put.Item.directoryId.S === 'directory-1' &&
    Put.Item.createdAt.S === '2026-06-01T00:00:00.000Z' &&
    Put.Item.updatedAt.S === '2026-06-01T00:00:00.000Z',
  )).toBe(true);
  expect(canonicalWorkItems).toEqual(createCanonicalWorkItemTransactItems('WorkItemsTable', 'directory-1'));

  expect(directoryItems).toHaveLength(13);
  expect(directoryItems.filter(({ Put }) => 'ConditionExpression' in Put)).toHaveLength(9);
  expect(directoryItems.every(({ Put }) =>
    !('ConditionExpression' in Put) ||
    (
      Put.ConditionExpression === 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)' &&
      Put.Item.directoryId.S === 'directory-1'
    ),
  )).toBe(true);
  expect(directoryItems.filter(({ Put }) => !('ConditionExpression' in Put))).toHaveLength(4);
  expect(directoryItems.every(({ Put }) =>
    'ConditionExpression' in Put ||
    ['webhook-team-grant', 'webhook-team-grant-cleanup'].includes(Put.Item.entryType.S),
  )).toBe(true);
  expect(directoryItems.filter(({ Put }) => Put.Item.entryType.S === 'project-member').every(({ Put }) => {
    const item = Put.Item as Record<string, { S?: string }>;

    return item.createdAt?.S === '2026-06-08T00:00:00.000Z' &&
      item.updatedAt?.S === '2026-06-08T00:00:00.000Z';
  })).toBe(true);
  expect(directoryItems).toEqual(createProjectDirectoryTransactItems('DirectoryTable', 'directory-1'));

  expect(workspaceBootstrap).toHaveLength(17);
  expect(workspaceBootstrap.filter((item) => 'Update' in item)).toHaveLength(7);
  expect(workspaceBootstrap.filter((item) => 'Put' in item)).toHaveLength(10);
  expect(workspaceBootstrap.every((item) => {
    if (!('Update' in item)) {
      return true;
    }

    return item.Update.ConditionExpression?.includes('attribute_not_exists(directoryId)') &&
      !('Item' in item.Update);
  })).toBe(true);
  expect(workspaceBootstrap.every((item) => {
    if (!('Update' in item)) {
      return true;
    }
    const values = item.Update.ExpressionAttributeValues as Record<string, { S?: string }>;

    return values[':timestamp'] === undefined ||
      (
        item.Update.UpdateExpression.includes('if_not_exists') &&
        values[':timestamp']?.S === '2026-07-11T00:00:00.000Z'
      );
  })).toBe(true);
  expect(workspaceBootstrap.every((item) => {
    if (!('Put' in item)) {
      return true;
    }

    return ['webhook-team-grant', 'webhook-team-grant-cleanup'].includes(
      item.Put.Item.entryType.S,
    );
  })).toBe(true);
  expect(workspaceBootstrap).toEqual(createWorkspaceBootstrapTransactItems(
    'DirectoryTable',
    'directory-1',
    'owner@example.com',
    'owner',
  ));
});
