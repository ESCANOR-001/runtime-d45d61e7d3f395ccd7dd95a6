import { expect, test } from 'bun:test';
import { claudeRemoteFailure, claudeVerificationIssue } from '../src/claude-code/verification';

test('only explicit connection errors identify verification, not a saved preference or generic denial', () => {
  for (const message of ['Your organization requires Trusted Devices for Remote Control, but this device is not enrolled', 'session expired for trusted-device check', 'trusted_device_required', 'trusted_device_session_expired']) {
    expect(claudeVerificationIssue(message)).toBe('device-verification');
  }
  expect(claudeVerificationIssue('Refresh your Claude Code login on this PC')).toBe('sign-in');
  for (const message of ['HTTP 403', 'Claude Code is ready', 'Trusted Devices is enabled', 'Workspace not trusted', 'Network offline']) {
    expect(claudeVerificationIssue(message)).toBeNull();
  }
});

test('upstream trust and authentication errors return safe instructions without reflecting bodies', async () => {
  const response = Response.json({ error: { type: 'trusted_device_required', message: 'fixture-private-value' } }, { status: 403 });
  const error = await claudeRemoteFailure(response);
  expect(claudeVerificationIssue(error)).toBe('device-verification');
  expect(error.message).toContain('pairing is still saved');
  expect(error.message).not.toContain('fixture-private-value');
  const login = await claudeRemoteFailure(new Response('fixture-private-value', { status: 401 }));
  expect(claudeVerificationIssue(login)).toBe('sign-in');
  expect(login.message).not.toContain('fixture-private-value');
});

test('generic or unparseable HTTP 403 remains unknown rather than claiming trust was lost', async () => {
  for (const body of ['<html>trusted_device_required</html>', JSON.stringify({ error: { message: 'Access denied' } }), 'x'.repeat(20_000)]) {
    const error = await claudeRemoteFailure(new Response(body, { status: 403 }));
    expect(error.message).toContain('HTTP 403');
    expect(claudeVerificationIssue(error)).toBeNull();
  }
});

test('oversized error streams are cancelled instead of being retained', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(20_000)); }, cancel() { cancelled = true; } });
  const error = await claudeRemoteFailure(new Response(body, { status: 503 }));
  expect(error.message).toContain('503');
  expect(cancelled).toBe(true);
});

test('a trust-specific 401 remains a device-verification error', async () => {
  const error = await claudeRemoteFailure(Response.json({ error: { type: 'trusted_device_session_expired' } }, { status: 401 }));
  expect(claudeVerificationIssue(error)).toBe('device-verification');
});
