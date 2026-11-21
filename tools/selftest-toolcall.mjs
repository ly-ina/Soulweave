import { pickLastToolCall } from '../core/toolcall.mjs'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++ } else { fail++; console.log('FAIL', name) } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

ok('array form', eq(pickLastToolCall([
  { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool-call', name: 'ps', input: { script: 'x' } }] },
]), { tool: 'ps', input: { script: 'x' }, path: '' }))

ok('path picked', eq(pickLastToolCall([
  { role: 'assistant', content: [{ type: 'tool-call', name: 'write', input: { path: 'a.md', content: 'y' } }] },
]).path, 'a.md'))

ok('file_path picked', eq(pickLastToolCall([
  { role: 'assistant', content: [{ type: 'tool_use', name: 'read', input: { file_path: 'b.mjs' } }] },
]).path, 'b.mjs'))

ok('array path list', eq(pickLastToolCall([
  { role: 'assistant', content: [{ type: 'tool-call', name: 'read', input: { path: ['c.js', 'd.js'] } }] },
]).path, 'c.js'))

ok('string form', eq(pickLastToolCall([
  { role: 'assistant', content: '{"role":"assistant","contentType":"tool-call","toolName":"ops_grep","args":{"pattern":"x"}}' },
]), { tool: 'ops_grep', input: { pattern: 'x' }, path: '' }))

ok('latest wins', eq(pickLastToolCall([
  { role: 'assistant', content: [{ type: 'tool-call', name: 'first' }] },
  { role: 'user', content: 'do it' },
  { role: 'assistant', content: [{ type: 'tool-call', name: 'second' }] },
]).tool, 'second'))

ok('skip soul messages', eq(pickLastToolCall([
  { role: 'assistant', content: [{ type: 'tool-call', name: 'real' }] },
  { role: 'assistant', source: { kind: 'soul-recall' }, content: [{ type: 'tool-call', name: 'fake' }] },
]).tool, 'real'))

ok('no tool', eq(pickLastToolCall([{ role: 'user', content: 'hello' }]), null))
ok('null input', eq(pickLastToolCall(null), null))
ok('empty', eq(pickLastToolCall([]), null))
ok('bad json', eq(pickLastToolCall([{ role: 'assistant', content: '{oops' }]), null))
ok('tool only', eq(pickLastToolCall([{ role: 'assistant', content: [{ type: 'tool-call', name: 'x' }] }]), { tool: 'x', input: null, path: '' }))

ok('event form', eq(pickLastToolCall(null, [
  { type: 'tool/call', data: { name: 'ps', arguments: '{"script":"x"}' } },
]), { tool: 'ps', input: { script: 'x' }, path: '' }))

ok('event path', eq(pickLastToolCall(null, [
  { type: 'tool/call', data: { name: 'write', arguments: '{"path":"a.md","content":"y"}' } },
]).path, 'a.md'))

ok('event beats messages', eq(pickLastToolCall(
  [{ role: 'assistant', content: [{ type: 'tool-call', name: 'old' }] }],
  [{ type: 'tool/call', data: { name: 'new', arguments: '{}' } }],
).tool, 'new'))

ok('event bad args', eq(pickLastToolCall(null, [
  { type: 'tool/call', data: { name: 'ps', arguments: 'not-json' } },
]), { tool: 'ps', input: null, path: '' }))
console.log(`PASS ${pass}/${pass + fail}`)
process.exit(fail ? 1 : 0)
