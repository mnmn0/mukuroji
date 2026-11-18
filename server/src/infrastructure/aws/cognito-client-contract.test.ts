import { expect, test } from 'bun:test'
import {
  DescribeUserPoolClientCommand,
  type DescribeUserPoolClientCommandOutput,
  DescribeUserPoolCommand,
  type DescribeUserPoolCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider'
import {
  checkCognitoClientContract,
  type CognitoClientContractClient,
  type CognitoClientContractEvent,
  findCognitoPasswordClientContractViolations,
} from './cognito-client-contract'

/**
 * Creates a fake Cognito client that answers DescribeUserPool and DescribeUserPoolClient.
 *
 * @param input - Settings returned by the fake.
 * @returns Fake client and the commands it received.
 */
function createClient(input: {
  readonly writeAttributes?: string[]
  readonly allowAdminCreateUserOnly?: boolean
}): { readonly client: CognitoClientContractClient, readonly commands: unknown[] } {
  const commands: unknown[] = []
  const send = async (command: unknown) => {
    commands.push(command)
    if (command instanceof DescribeUserPoolCommand) {
      return {
        $metadata: {},
        UserPool: { AdminCreateUserConfig: { AllowAdminCreateUserOnly: input.allowAdminCreateUserOnly } },
      } satisfies DescribeUserPoolCommandOutput
    }
    if (command instanceof DescribeUserPoolClientCommand) {
      return {
        $metadata: {},
        UserPoolClient: { WriteAttributes: input.writeAttributes },
      } satisfies DescribeUserPoolClientCommandOutput
    }
    throw new Error('unexpected command')
  }
  return { client: { send } as CognitoClientContractClient, commands }
}

const createEvent: CognitoClientContractEvent = {
  RequestType: 'Create',
  ResourceProperties: { UserPoolId: 'ap-northeast-1_Example1', ClientId: 'client123' },
}

test('accepts a client that writes only name in an admin-only pool', () => {
  expect(findCognitoPasswordClientContractViolations({
    writeAttributes: ['name'],
    allowAdminCreateUserOnly: true,
  })).toEqual([])
})

test('rejects the Cognito default write attributes', () => {
  expect(findCognitoPasswordClientContractViolations({ allowAdminCreateUserOnly: true })).toEqual([
    'Cognito password app client must set WriteAttributes explicitly; the Cognito default lets users write email.',
  ])
  expect(findCognitoPasswordClientContractViolations({
    writeAttributes: [],
    allowAdminCreateUserOnly: true,
  })).toHaveLength(1)
})

test('rejects every authorization attribute a user could write', () => {
  expect(findCognitoPasswordClientContractViolations({
    writeAttributes: ['name', 'email', 'custom:directory_id', 'custom:workspace_id'],
    allowAdminCreateUserOnly: true,
  })).toEqual([
    'Cognito password app client WriteAttributes must not include email.',
    'Cognito password app client WriteAttributes must not include custom:directory_id.',
    'Cognito password app client WriteAttributes must not include custom:workspace_id.',
  ])
})

test('rejects a pool that allows self sign-up', () => {
  for (const allowAdminCreateUserOnly of [false, undefined]) {
    expect(findCognitoPasswordClientContractViolations({
      writeAttributes: ['name'],
      allowAdminCreateUserOnly,
    })).toEqual([
      'Cognito user pool must set AdminCreateUserConfig.AllowAdminCreateUserOnly to true.',
    ])
  }
})

test('passes the deploy when the pool and client hold the contract', async () => {
  const { client, commands } = createClient({ writeAttributes: ['name'], allowAdminCreateUserOnly: true })

  await expect(checkCognitoClientContract(createEvent, client)).resolves.toEqual({
    PhysicalResourceId: 'mukuroji-cognito-client-contract-v1',
  })
  expect(commands).toHaveLength(2)
  const clientCommand = commands.find((command) => command instanceof DescribeUserPoolClientCommand)
  expect((clientCommand as DescribeUserPoolClientCommand).input).toEqual({
    UserPoolId: 'ap-northeast-1_Example1',
    ClientId: 'client123',
  })
})

test('fails the deploy when the client lets users write email', async () => {
  const { client } = createClient({ writeAttributes: ['name', 'email'], allowAdminCreateUserOnly: true })

  await expect(checkCognitoClientContract({ ...createEvent, RequestType: 'Update', PhysicalResourceId: 'existing' }, client))
    .rejects.toThrow('WriteAttributes must not include email.')
})

test('fails the deploy when the client relies on the default write attributes', async () => {
  const { client } = createClient({ allowAdminCreateUserOnly: true })

  await expect(checkCognitoClientContract(createEvent, client))
    .rejects.toThrow('must set WriteAttributes explicitly')
})

test('rejects malformed identifiers before calling Cognito', async () => {
  const { client, commands } = createClient({ writeAttributes: ['name'], allowAdminCreateUserOnly: true })

  await expect(checkCognitoClientContract({
    RequestType: 'Create',
    ResourceProperties: { UserPoolId: '', ClientId: 'client123' },
  }, client)).rejects.toThrow('Cognito user pool ID is invalid.')
  expect(commands).toHaveLength(0)
})

test('skips the check on delete', async () => {
  const { client, commands } = createClient({ allowAdminCreateUserOnly: false })

  await expect(checkCognitoClientContract({ RequestType: 'Delete', PhysicalResourceId: 'existing' }, client))
    .resolves.toEqual({ PhysicalResourceId: 'existing' })
  expect(commands).toHaveLength(0)
})
