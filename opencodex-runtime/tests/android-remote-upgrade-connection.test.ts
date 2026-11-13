import { expect, test } from 'bun:test';
import { assertUpgradeableConnection } from '../src/android-remote/upgrade-connection';

test('selecting the local tab does not authorize breaking an away phone temporary connection', () => {
  for (const status of ['starting', 'checking', 'ready', 'error']) {
    expect(() => assertUpgradeableConnection({ connectionChoice: 'local', localNetworkEnabled: true, tunnelMode: 'quick' }, true, status)).toThrow('temporary tunnel');
  }
  expect(() => assertUpgradeableConnection({connectionChoice:'local',localNetworkEnabled:true,tunnelMode:'quick'},true,'stopped')).not.toThrow();
  expect(() => assertUpgradeableConnection({connectionChoice:'local',localNetworkEnabled:true,tunnelMode:'quick'},true,'ready',true)).not.toThrow();
});

test('remote-only, unselected and non-listening connections cannot silently lose a quick address', () => {
  for (const connectionChoice of ['quick', undefined] as const) {
    expect(() => assertUpgradeableConnection({ connectionChoice, localNetworkEnabled: true, tunnelMode: 'quick' }, true, 'ready')).toThrow('temporary tunnel');
  }
  for (const [enabled, listening] of [[true, false], [false, true], [false, false]]) {
    expect(() => assertUpgradeableConnection({ connectionChoice: 'local', localNetworkEnabled: enabled, tunnelMode: 'quick' }, listening, 'ready')).toThrow('temporary tunnel');
  }
  expect(() => assertUpgradeableConnection({ connectionChoice: 'named', localNetworkEnabled: false, tunnelMode: 'named' }, false, 'ready')).not.toThrow();
});

test('a verified retained quick connector permits a remote-only upgrade without changing the address', () => {
  expect(() => assertUpgradeableConnection({ connectionChoice: 'quick', localNetworkEnabled: false,
    tunnelMode: 'quick' }, false, 'ready', true)).not.toThrow();
});
