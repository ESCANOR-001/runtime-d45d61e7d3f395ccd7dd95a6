import { createHash } from "node:crypto";
import { getConfigDir } from "../config";

const KEYRING_SERVICE = "opencodex.android-remote.cloudflare.v1";
const KEYRING_TIMEOUT_MS = 8_000;

type KeyringEntry = {
  getSecret(signal?: AbortSignal): Promise<Uint8Array | number[] | undefined>;
  setSecret(secret: Uint8Array, signal?: AbortSignal): Promise<void>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
};

export interface AndroidRemoteCloudflareSecretStore {
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
  removeToken(): Promise<void>;
}

export class AndroidRemoteCloudflareSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AndroidRemoteCloudflareSecretError";
  }
}

function keyringAccount(configDir = getConfigDir()): string {
  return createHash("sha256")
    .update("opencodex-android-remote-cloudflare-v1\0")
    .update(configDir)
    .digest("hex");
}

function isMissingCredential(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:no\s*entry|no\s*credential|not\s*found)/iu.test(message);
}

function wipe(value: Uint8Array | number[] | undefined): void {
  try {
    value?.fill(0);
  } catch {
    // Secret cleanup must not replace the primary keyring result.
  }
}

export class OsAndroidRemoteCloudflareSecretStore
  implements AndroidRemoteCloudflareSecretStore
{
  constructor(
    private readonly entryFactory: () => Promise<KeyringEntry> = async () => {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      return new AsyncEntry(KEYRING_SERVICE, keyringAccount()) as KeyringEntry;
    },
  ) {}

  async getToken(): Promise<string | null> {
    let secret: Uint8Array | number[] | undefined;
    let decodedBytes: Uint8Array | undefined;
    try {
      secret = await (await this.entryFactory()).getSecret(
        AbortSignal.timeout(KEYRING_TIMEOUT_MS),
      );
      if (!secret) return null;
      decodedBytes = secret instanceof Uint8Array ? secret : Uint8Array.from(secret);
      const token = new TextDecoder().decode(decodedBytes).trim();
      return token.length > 0 ? token : null;
    } catch (error) {
      if (isMissingCredential(error)) return null;
      throw new AndroidRemoteCloudflareSecretError(
        "The operating-system credential store could not read the Cloudflare tunnel token.",
      );
    } finally {
      if (decodedBytes !== secret) wipe(decodedBytes);
      wipe(secret);
    }
  }

  async setToken(token: string): Promise<void> {
    const secret = new TextEncoder().encode(token);
    try {
      await (await this.entryFactory()).setSecret(
        secret,
        AbortSignal.timeout(KEYRING_TIMEOUT_MS),
      );
    } catch {
      throw new AndroidRemoteCloudflareSecretError(
        "The operating-system credential store could not save the Cloudflare tunnel token.",
      );
    } finally {
      wipe(secret);
    }
  }

  async removeToken(): Promise<void> {
    try {
      await (await this.entryFactory()).deleteCredential(
        AbortSignal.timeout(KEYRING_TIMEOUT_MS),
      );
    } catch (error) {
      if (isMissingCredential(error)) return;
      throw new AndroidRemoteCloudflareSecretError(
        "The operating-system credential store could not remove the Cloudflare tunnel token.",
      );
    }
  }
}
