export type InternalCliCommand =
  | "__tray-start"
  | "__tray-restart"
  | "__startup-health"
  | "__desktop-restart-codex"
  | "__desktop-restart-client";

export interface InternalCliHandlers {
  trayStart: () => void | Promise<void>;
  trayRestart: () => void | Promise<void>;
  startupHealth: () => void | Promise<void>;
  desktopRestartCodex: () => void | Promise<void>;
  desktopRestartClient: () => void | Promise<void>;
}

/** Dispatch fixed internal commands without accepting caller-selected process arguments. */
export async function dispatchInternalCliCommand(
  command: InternalCliCommand,
  handlers: InternalCliHandlers,
): Promise<void> {
  switch (command) {
    case "__tray-start": return void await handlers.trayStart();
    case "__tray-restart": return void await handlers.trayRestart();
    case "__startup-health": return void await handlers.startupHealth();
    case "__desktop-restart-codex": return void await handlers.desktopRestartCodex();
    case "__desktop-restart-client": return void await handlers.desktopRestartClient();
    default: throw new Error(`Unsupported internal CLI command: ${String(command)}`);
  }
}
