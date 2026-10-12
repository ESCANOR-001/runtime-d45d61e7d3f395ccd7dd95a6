import { createHash } from 'node:crypto';
export const hash = value => createHash('sha256').update(value).digest('hex');
// Preserve the existing driver's revisions, including Python's JSON separators.
export const stableJson = value => Array.isArray(value) ? `[${value.map(stableJson).join(', ')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).map(([k,v]) => `${JSON.stringify(k)}: ${stableJson(v)}`).join(', ')}}` : JSON.stringify(value);
export const modelName = label => label.match(/^((?:Claude )?(?:Haiku|Sonnet|Opus|Fable) \d+(?:\.\d+)*)(?:\s|$)/)?.[1] || label;
export const controlId = (path, name) => hash(path + '\n' + name);
export const chatId = uri => uri?.match(/^https:\/\/claude\.ai\/chat\/([a-f0-9-]{36})$/)?.[1];

export function historyPage(messages, before = messages.length, limit = 30) {
  if (!Number.isInteger(before) || before < 0 || before > messages.length) throw new Error('History changed. Reload the conversation history.');
  let start = before, size = 0;
  while (start > 0 && before - start < limit) {
    const amount = Buffer.byteLength(stableJson(messages[start - 1]));
    if (start < before && size + amount > 240000) break;
    size += amount; start--;
  }
  return { messages: messages.slice(start, before), start, end: before, total: messages.length, hasMore: start > 0 };
}

export function messageBodies(nodes, order) {
  const result = [];
  for (const id of order) {
    const node = nodes[id];
    if (node.role !== 'heading') continue;
    const role = node.name.startsWith('You said:') ? 'user' : node.name.startsWith('Claude responded:') ? 'assistant' : null;
    const parent = nodes[node.parent];
    if (!role || !parent) continue;
    const bodies = parent.children.filter(c => nodes[c]?.role === 'section');
    if (!bodies.length) continue;
    let article = node.parent;
    for (let depth = 0; nodes[article] && nodes[article].role !== 'article' && depth < 256; depth++) article = nodes[article].parent;
    result.push({ role, bodies, article });
  }
  return result;
}
export function extractMessages(nodes, order) {
  const kids = node => node.children.filter(c => nodes[c]);
  const raw = id => {
    const n = nodes[id];
    if (['button','tool bar','statusbar'].includes(n.role) || n.class?.includes('sr-only')) return '';
    return n.children.length ? kids(n).map(raw).join('') : n.name;
  };
  const pre = id => nodes[id].attrs?.tag === 'pre' ? id : kids(nodes[id]).map(pre).find(Boolean);
  const ticks = (text, minimum) => '`'.repeat(Math.max(minimum, ...(text.match(/`+/g) || []).map(s => s.length + 1)));
  function content(id, rich) {
    const n = nodes[id], attrs = n.attrs || {}, tag = attrs.tag, children = kids(n);
    if (!rich && n.role === 'button' && /\.(png|jpe?g|webp|gif|pdf|txt|csv|docx?)$/i.test(n.name)) return [`[Attachment: ${n.name}]`, ''];
    if (n.role === 'image') return [`[Image${n.name ? ': ' + n.name : ''}]`];
    if (['button','tool bar','statusbar'].includes(n.role) || n.class?.includes('sr-only') || tag === '::marker') return [];
    const contents = () => children.flatMap(c => content(c, rich));
    if (rich && n.role === 'panel' && n.name.endsWith(' code')) {
      const block = pre(id);
      if (block) { const text = raw(block), fence = ticks(text, 3), language = n.name.slice(0, -5);
        return [fence + (/^[\w+-]{1,30}$/.test(language) ? language : '') + '\n' + text + '\n' + fence, '']; }
    }
    if (rich && ['strong','b','em','i','code'].includes(tag)) {
      const text = raw(id), marker = ['strong','b'].includes(tag) ? '**' : ['em','i'].includes(tag) ? '*' : ticks(text, 1);
      return text ? [marker + text + marker] : [];
    }
    if (rich && n.role === 'heading') return ['#'.repeat(/^[1-6]$/.test(attrs.level) ? Number(attrs.level) : 2) + ' ' + raw(id), ''];
    if (rich && n.role === 'link' && /^https?:\/\//.test(n.uri || '')) return [`[${raw(id).replaceAll(']', '\\]')}](<${n.uri.replaceAll('>', '%3E')}>)`];
    if (rich && tag === 'blockquote') return [contents().join('\n').trim().split('\n').map(line => '> ' + line).join('\n'), ''];
    if (n.role === 'static' && !children.length) return [n.name];
    if (n.role === 'paragraph') { const text = contents().join(''); return text ? [text, ''] : []; }
    if (n.role === 'list item') {
      const text = contents().join('').trim().replace(/^[•◦▪]\s*/, '');
      const ordered = nodes[n.parent]?.attrs?.tag === 'ol';
      const position = /^\d+$/.test(attrs.posinset) ? attrs.posinset : '1';
      return [(ordered ? position + '. ' : '- ') + text];
    }
    return n.role === 'list' ? [...contents(), ''] : contents();
  }
  return messageBodies(nodes, order).flatMap(({role,bodies}) => {
    const text = bodies.flatMap(b => content(b, role === 'assistant')).join('\n').trim();
    return text ? [{role, text: [...text].slice(0, 60000).join('')}] : [];
  });
}

export function displayDate(label, now = new Date()) {
  if (typeof label !== 'string') return null;
  let date = new Date(now), unit;
  const relative = label.match(/^(\d+) (minute|hour|day|week)s? ago$/);
  if (relative) {
    unit = relative[2]; const amount = Number(relative[1]);
    if (!Number.isSafeInteger(amount)) return null;
    if (unit === 'minute') date.setMinutes(date.getMinutes() - amount);
    else if (unit === 'hour') date.setHours(date.getHours() - amount);
    else date.setDate(date.getDate() - amount * (unit === 'week' ? 7 : 1));
  } else if (['Just now','just now'].includes(label)) unit = 'minute';
  else if (['Today','Yesterday'].includes(label)) { unit = 'day'; if (label === 'Yesterday') date.setDate(date.getDate() - 1); }
  else {
    const match = label.match(/^([A-Za-z]+) (\d{1,2})(?:, (\d{4}))?$/);
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    if (!match) return null;
    const month = months.findIndex(m => m === match[1] || m.slice(0,3) === match[1]);
    if (month < 0) return null;
    date = new Date(Number(match[3] || now.getFullYear()), month, Number(match[2]));
    if (date.getMonth() !== month || date.getDate() !== Number(match[2])) return null;
    if (!match[3] && date > now) date.setFullYear(date.getFullYear() - 1);
    unit = 'day';
  }
  if (unit === 'minute') date.setSeconds(0,0);
  else if (unit === 'hour') date.setMinutes(0,0,0);
  else date.setHours(0,0,0,0);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace('.000Z','Z') : null;
}
