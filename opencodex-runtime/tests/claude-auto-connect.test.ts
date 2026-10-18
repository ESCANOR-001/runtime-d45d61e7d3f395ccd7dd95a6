import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeAutoConnect, claudeDesktopSettingsPath } from '../src/claude-code/auto-connect';
import { ManagedClaudeCode } from '../src/claude-code/managed';

const roots: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-auto-connect-')); roots.push(dir);
  const desktopFile = join(dir, 'desktop.json');
  return { dir, file: join(dir, 'settings.json'), desktopFile, settings: new ClaudeAutoConnect(dir, desktopFile) };
}
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));

test('reading defaults does not create settings; toggling preserves all unrelated settings', () => {
  const f = fixture();
  expect(f.settings.status()).toEqual({ preference: null, blockedByUserSettings: false, desktopPreference: 'unknown', error: null });
  expect(readdirSync(f.dir)).toEqual([]);
  const prior = { env: { PRIVATE_SETTING: 'fixture-value' }, permissions: { allow: ['Read'] }, model: 'sonnet', unknown: [1, 2] };
  writeFileSync(f.file, JSON.stringify(prior), { mode: 0o640 });
  expect(f.settings.set(true).preference).toBe(true);
  expect(JSON.parse(readFileSync(f.file, 'utf8'))).toEqual({ ...prior, remoteControlAtStartup: true });
  if (process.platform !== 'win32') expect(statSync(f.file).mode & 0o777).toBe(0o640);
  const saved = readFileSync(f.file, 'utf8');
  f.settings.set(true); expect(readFileSync(f.file, 'utf8')).toBe(saved);
  f.settings.set(false);
  expect(JSON.parse(readFileSync(f.file, 'utf8'))).toEqual({ ...prior, remoteControlAtStartup: false });
  expect(readdirSync(f.dir)).toEqual(['settings.json']);
});

test('detects Desktop off independently of the shared preference, refreshes, and never writes Desktop config', () => {
  const f = fixture();
  const config = { preferences: { ccRemoteControlDefaultEnabled: false }, mcpServers: { private: { token: 'fixture-secret' } } };
  const original = JSON.stringify(config, null, 4);
  writeFileSync(f.desktopFile, original, { mode: 0o640 });
  expect(f.settings.set(true)).toMatchObject({ preference: true, desktopPreference: 'off' });
  expect(readFileSync(f.desktopFile, 'utf8')).toBe(original);
  expect(JSON.stringify(f.settings.status())).not.toContain('fixture-secret');
  writeFileSync(f.desktopFile, JSON.stringify({ preferences: { ccRemoteControlDefaultEnabled: true } }));
  expect(f.settings.status().desktopPreference).toBe('on');
  expect(f.settings.set(false)).toMatchObject({ preference: false, desktopPreference: 'on' });
  expect(JSON.parse(readFileSync(f.desktopFile, 'utf8')).preferences.ccRemoteControlDefaultEnabled).toBe(true);
  writeFileSync(f.desktopFile, '{"preferences":{}}');
  expect(f.settings.status().desktopPreference).toBe('default');
  writeFileSync(f.desktopFile, '{}');
  expect(f.settings.status().desktopPreference).toBe('default');
});

test('unreadable or unrecognized Desktop settings stay unknown without leaking contents or changing files', () => {
  const f = fixture();
  for (const input of ['{private-broken', 'null', '[]', '{"preferences":null}', '{"preferences":[]}', '{"preferences":{"ccRemoteControlDefaultEnabled":"false"}}', ' '.repeat(1024 * 1024 + 1)]) {
    writeFileSync(f.desktopFile, input);
    expect(f.settings.status()).toMatchObject({ desktopPreference: 'unknown', error: null });
    expect(readFileSync(f.desktopFile, 'utf8')).toBe(input);
  }
  rmSync(f.desktopFile); mkdirSync(f.desktopFile);
  expect(f.settings.status().desktopPreference).toBe('unknown');
  rmSync(f.desktopFile, { recursive: true });
  if (process.platform !== 'win32') {
    writeFileSync(f.file, '{"preferences":{"ccRemoteControlDefaultEnabled":false}}');
    symlinkSync(f.file, f.desktopFile);
    expect(f.settings.status().desktopPreference).toBe('unknown');
  }
  expect(new ClaudeAutoConnect(f.dir, null).status().desktopPreference).toBe('unknown');
});

test('locates native Desktop preferences on supported hosts without using the CLI config directory', () => {
  expect(claudeDesktopSettingsPath('linux', '/users/test', {})).toBe(join('/users/test', '.config', 'Claude', 'claude_desktop_config.json'));
  expect(claudeDesktopSettingsPath('linux', '/users/test', { XDG_CONFIG_HOME: '/config' })).toBe(join('/config', 'Claude', 'claude_desktop_config.json'));
  expect(claudeDesktopSettingsPath('darwin', '/users/test', {})).toBe(join('/users/test', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  expect(claudeDesktopSettingsPath('win32', '/users/test', { APPDATA: '/roaming' })).toBe(join('/roaming', 'Claude', 'claude_desktop_config.json'));
  expect(claudeDesktopSettingsPath('win32', '/users/test', {})).toBe(join('/users/test', 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  expect(claudeDesktopSettingsPath('freebsd', '/users/test', {})).toBeNull();
});

test('never bypasses a user disable flag or overwrites malformed settings', () => {
  const f = fixture();
  for (const input of ['{secret-invalid', 'null', '[]', '"secret-string"']) {
    writeFileSync(f.file, input);
    expect(f.settings.status().error).not.toContain('secret');
    expect(() => f.settings.set(true)).toThrow();
    expect(readFileSync(f.file, 'utf8')).toBe(input);
  }
  writeFileSync(f.file, JSON.stringify({ disableRemoteControl: true }));
  expect(f.settings.status().blockedByUserSettings).toBe(true);
  expect(() => f.settings.set(true)).toThrow('disabled');
  expect(JSON.parse(readFileSync(f.file, 'utf8'))).toEqual({ disableRemoteControl: true });
  expect(f.settings.set(false).preference).toBe(false);
  expect(JSON.parse(readFileSync(f.file, 'utf8')).disableRemoteControl).toBe(true);
});

test('rejects unsafe setting targets and non-boolean updates', () => {
  const f = fixture();
  expect(() => f.settings.set('true' as any)).toThrow('true or false');
  mkdirSync(f.file);
  expect(() => f.settings.set(true)).toThrow('regular JSON');
  rmSync(f.file, { recursive: true });
  const other = join(f.dir, 'other.json'); writeFileSync(other, '{}');
  if (process.platform !== 'win32') {
    symlinkSync(other, f.file);
    expect(() => f.settings.set(true)).toThrow('regular JSON');
    expect(readFileSync(other, 'utf8')).toBe('{}');
  }
});

test('the narrow setup action enables sharing without starting a worker and off leaves sharing enabled', async () => {
  const f = fixture(); let starts = 0;
  const service = new ManagedClaudeCode(join(f.dir, 'remodex'), (() => { starts++; throw new Error('no worker'); }) as any, undefined, undefined, undefined, undefined, f.settings);
  await expect(service.setAutoConnect({ enabled: true, binary: '/not-allowed' })).rejects.toThrow('only');
  expect(readdirSync(f.dir)).toEqual([]);
  expect(await service.setAutoConnect({ enabled: true })).toMatchObject({ enabled: true, desktopSync: true, autoConnect: { preference: true } });
  expect(await service.setAutoConnect({ enabled: false })).toMatchObject({ enabled: true, desktopSync: true, autoConnect: { preference: false } });
  expect(starts).toBe(0);
  await service.close();
});
