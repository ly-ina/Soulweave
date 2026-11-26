import * as sdk from '../sdk.mjs'
console.log('sdk 导出数:', Object.keys(sdk).length)
console.log('parseDue:', JSON.stringify(sdk.parseDue('2026-12-01'))?.slice(0, 60))
console.log('anchorOf:', typeof sdk.anchorOf)
