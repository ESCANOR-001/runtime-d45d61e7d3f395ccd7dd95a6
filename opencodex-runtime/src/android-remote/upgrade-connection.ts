import type { AndroidRemoteSettings } from './store';

/** A phone may be away even when the dashboard's Local tab is selected. Any
 * active temporary connection must survive the upgrade, or the source stays up. */
export function assertUpgradeableConnection(
  settings: Pick<AndroidRemoteSettings, 'connectionChoice' | 'localNetworkEnabled' | 'tunnelMode'>,
  listeningOnLocalNetwork: boolean,
  tunnelStatus: string,
  retainsQuickTunnel = false,
): void {
  void listeningOnLocalNetwork;
  if (settings.tunnelMode === 'quick' && tunnelStatus !== 'stopped' && !retainsQuickTunnel) {
    throw new Error('A temporary tunnel cannot retain its address during upgrade; the current bridge remains active.');
  }
}
