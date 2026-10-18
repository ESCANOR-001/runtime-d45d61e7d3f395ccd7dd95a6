import { expect, test } from 'bun:test';
import { claudeElicitationForm } from '../src/claude-code/elicitation';

const form = (properties: Record<string, any>, required = Object.keys(properties)) => claudeElicitationForm({
  serverName: 'test-server', message: 'Choose the report settings.', requestedSchema: { type: 'object', properties, required },
});

test('MCP questions preserve typed values, labels, multiple choices and omitted optional fields', () => {
  const f = form({
    name: { type: 'string', minLength: 2 },
    count: { type: 'integer', minimum: 1, maximum: 10 },
    enabled: { type: 'boolean' },
    color: { type: 'string', oneOf: [{ const: 'b', title: 'Blue' }, { const: 'g', title: 'Green' }] },
    shapes: { type: 'array', minItems: 1, items: { anyOf: [{ const: 'c', title: 'Circle' }, { const: 's', title: 'Square' }] } },
    note: { type: 'string' },
  }, ['name', 'count', 'enabled', 'color', 'shapes']);
  expect(f.questions[0].question).toContain('test-server: Choose the report settings.');
  expect(f.questions[4].multiSelect).toBe(true);
  const answers = { 'mcp-field-0': { answers: ['Sunny'] }, 'mcp-field-1': '3', 'mcp-field-2': 'No', 'mcp-field-3': 'Blue', 'mcp-field-4': ['Circle', 'Square'], 'mcp-field-5': 'Leave empty' };
  expect(f.answer(answers)).toEqual({ action: 'accept', content: { name: 'Sunny', count: 3, enabled: false, color: 'b', shapes: ['c', 's'] } });
  expect(() => f.answer({ ...answers, 'mcp-field-1': '11' })).toThrow('Check the MCP answers');
  expect(() => f.answer({ ...answers, 'mcp-field-1': '1.2' })).toThrow('Check the MCP answers');
  expect(() => f.answer({ ...answers, 'mcp-field-1': 'Infinity' })).toThrow('Enter a number');
  expect(() => f.answer({ ...answers, 'mcp-field-3': 'Red' })).toThrow('listed value');
  expect(() => f.answer({ ...answers, 'mcp-field-3': ['Blue', 'Green'] })).toThrow('one value');
  expect(() => f.answer({})).toThrow('Answer each');
});

test('MCP forms validate email and date constraints before responding', () => {
  const f = form({ email: { type: 'string', format: 'email' }, date: { type: 'string', format: 'date' } });
  expect(() => f.answer({ 'mcp-field-0': 'invalid', 'mcp-field-1': '2026-02-30' })).toThrow('Check the MCP answers');
  expect(f.answer({ 'mcp-field-0': 'test@example.com', 'mcp-field-1': '2026-10-17' }).action).toBe('accept');
});

test('all MCP choices satisfy the Android question option contract', () => {
  const forms = [form({}), form({ enabled: { type: 'boolean' }, choice: { type: 'string', enum: ['One', 'Two'] }, note: { type: 'string' } }, [])];
  for (const f of forms) for (const question of f.questions) {
    expect(question.options.length).toBeGreaterThan(0);
    for (const option of question.options) {
      expect(typeof option.label).toBe('string');
      expect(typeof option.description).toBe('string');
    }
  }
});

test('empty MCP forms require an explicit continue or decline', () => {
  const f = form({});
  expect(f.answer({ 'mcp-confirm': 'Continue' })).toEqual({ action: 'accept', content: {} });
  expect(f.answer({ 'mcp-confirm': 'Decline' })).toEqual({ action: 'decline' });
  expect(() => f.answer({})).toThrow();
});

test('MCP optional choices cannot confuse a real value with omission', () => {
  const f = form({ x: { type: 'array', items: { type: 'string', enum: ['Leave empty', 'One'] } } }, []);
  expect(f.questions[0].options.at(-1)?.label).toBe('Leave empty (optional)');
  expect(f.answer({ 'mcp-field-0': ['Leave empty'] })).toEqual({ action: 'accept', content: { x: ['Leave empty'] } });
  expect(() => f.answer({ 'mcp-field-0': ['One', 'Leave empty (optional)'] })).toThrow('Choose a value or Leave empty');
});

test('unsupported MCP schemas and browser steps are explicit rather than silently accepted', () => {
  expect(() => claudeElicitationForm({ serverName: 'auth', message: 'Sign in', mode: 'url', url: 'https://example.com/?secret=not-persisted' })).toThrow('browser step');
  for (const property of [{ type: 'object', properties: {} }, { type: 'string', pattern: 'secret' }, { type: 'string', oneOf: [{ const: 'a', title: 'same' }, { const: 'b', title: 'same' }] }]) expect(() => form({ value: property })).toThrow('cannot display');
  expect(() => form(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [i, { type: 'boolean' }])))).toThrow('cannot display');
});
