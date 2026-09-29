import { expect, test } from "bun:test";
import { AndroidRemoteAuth } from "../src/android-remote/auth";
import type { AndroidRemoteStore } from "../src/android-remote/store";

test("failed credential persistence leaves the invitation usable, but success consumes it once", () => {
  let writes = 0;
  const store = {
    read() {
      return { clients: [] };
    },
    upsertClient() {
      if (++writes === 1) throw new Error("disk write failed");
    },
  } as unknown as AndroidRemoteStore;
  const auth = new AndroidRemoteAuth(store);
  const invitation = auth.createInvitation({ desktopName: "Test", localUrls: ["http://192.168.1.2:10105"] });
  const input = { pairingToken: invitation.payload.pairingToken, metadata: {} };
  expect(() => auth.exchangePairingToken(input)).toThrow("disk write failed");
  expect(auth.hasInvitation(invitation.id)).toBe(true);
  expect(auth.exchangePairingToken(input)?.accessToken).toStartWith("ocx_android_");
  expect(auth.hasInvitation(invitation.id)).toBe(false);
  expect(auth.exchangePairingToken(input)).toBeNull();
  expect(writes).toBe(2);
});
