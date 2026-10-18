/** Public session metadata only. Never forward MCP configs, headers, env, or plugin paths. */
type Row = Record<string, any>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.slice(0, 256).filter(v => v && typeof v === 'object') : [];
const name = (value: unknown): string => typeof value === 'string' && /^[\w.:@/-]{1,200}$/.test(value) ? value : '';
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').slice(0, 500) : '';
const names = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.slice(0, 256).map(name).filter(Boolean))] : [];

export function claudeCapabilities(init: Row, commands: unknown, servers: unknown) {
  const terminal = new Set(names(init.terminal_slash_commands));
  const descriptions = new Map(rows(commands).map(c => [name(c.name), text(c.description)]));
  const skills = names(init.skills).filter(n => !terminal.has(n)).map(n => ({
    name: n, path: `claude-skill:${n}`, scope: 'session', enabled: true,
    ...(descriptions.get(n) ? { description: descriptions.get(n) } : {}),
  }));
  return {
    skills,
    // Only prompt-backed skills are actionable here. Terminal commands and
    // plugin management are not remote prompt invocations.
    slashCommands: skills.map(s => ({ name: s.name, ...(s.description ? { description: s.description } : {}) })),
    plugins: rows(init.plugins).filter(p => name(p.name)).map(p => ({
      name: name(p.name), version: text(p.version) || null,
      skills: skills.filter(s => s.name.startsWith(`${p.name}:`)).map(s => s.name),
    })),
    mcpServers: rows(servers).filter(s => name(s.name)).map(s => ({
      name: name(s.name), status: ['connected', 'failed', 'needs-auth', 'pending', 'disabled'].includes(s.status) ? s.status : 'unknown',
      tools: rows(s.tools).map(t => name(t.name)).filter(Boolean),
    })),
  };
}
