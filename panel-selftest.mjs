import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerSoulweavePanel, readOverride, applyOverride, PANEL_HEADER_NAME, PANEL_HEADER_VALUE } from './panel.js'

const dir = mkdtempSync(join(tmpdir(), 'sw-panel-'))
let route = null
const ctx = {
  webServer: { register: (r) => { route = r; return () => {} } },
  effect: (fn) => fn(),
}
const dispose = registerSoulweavePanel(ctx, console, {
  stateDir: dir,
  getEffective: () => ({ soulMaxTokens: 1000, totalMaxTokens: 1000, enforceBudget: false, pendingLimit: 3, recallLimit: 3, soulSplitInjection: true, hybridSearch: true }),
})
console.log('route path', route?.path, 'kind', route?.kind)

function invoke(method, body, { header = true } = {}) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = `/soulweave-panel/api/${method}`
    req.headers = header ? { [PANEL_HEADER_NAME]: PANEL_HEADER_VALUE } : {}
    const chunks = []
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }) },
    }
    route.handler(req, res)
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
}

console.log('state', JSON.stringify(await invoke('state')))
console.log('set', JSON.stringify(await invoke('set', { values: { soulMaxTokens: 1200, enforceBudget: true } })))
console.log('file exists', existsSync(join(dir, 'panel-override.json')))
console.log('override', JSON.stringify(readOverride(dir)))
console.log('merged', JSON.stringify(applyOverride({ soulMaxTokens: 1000, pendingLimit: 3 }, dir)))
console.log('bad', JSON.stringify(await invoke('set', { values: { soulMaxTokens: 99999 } })))
console.log('forbidden', JSON.stringify(await invoke('state', undefined, { header: false })))
console.log('reset', JSON.stringify(await invoke('reset')))
console.log('after reset', JSON.stringify(readOverride(dir)))
dispose()
