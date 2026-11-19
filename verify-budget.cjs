const fs = require('fs');
const src = fs.readFileSync('<workspace>/plugins/dsh-soulweave/index.js', 'utf8');
const orderRaw = /export const YIELD_ORDER = Object\.freeze\(\[([^\]]*)\]\)/.exec(src)[1];
const YIELD_ORDER = orderRaw.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
const fnSrc = /export function planBudget\([\s\S]*?\n}\n/.exec(src)[0].replace('export function', 'function');
const planBudget = new Function('YIELD_ORDER', 'TOTAL_TOKENS', fnSrc + '; return planBudget;')(YIELD_ORDER, 950);

const cases = [];
function check(name, cond, detail) { cases.push({ name, ok: !!cond, detail }); }

check('YIELD_ORDER 顺序正确', YIELD_ORDER.join(',') === 'archive,partition,soul-recall', YIELD_ORDER.join(','));

let p = planBudget({ total: 900, perClass: { soul: 700, partition: 100, archive: 100, time: 0, 'soul-recall': 0 } }, 950);
check('不超时不砍', p.cut.length === 0 && p.ok && p.after === 900, JSON.stringify(p));

p = planBudget({ total: 1000, perClass: { soul: 700, partition: 100, archive: 200, time: 0, 'soul-recall': 0 } }, 950);
check('超 50 先砍封存目录', p.cut.join(',') === 'archive' && p.ok && p.after === 800, JSON.stringify(p));

p = planBudget({ total: 1100, perClass: { soul: 700, partition: 100, archive: 50, time: 0, 'soul-recall': 250 } }, 950);
check('封存不够再砍分区', p.cut.join(',') === 'archive,partition' && p.ok && p.after === 950, JSON.stringify(p));

p = planBudget({ total: 1400, perClass: { soul: 700, partition: 100, archive: 50, time: 0, 'soul-recall': 550 } }, 950);
check('前两档不够才砍召回', p.cut.join(',') === 'archive,partition,soul-recall' && p.ok && p.after === 700, JSON.stringify(p));

p = planBudget({ total: 2000, perClass: { soul: 1500, partition: 100, archive: 50, time: 300, 'soul-recall': 50 } }, 950);
check('魂引/时间永不砍，砍完仍超则 ok=false', p.cut.join(',') === 'archive,partition,soul-recall' && p.ok === false && p.after === 1800 && p.over === 850, JSON.stringify(p));

p = planBudget({ total: 950, perClass: { soul: 700, partition: 250, archive: 0, time: 0, 'soul-recall': 0 } }, 950);
check('恰好等于上限不砍', p.cut.length === 0 && p.ok, JSON.stringify(p));

for (const c of cases) console.log((c.ok ? 'PASS' : 'FAIL') + '  ' + c.name + '  ' + c.detail);
const bad = cases.filter((c) => !c.ok).length;
console.log('---');
console.log('passed=' + (cases.length - bad) + '/' + cases.length);
process.exit(bad ? 1 : 0);