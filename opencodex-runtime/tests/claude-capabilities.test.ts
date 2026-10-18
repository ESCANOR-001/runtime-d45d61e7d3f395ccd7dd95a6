import { expect, test } from 'bun:test';
import { claudeCapabilities } from '../src/claude-code/capabilities';

test('projects loaded skills and plugin metadata without credentials, paths or terminal commands', () => {
  const result = claudeCapabilities({ skills: ['review', 'pkg:check', 'exit', 'review'], terminal_slash_commands: ['exit'], plugins: [{ name: 'pkg', path: '/private', version: '1.0' }] },
    [{ name: 'review', description: 'Review this project' }, { name: 'exit' }, { name: 'login' }],
    [{ name: 'drive', status: 'needs-auth', config: { env: { SECRET: 'hidden' } }, tools: [{ name: 'search', description: 'private metadata' }] }]);
  expect(result.skills.map(s => s.name)).toEqual(['review', 'pkg:check']);
  expect(result.slashCommands.map(s => s.name)).toEqual(['review', 'pkg:check']);
  expect(result.plugins).toEqual([{ name: 'pkg', version: '1.0', skills: ['pkg:check'] }]);
  expect(result.mcpServers).toEqual([{ name: 'drive', status: 'needs-auth', tools: ['search'] }]);
  expect(JSON.stringify(result)).not.toMatch(/private|hidden|SECRET|login/);
});

test('bounds malformed provider metadata and rejects names that cannot identify commands', () => {
  const result = claudeCapabilities({ skills: [null, 'bad\ncommand', 'ok'], plugins: [null, { name: '' }] }, null, [{ name: 'ok', status: 'new-state' }]);
  expect(result.skills).toHaveLength(1);
  expect(result.plugins).toEqual([]);
  expect(result.mcpServers[0].status).toBe('unknown');
});
