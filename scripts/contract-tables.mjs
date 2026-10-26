#!/usr/bin/env node
// Prints the envelope + route contract as markdown tables, for pasting
// into docs/ABSTRACT_AGENT_PROTOCOL.md §"Contract summary". The source
// of truth is proxy/parley/contract/*.ts; this keeps the doc honest.
//   node --experimental-strip-types scripts/contract-tables.mjs
import { UPSTREAM_ENVELOPE_TYPES, PROXY_ENVELOPE_TYPES } from '../proxy/parley/contract/envelopes.ts';
import { UPSTREAM_ROUTES } from '../proxy/parley/contract/routes.ts';

const out = [];
out.push('### Stream envelope types', '');
out.push('| Type | Origin |', '|---|---|');
for (const t of UPSTREAM_ENVELOPE_TYPES) out.push(`| \`${t}\` | upstream agent |`);
for (const t of PROXY_ENVELOPE_TYPES) out.push(`| \`${t}\` | proxy (never crosses the upstream boundary) |`);
out.push('', '### Upstream routes', '');
out.push('| Family | Routes | Support | If absent | Spec |', '|---|---|---|---|---|');
for (const f of UPSTREAM_ROUTES) {
  out.push(`| ${f.family} | ${f.routes.map((r) => `\`${r}\``).join('<br>')} | ${f.support} | ${f.degrade} | ${f.doc} |`);
}
console.log(out.join('\n'));
