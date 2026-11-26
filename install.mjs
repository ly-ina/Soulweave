#!/usr/bin/env node
/**
 * Soulweave 一键安装器（不经过 npm registry）。
 *
 *   node install.mjs                 # 自动找 profile 装好
 *   node install.mjs --dry-run       # 只打印将要做的事，不写盘
 *   node install.mjs --profile web   # 指定 profile 名
 *
 * 做四件事：
 *   1. profile/package.json：dependencies 写 link:<本目录>，bundles 追加包名
 *   2. profile/node_modules/@ly-ina/dsh-soulweave：建 junction / symlink
 *   3. soul.example.md → soul.md（已存在则跳过，绝不覆盖）
 *   4. 打印重启与验证方法
 *
 * 不跑 npm，不联网，零依赖。
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const PKG_NAME = '@ly-ina/dsh-soulweave'
const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(`--${name}`)
const getArg = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const DRY = hasFlag('dry-run')
const log = (msg) => console.log(`${DRY ? '[dry-run] ' : ''}${msg}`)

if (hasFlag('help') || hasFlag('h')) {
  console.log(`用法：
  node install.mjs [--dry-run] [--profile <名字>]

  --dry-run          只打印，不写任何文件
  --profile <名字>   有多个 DSH profile 时指定装到哪个

安装位置就是本目录：${HERE}`)
  process.exit(0)
}

// ── 1. 找 DSH_HOME 与 profile ──────────────────────────────
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profilesDir = join(dshHome, 'profiles')
if (!existsSync(profilesDir)) {
  console.error(`找不到 ${profilesDir}\n先确认 DSH 装过、DSH_HOME 指对了。`)
  process.exit(1)
}

const candidates = []
for (const name of readdirSync(profilesDir)) {
  const file = join(profilesDir, name, 'package.json')
  if (!existsSync(file)) continue
  let pkg
  try { pkg = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
  if (Array.isArray(pkg?.dsh?.profile?.bundles)) candidates.push({ name, dir: join(profilesDir, name), file, pkg })
}

if (candidates.length === 0) {
  console.error('没有找到带 dsh.profile.bundles 的 profile。先让 DSH 建一个 profile 再装。')
  process.exit(1)
}

const wanted = getArg('profile')
let profile
if (wanted) {
  profile = candidates.find((c) => c.name === wanted)
  if (!profile) {
    console.error(`没有名为 ${wanted} 的 profile。可选：${candidates.map((c) => c.name).join(', ')}`)
    process.exit(1)
  }
} else if (candidates.length === 1) {
  profile = candidates[0]
} else {
  profile = candidates.find((c) => c.name === 'desktop') || candidates.find((c) => c.name === 'web')
  if (!profile) {
    console.error(`有多个 profile，用 --profile 指定：${candidates.map((c) => c.name).join(', ')}`)
    process.exit(1)
  }
}
log(`profile：${profile.name}（${profile.dir}）`)

// ── 2. 改 package.json ────────────────────────────────────
const pkg = profile.pkg
pkg.dependencies = pkg.dependencies || {}
const linkSpec = `link:${HERE.replace(/\\/g, '/')}`
const changes = []

if (pkg.dependencies[PKG_NAME] !== linkSpec) {
  changes.push(`dependencies["${PKG_NAME}"]: ${pkg.dependencies[PKG_NAME] ?? '(无)'} → ${linkSpec}`)
  pkg.dependencies[PKG_NAME] = linkSpec
}
if (!pkg.dsh.profile.bundles.includes(PKG_NAME)) {
  changes.push(`bundles: 追加 ${PKG_NAME}`)
  pkg.dsh.profile.bundles.push(PKG_NAME)
}

if (changes.length === 0) {
  log('package.json 已经是目标状态，不重复写。')
} else {
  for (const c of changes) log(c)
  if (!DRY) {
    const backup = `${profile.file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(profile.file, backup)
    writeFileSync(profile.file, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    log(`已备份：${backup}`)
  }
}

// ── 3. 建 node_modules 链接 ───────────────────────────────
const linkPath = join(profile.dir, 'node_modules', '@ly-ina', 'dsh-soulweave')
let linkState = 'missing'
if (existsSync(linkPath)) {
  try {
    linkState = realpathSync(linkPath).toLowerCase() === realpathSync(HERE).toLowerCase() ? 'ok' : 'wrong'
  } catch { linkState = 'broken' }
}

if (linkState === 'ok') {
  log(`链接已存在且指向本目录：${linkPath}`)
} else if (linkState === 'missing') {
  log(`建链接：${linkPath} → ${HERE}`)
  if (!DRY) {
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(HERE, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  }
} else {
  console.error(`链接已存在但指向别处（${linkState}）：${linkPath}\n先把旧的删掉再跑；本安装器不替你删。`)
  process.exit(1)
}

// ── 4. soul.md ───────────────────────────────────────────
const soulPath = join(HERE, 'soul.md')
const soulExample = join(HERE, 'soul.example.md')
if (existsSync(soulPath)) {
  log(`soul.md 已存在，保留不动：${soulPath}`)
} else if (existsSync(soulExample)) {
  log(`复制示例：${soulExample} → ${soulPath}`)
  if (!DRY) copyFileSync(soulExample, soulPath)
}

// ── 5. 收尾提示 ──────────────────────────────────────────
console.log(`
装好了。还差一步：让插件知道你的人格文件在哪。

在 ${join(profile.dir, 'cordis.patch.yml')} 里加（或合并进已有的 soulweave 节）：

- id: soulweave
  name: '${PKG_NAME}'
  config:
    soulPath: ${soulPath.replace(/\\/g, '/')}

config 是整体替换，不是深合并——要调别的参数就一次写全，参考包里的 cordis.patch.yml。

然后整进程重启 DSH（不是热重载），验证：
  - ${join(dshHome, 'soulweave', 'soul.log')} 重启后出现新的 inject 行
  - 工具列表里有 soul_recall / soul_remember

不想手动改配置？把上面这段贴给 DSH 里的 AI，让它帮你合进去。
`)