import type { ElicitationRequest, ElicitationResult } from '@anthropic-ai/claude-agent-sdk';
import { ElicitRequestFormParamsSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

type Row = Record<string, any>;
type Question = {
  id: string; header: string; question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean; isOther: boolean; isSecret: boolean;
};
export type ClaudeElicitationForm = {
  questions: Question[];
  answer: (answers: Row) => ElicitationResult;
};

const text = (value: unknown) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 2000) : '';
const unsupported = () => new TypeError('This MCP request needs a form that Remodex cannot display. Continue it on the PC.');
const values = (answer: unknown): string[] => {
  const value = answer && typeof answer === 'object' && !Array.isArray(answer) ? (answer as Row).answers : answer;
  const items = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(items) || !items.length || items.length > 32 || items.some(v => typeof v !== 'string' || !v.trim() || v.length > 4000))
    throw new TypeError('Answer each MCP question before submitting.');
  return items;
};

/** Adapt MCP's flat, typed forms to the existing Android question sheet. */
export function claudeElicitationForm(request: ElicitationRequest): ClaudeElicitationForm {
  if (request.mode === 'url') throw new TypeError('This MCP server needs a browser step. Complete it on the PC, then retry the tool.');
  if (JSON.stringify(request.requestedSchema ?? {}).length > 32_000) throw unsupported();
  const parsed = ElicitRequestFormParamsSchema.safeParse({ message: request.message, requestedSchema: request.requestedSchema });
  if (!parsed.success) throw unsupported();
  const schema = parsed.data.requestedSchema;
  const fields = Object.entries(schema.properties);
  if (fields.length > 16 || schema.required?.some(key => !Object.hasOwn(schema.properties, key))) throw unsupported();
  // Do not silently discard constraints the phone cannot represent or validate.
  const allowed = new Set(['type', 'title', 'description', 'default', 'enum', 'enumNames', 'oneOf', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'format']);
  if (Object.keys(request.requestedSchema ?? {}).some(key => !['type', 'properties', 'required', 'title', 'description', '$schema', 'additionalProperties'].includes(key))) throw unsupported();
  for (const [key] of fields) {
    const raw = (request.requestedSchema!.properties as Row)[key];
    if (Object.keys(raw).some(k => !allowed.has(k))) throw unsupported();
    if (raw.items && Object.keys(raw.items).some(k => !['type', 'enum', 'anyOf'].includes(k))) throw unsupported();
    for (const option of raw.oneOf ?? raw.items?.anyOf ?? []) if (Object.keys(option).some(k => !['const', 'title'].includes(k))) throw unsupported();
  }
  const context = `${text(request.serverName)}: ${text(request.message)}`;
  if (!fields.length) return {
    questions: [{ id: 'mcp-confirm', header: 'MCP request', question: context, options: [{ label: 'Continue', description: '' }, { label: 'Decline', description: '' }], multiSelect: false, isOther: false, isSecret: false }],
    answer: answers => {
      const selected = values(answers['mcp-confirm']);
      if (selected.length !== 1 || !['Continue', 'Decline'].includes(selected[0])) throw new TypeError('Choose Continue or Decline.');
      return selected[0] === 'Continue' ? { action: 'accept', content: {} } : { action: 'decline' };
    },
  };
  const mapped = fields.map(([key, definition], index) => {
    const field = definition as Row;
    let choices: { label: string; value: string | boolean }[] = [];
    const enumSource = field.type === 'array' ? field.items : field;
    const named = enumSource.oneOf ?? enumSource.anyOf;
    if (Array.isArray(named)) choices = named.map(v => ({ label: text(v.title), value: v.const }));
    else if (Array.isArray(enumSource.enum)) choices = enumSource.enum.map((v: string, i: number) => ({ label: text(field.enumNames?.[i] ?? v), value: v }));
    else if (field.type === 'boolean') choices = [{ label: 'Yes', value: true }, { label: 'No', value: false }];
    if ((Array.isArray(named) || Array.isArray(enumSource.enum)) && !choices.length) throw unsupported();
    if (choices.length > 32 || choices.some(v => !v.label) || new Set(choices.map(v => v.label)).size !== choices.length) throw unsupported();
    const optional = !schema.required?.includes(key);
    let skip = 'Leave empty'; while (choices.some(v => v.label === skip)) skip += ' (optional)';
    const id = `mcp-field-${index}`;
    const label = text(field.title || key);
    const question = `${index === 0 ? context + '\n\n' : ''}${label}${optional ? ' (optional)' : ''}${field.description ? '\n' + text(field.description) : ''}`;
    return { key, field, choices, optional, skip, id, question: {
      id, header: label.slice(0, 80), question,
      // The Android question contract requires a description, even when empty.
      options: [...choices.map(v => ({ label: v.label, description: '' })), ...(optional ? [{ label: skip, description: '' }] : [])],
      multiSelect: field.type === 'array', isOther: choices.length === 0, isSecret: false,
    } };
  });
  // Per-request validator: its schema cache is released with the pending form.
  const validate = new AjvJsonSchemaValidator().getValidator({ ...schema, additionalProperties: false } as any);
  return {
    questions: mapped.map(field => field.question),
    answer: answers => {
      const content: Record<string, string | number | boolean | string[]> = Object.create(null);
      for (const entry of mapped) {
        const selected = values(answers[entry.id]);
        if (entry.optional && selected.includes(entry.skip)) {
          if (selected.length !== 1) throw new TypeError(`Choose a value or Leave empty for ${entry.question.header}.`);
          continue;
        }
        if (entry.field.type !== 'array' && selected.length !== 1) throw new TypeError(`Choose one value for ${entry.question.header}.`);
        const converted = selected.map(value => {
          if (entry.choices.length) {
            const choice = entry.choices.find(c => c.label === value);
            if (!choice) throw new TypeError(`Choose a listed value for ${entry.question.header}.`);
            return choice.value;
          }
          if (['integer', 'number'].includes(entry.field.type)) {
            if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value.trim())) throw new TypeError(`Enter a number for ${entry.question.header}.`);
            return Number(value);
          }
          return value;
        });
        content[entry.key] = entry.field.type === 'array' ? converted as string[] : converted[0];
      }
      const result = validate(content);
      if (!result.valid) throw new TypeError('Check the MCP answers: ' + result.errorMessage.slice(0, 400));
      return { action: 'accept', content };
    },
  };
}
