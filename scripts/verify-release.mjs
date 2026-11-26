#!/usr/bin/env node
// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * 发布前自检（交办单 §2/§3）：只读仓库、不联网、不改任何文件。
 *
 * 复跑：node scripts/verify-release.mjs
 * 期望：每条以 PASS 开头，最后一行 ALL PASS。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fail = []
const pass = (label, detail) => console.log(`PASS ${label}  ${detail}`)
const check = (label, ok, detail) => {
  if (!ok) fail.push(label)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}  ${detail}`)
}
const skips = []
const skip = (label, detail) => {
  skips.push(label)
  console.log(`SKIP ${label}  ${detail}`)
}
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

// 1) 隐私扫描：运行时代码 + 测试文件里不得出现本机路径 / 交办方目录名
// 本脚本自身要写这些字面量来扫它们，扫描时跳过自己（单子 §2 允许的例外）。
const SCAN_SELF = 'scripts/verify-release.mjs'
// 变更日志是历史记录，里面出现过的本机路径是当时的事，不是现行泄露。
const HISTORY_FILES = new Set(['CHANGELOG.md'])
// 只扫本机绝对路径与私有目录名；人格样例里的人名（蓝汐/伊纳）是产品语义，不算泄露。
const PRIVATE = /E:[\\/]dsh_work|C:[\\/]Users[\\/]Lenovo|(^|[^a-z])lanxi([^a-z]|$)/
const files = git('ls-files').split('\n').filter(Boolean)
const hits = []
for (const file of files) {
  if (file === SCAN_SELF || HISTORY_FILES.has(file)) continue
  if (!/\.(m?js|json|md|ya?ml)$/.test(file)) continue
  const text = readFileSync(join(ROOT, file), 'utf8')
  text.split('\n').forEach((line, i) => {
    if (PRIVATE.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 80)}`)
  })
}
check('R5 隐私扫描', hits.length === 0, hits.length === 0 ? `${files.length} 个跟踪文件，0 命中` : `\n${hits.join('\n')}`)

// 2) 仓库里不得有个人数据/运行产物
// memory/ 是分层里的一层源码，不能整体拦；只拦真正的个人数据产物。
const FORBIDDEN = [/^soul\.md$/, /\/(soul-memory|memory)\.(db|sqlite3?)$/, /\.log$/, /\.db$/, /^state\//, /^\.state\//, /^index\.jsonl$/]
const bad = files.filter((file) => FORBIDDEN.some((re) => re.test(file)))
check('R6 无个人数据入仓', bad.length === 0, bad.length === 0 ? `git ls-files ${files.length} 项，无 soul.md/memory/state/log/db` : bad.join(', '))

// 3) 示例人格与交办方 soul.md 段落 0 重合
const paragraphs = (text) =>
  text
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .filter((block) => block.length >= 8 && !/^#+\s/.test(block))
const example = paragraphs(readFileSync(join(ROOT, 'soul.example.md'), 'utf8'))
const privateSoulPath = process.env.SOULWEAVE_PRIVATE_SOUL ?? ''
if (privateSoulPath && existsSync(privateSoulPath)) {
  const mine = new Set(paragraphs(readFileSync(privateSoulPath, 'utf8')))
  const overlap = example.filter((block) => mine.has(block))
  check('R7 示例无私人内容', overlap.length === 0, `示例 ${example.length} 段 vs 私人 soul.md，重合 ${overlap.length} 段`)
} else {
  skip('R7 示例无私人内容', '未提供 SOULWEAVE_PRIVATE_SOUL（私人 soul.md 路径）——本机验收时再跑')
}

// 3.5) 署名完整性：每个跟踪的源文件头三行内必须有版权行（删署名要动 85 个文件）
const stamped = []
for (const file of files) {
  if (!/\.(m?js)$/.test(file)) continue
  const head = readFileSync(join(ROOT, file), 'utf8').split('\n', 3).join('\n')
  if (!head.includes('Soulweave · ©')) stamped.push(file)
}
check('R9 署名完整', stamped.length === 0, stamped.length === 0 ? `${files.filter((f) => /\.(m?js)$/.test(f)).length} 个源文件全部带版权头` : `缺：${stamped.join(', ')}`)
// 4) README 三节 + 权限边界三条
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
check('R8-安装段', readme.includes('## 30 秒跑起来'), '「## 30 秒跑起来」')
check('R8-配置段', readme.includes('## 配置'), '「## 配置」')
check('R8-权限边界', readme.includes('## 权限边界'), '「## 权限边界」')
for (const key of ['soul_surface', 'soul_persist', 'builtin']) {
  check(`R8-边界条目 ${key}`, readme.includes(key), key)
}

// 5) package.json 元数据与 files 白名单
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
check('包名', pkg.name === '@ly-ina/dsh-soulweave', pkg.name)
check('版本', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version)
check('license 专有', pkg.license === 'SEE LICENSE IN LICENSE', String(pkg.license))
check('repository', Boolean(pkg.repository?.url), String(pkg.repository?.url))
const missing = (pkg.files ?? []).filter((file) => !existsSync(join(ROOT, file)))
check('files 白名单存在性', Array.isArray(pkg.files) && missing.length === 0, missing.length === 0 ? `${pkg.files.length} 项全部存在` : `缺：${missing.join(', ')}`)

// 6) LICENSE
const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8')
check('LICENSE 专有 + ly-ina', license.includes('proprietary') && license.includes('ly-ina'), `LICENSE ${statSync(join(ROOT, 'LICENSE')).size} 字节`)
check('LICENSE-MIT 留档', existsSync(join(ROOT, 'LICENSE-MIT')), 'LICENSE-MIT')

console.log(fail.length === 0 ? 'ALL PASS' : `FAILED: ${fail.join(' / ')}`)
process.exit(fail.length === 0 ? 0 : 1)
