import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type ClaudeAutoConnectStatus = {
  preference: boolean | null;
  blockedByUserSettings: boolean;
  desktopPreference: 'on' | 'off' | 'default' | 'unknown';
  error: string | null;
};

/** Read the native preference only; paths and unrelated Desktop settings never leave this PC. */
export function claudeDesktopSettingsPath(platform = process.platform, home = homedir(), env = process.env): string | null {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (platform === 'linux') return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude', 'claude_desktop_config.json');
  return null;
}

/** Only writes the documented user preference. Never edits Desktop's private config or policies. */
export class ClaudeAutoConnect {
  constructor(private readonly directory = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    private readonly desktopSettingsFile = claudeDesktopSettingsPath()) {}

  private desktopPreference(): ClaudeAutoConnectStatus['desktopPreference'] {
    if (!this.desktopSettingsFile) return 'unknown';
    try {
      const info = lstatSync(this.desktopSettingsFile);
      if (!info.isFile() || info.size > 1024 * 1024) return 'unknown';
      const value = JSON.parse(readFileSync(this.desktopSettingsFile, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
      if (value.preferences === undefined) return 'default';
      const preferences = value.preferences;
      if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return 'unknown';
      const setting = preferences.ccRemoteControlDefaultEnabled;
      if (setting === undefined) return 'default';
      return setting === true ? 'on' : setting === false ? 'off' : 'unknown';
    } catch { return 'unknown'; }
  }

  private read(): { value: Record<string, unknown>; source: string | null; mode: number } {
    const path = join(this.directory, 'settings.json');
    let info;
    try { info = lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: {}, source: null, mode: 0o600 };
      throw new Error('Could not read Claude user settings. Check file permissions on this PC.');
    }
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Claude user settings must be a regular JSON file smaller than 1 MB.');
    try {
      const source = readFileSync(path, 'utf8');
      const value = JSON.parse(source);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return { value, source, mode: info.mode & 0o777 };
    } catch { throw new Error('Claude user settings could not be read as JSON. Fix them on this PC before changing automatic sync.'); }
  }

  status(): ClaudeAutoConnectStatus {
    const desktopPreference = this.desktopPreference();
    try {
      const { value } = this.read();
      return { preference: typeof value.remoteControlAtStartup === 'boolean' ? value.remoteControlAtStartup : null,
        blockedByUserSettings: value.disableRemoteControl === true, desktopPreference, error: null };
    } catch (error) {
      return { preference: null, blockedByUserSettings: false, desktopPreference, error: (error as Error).message };
    }
  }

  set(enabled: boolean): ClaudeAutoConnectStatus {
    if (typeof enabled !== 'boolean') throw new TypeError('Automatic sync must be true or false.');
    const before = this.read();
    if (enabled && before.value.disableRemoteControl === true) {
      throw new Error('Remote Control is disabled in Claude user settings. Enable it there before turning on automatic sync.');
    }
    if (before.value.remoteControlAtStartup === enabled) return this.status();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const target = join(this.directory, 'settings.json');
    const temporary = join(this.directory, `.settings.remodex-${randomUUID()}.tmp`);
    // This is a user-owned Claude file: do not register it for Remodex uninstall cleanup.
    try {
      writeFileSync(temporary, JSON.stringify({ ...before.value, remoteControlAtStartup: enabled }, null, 2) + '\n',
        { encoding: 'utf8', mode: before.mode, flag: 'wx' });
      if (this.read().source !== before.source) throw new Error('Claude settings changed while saving. Refresh and try again.');
      renameSync(temporary, target);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Claude settings changed')) throw error;
      throw new Error('Could not save automatic sync in Claude user settings. Check file permissions on this PC.');
    } finally {
      try { unlinkSync(temporary); } catch { /* Rename already removed the temporary file. */ }
    }
    return this.status();
  }
}
