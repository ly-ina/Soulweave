/**
 * storage/node-sqlite.mjs —— 把 node:sqlite 驱动注册进存储层。
 *
 * 1.0 起 storage/index.mjs 不再自带默认驱动（那样会把 node:sqlite 带进 SDK 面）。
 * Node 下用这一行装配：
 *   import 'soulweave/storage-node-sqlite'
 * 插件入口 index.js 已经 import 了它，DSH 里无需额外操作。
 */
import { configureStorage } from './index.mjs'
import { sqliteDriver } from './driver.mjs'

configureStorage(sqliteDriver)
