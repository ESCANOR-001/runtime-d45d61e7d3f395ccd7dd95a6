import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidRemoteAuth } from "../src/android-remote/auth";
import { createAndroidRemoteStore } from "../src/android-remote/store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remodex-repair-"));
  roots.push(root);
  const store = createAndroidRemoteStore(root);
  return { root, store, auth: new AndroidRemoteAuth(store) };
}

function invitation(auth: AndroidRemoteAuth, replaceClientId?: string) {
  return auth.createInvitation({ desktopName: "Test PC", localUrls: ["http://192.168.1.2:10105"], replaceClientId });
}

function pair(auth: AndroidRemoteAuth, installationId?: string, replaceClientId?: string) {
  const qr = invitation(auth, replaceClientId);
  return auth.exchangePairingToken({ pairingToken: qr.payload.pairingToken,
    metadata: { label: "Same phone model", os: "android", installationId }, address: "192.168.1.9" })!;
}

test("repeat scans rotate one installation's authorization and invalidate old tokens and tickets", () => {
  const { store, auth } = fixture();
  const first = pair(auth, "installation-one");
  const ticket = auth.issueWebSocketTicket(first.client.id);
  const second = pair(auth, "installation-one");
  expect(store.read().clients).toHaveLength(1);
  expect(second.replacedClientIds).toEqual([first.client.id]);
  expect(second.client.id).not.toBe(first.client.id);
  expect(auth.authenticateAccessToken(first.accessToken)).toBeNull();
  expect(auth.consumeWebSocketTicket(ticket.ticket)).toBeNull();
  expect(auth.authenticateAccessToken(second.accessToken)?.client.id).toBe(second.client.id);
});

test("different installations with the same name and address remain distinct", () => {
  const { store, auth } = fixture();
  pair(auth, "installation-one");
  pair(auth, "installation-two");
  expect(store.read().clients).toHaveLength(2);
  pair(auth);
  pair(auth);
  expect(store.read().clients).toHaveLength(4);
});

test("installation identity survives a server restart without storing the raw installation ID", () => {
  const { root, store, auth } = fixture();
  pair(auth, "private-installation-identity");
  expect(readFileSync(join(root, "android-remote.json"), "utf8")).not.toContain("private-installation-identity");
  pair(new AndroidRemoteAuth(createAndroidRemoteStore(root)), "private-installation-identity");
  expect(store.read().clients).toHaveLength(1);
});

test("authenticated metadata binds a legacy authorization before its next scan", () => {
  const { store, auth } = fixture();
  const legacy = pair(auth);
  auth.updateClientMetadata(legacy.client.id, { installationId: "installation-one" });
  pair(auth, "installation-one");
  expect(store.read().clients).toHaveLength(1);
  expect(auth.authenticateAccessToken(legacy.accessToken)).toBeNull();
});

test("a row-specific QR preserves access until exchange and replaces only the selected legacy phone", () => {
  const { store, auth } = fixture();
  const first = pair(auth);
  const other = pair(auth);
  const qr = invitation(auth, first.client.id);
  expect(store.read().clients).toHaveLength(2);
  expect(auth.authenticateAccessToken(first.accessToken)).not.toBeNull();
  const repaired = auth.exchangePairingToken({ pairingToken: qr.payload.pairingToken,
    metadata: { installationId: "fresh-installation" } })!;
  expect(repaired.replacedClientIds).toEqual([first.client.id]);
  expect(store.read().clients).toHaveLength(2);
  expect(auth.authenticateAccessToken(first.accessToken)).toBeNull();
  expect(auth.authenticateAccessToken(other.accessToken)).not.toBeNull();
});

test("failed persistence preserves the original phone, ticket and retryable invitation", () => {
  const { store, auth } = fixture();
  const first = pair(auth, "installation-one");
  const qr = invitation(auth, first.client.id);
  const ticket = auth.issueWebSocketTicket(first.client.id);
  const write = spyOn(store, "upsertClient").mockImplementation(() => { throw new Error("disk full"); });
  try {
    expect(() => auth.exchangePairingToken({ pairingToken: qr.payload.pairingToken,
      metadata: { installationId: "installation-one" } })).toThrow("disk full");
    expect(auth.hasInvitation(qr.id)).toBe(true);
    expect(auth.authenticateAccessToken(first.accessToken)).not.toBeNull();
    expect(auth.consumeWebSocketTicket(ticket.ticket)?.id).toBe(first.client.id);
  } finally { write.mockRestore(); }
  expect(auth.exchangePairingToken({ pairingToken: qr.payload.pairingToken,
    metadata: { installationId: "installation-one" } })).not.toBeNull();
  expect(store.read().clients).toHaveLength(1);
});

test("revocation and replacement invalidate outstanding repair invitations", () => {
  const { store, auth } = fixture();
  const first = pair(auth, "installation-one");
  const stale = invitation(auth, first.client.id);
  pair(auth, "installation-one");
  expect(auth.exchangePairingToken({ pairingToken: stale.payload.pairingToken, metadata: {} })).toBeNull();
  const current = store.read().clients[0]!;
  const revoked = invitation(auth, current.id);
  store.revokeClient(current.id);
  expect(auth.exchangePairingToken({ pairingToken: revoked.payload.pairingToken, metadata: {} })).toBeNull();
  expect(() => invitation(auth, current.id)).toThrow("no longer exists");
});

test("one atomic write removes all identified duplicates but keeps unrelated authorizations", () => {
  const { store, auth } = fixture();
  const first = pair(auth, "installation-one");
  store.upsertClient({ ...first.client, id: "legacy-duplicate" });
  const other = pair(auth, "installation-two");
  const writes = spyOn(store, "upsertClient");
  const repaired = pair(auth, "installation-one");
  expect(writes).toHaveBeenCalledTimes(1);
  expect(repaired.replacedClientIds.sort()).toEqual([first.client.id, "legacy-duplicate"].sort());
  expect(store.read().clients.map(client => client.id).sort()).toEqual([other.client.id, repaired.client.id].sort());
  writes.mockRestore();
});
