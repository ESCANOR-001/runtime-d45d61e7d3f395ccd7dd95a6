import { expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AndroidRemoteGatewayController } from '../src/android-remote/gateway';

test('upgrade preserves observed Desktop questions while refusing unretained or locally owned work', () => {
  const connection = { clients: [], settings: { controlEnabled: true } };
  const retained = new Set(['original-desktop-id']);
  const claude = { assertUpgradeSettled() {} };
  const question = { nativeThreadId: 'original-desktop-id', remoteThreadId: 'phone-alias', callId: 'original-call' };
  const maps = ['pendingRequests', 'pendingDesktopUserInputs', 'knownActiveTurnIds', 'queuedTurns',
    'queuedTurnStarts', 'queuedTurnStartFlights', 'queuedSteerFlights', 'pendingSteerDeliveries',
    'inFlightDispatches', 'threadMutationFlights'];
  const owner: any = Object.assign(Object.create(AndroidRemoteGatewayController.prototype),
    Object.fromEntries(maps.map(name => [name, new Map()])), {
      claudeCode: () => { throw Error('Acquiring an owner after the source hold is forbidden'); },
      store: { read: () => structuredClone(connection) },
      nativeThreadId: (id: string) => id === 'phone-alias' ? 'original-desktop-id' : id,
    });
  owner.pendingDesktopUserInputs.set('question', question);
  owner.knownActiveTurnIds.set('phone-alias', 'original-turn');
  const check = (saved = connection, references = retained) => owner.assertNativeUpgradeSettled(saved, references, claude);
  expect(() => check()).not.toThrow();
  expect(owner.pendingDesktopUserInputs.get('question')).toBe(question);
  expect(owner.knownActiveTurnIds.get('phone-alias')).toBe('original-turn');
  expect(() => check(connection, new Set())).toThrow();
  owner.pendingDesktopUserInputs.set('unretained', { ...question, nativeThreadId: 'missing-history' });
  expect(() => check()).toThrow();
  owner.pendingDesktopUserInputs.delete('unretained');
  for (const name of maps.filter(name => !['pendingDesktopUserInputs', 'knownActiveTurnIds'].includes(name))) {
    owner[name].set('owned', { nativeThreadId: 'original-desktop-id' });
    expect(() => check()).toThrow();
    owner[name].delete('owned');
  }
  expect(() => check({ ...connection, settings: { controlEnabled: false } })).toThrow();
  claude.assertUpgradeSettled = () => { throw Error('Claude is still working'); };
  expect(() => check()).toThrow('Claude is still working');
});

test('native upgrade preserves the saved Claude sharing preference without probing or opening sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-runtime-'));
  const previous = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = root;
  process.env.CLAUDE_CONFIG_DIR = root;
  let desktopSync = true;
  // Exercise the real configuration producer, with no native processes or listeners.
  const owner = Object.assign(Object.create(AndroidRemoteGatewayController.prototype), {
    gatewayStatus: 'ready', server: { hostname: '127.0.0.1' }, boundPort: 1234,
    listeningOnLocalNetwork: true,
    store: { read: () => ({ settings: { connectionChoice: 'local', localNetworkEnabled: true, tunnelMode: 'quick' } }) },
    cloudflareTunnel: { state: () => ({ status: 'stopped' }) },
    runtime: { upgradeExecutable: async () => process.execPath },
    claudeCode: () => ({ upgradeExecutable: () => process.execPath,
      syncSettings: () => ({ desktopSync }),
      upgradeExportRecords: () => { throw new Error('Export admission has not been reserved'); } }),
    requireCodex: () => ({ request: async () => ({ data: [{ isDefault: true, model: 'fixture-model' }] }) }),
    pairingUrls: () => ['http://127.0.0.1:1234'],
    environmentDescriptor: () => ({ label: 'Fixture PC' }),
  }) as AndroidRemoteGatewayController;
  try {
    for (const enabled of [true, false, true]) {
      desktopSync = enabled;
      const result = await owner.nativeUpgradeRuntime(root);
      expect(result.configuration.claude).toEqual({ executable: await realpath(process.execPath),
        profile: await realpath(root), model: 'default', remote_control: enabled });
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex-only upgrade does not require or create an unused Claude installation', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'upgrade-codex-only-'));
  const env = { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: root };
  delete env.CLAUDE_CONFIG_DIR;
  // Bun caches homedir(), so exercise a genuinely fresh source process instead
  // of changing its already-resolved home midway through a unit test.
  const script = `
    import { AndroidRemoteGatewayController } from './src/android-remote/gateway.ts';
    import { mkdir, stat } from 'node:fs/promises';
    import { join } from 'node:path';
    import { strict as assert } from 'node:assert';
    const root = process.env.HOME;
    let probes = 0;
    const owner = Object.assign(Object.create(AndroidRemoteGatewayController.prototype), {
      gatewayStatus: 'ready', server: { hostname: '127.0.0.1' }, boundPort: 1234,
      listeningOnLocalNetwork: true,
      store: { read: () => ({ settings: { connectionChoice: 'local', localNetworkEnabled: true, tunnelMode: 'quick' } }) },
      cloudflareTunnel: { state: () => ({ status: 'stopped' }) },
      runtime: { upgradeExecutable: async () => process.execPath },
      claudeCode: () => ({ upgradeExecutable: () => { probes++; throw new Error('configured executable missing'); } }),
      requireCodex: () => ({ request: async () => ({ data: [{ isDefault: true, model: 'fixture-model' }] }) }),
      pairingUrls: () => ['http://127.0.0.1:1234'], environmentDescriptor: () => ({ label: 'Fixture PC' }),
    });
    const result = await owner.nativeUpgradeRuntime(root);
    assert.equal(result.configuration.claude, undefined);
    assert.equal(result.profiles.claude, undefined);
    assert.equal(probes, 0);
    assert.equal(await stat(join(root, '.claude')).then(() => true, () => false), false);
    process.env.CLAUDE_CONFIG_DIR = join(root, 'explicit-missing');
    await assert.rejects(owner.nativeUpgradeRuntime(root));
    delete process.env.CLAUDE_CONFIG_DIR;
    await mkdir(join(root, '.claude'));
    await assert.rejects(owner.nativeUpgradeRuntime(root), /configured executable missing/);
    assert.equal(probes, 1);
  `;
  try {
    const child = spawnSync(process.execPath, ['--eval', script], { env, cwd: join(import.meta.dir, '..'), windowsHide: true, timeout: 15_000, encoding: 'utf8' });
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
