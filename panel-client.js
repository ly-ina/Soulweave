// Soulweave 设置面板（client 半）。
// 宿主把这里当浏览器模块加载，通过 window.__ModuleLoader__ 注入 require。
// 文案直接写中文：这是本机私有插件，不跟 locale 走。
window.__ModuleLoader__.load({
  id: '@ly-ina/dsh-soulweave',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const PANEL_ID = 'soulweave'
    const ICON_SLOT = 'sidebar.panellist'
    const MAIN_SLOT = 'main'
    const ROUTE = '/soulweave-panel/api'
    const HEADER = 'x-dsh-soulweave-panel'
    const HEADER_VALUE = 'sw-panel-1'
    const CSS_ATTR = 'data-dsh-soulweave-css'

    const CSS = `
.swp-root { display: flex; flex-direction: column; gap: 14px; padding: 14px; overflow: auto; height: 100%; }
.swp-head { display: flex; align-items: baseline; gap: 8px; }
.swp-title { font-size: 15px; font-weight: 600; }
.swp-file { font-size: 11px; opacity: .55; word-break: break-all; }
.swp-row { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px solid rgba(127,127,127,.22); border-radius: 8px; }
.swp-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.swp-label { font-size: 13px; font-weight: 500; }
.swp-key { font-size: 11px; opacity: .5; font-family: ui-monospace, monospace; }
.swp-help { font-size: 11px; opacity: .6; line-height: 1.5; }
.swp-input { width: 110px; padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; font: inherit; }
.swp-switch { width: 18px; height: 18px; accent-color: #6b8afd; }
.swp-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.swp-btn { padding: 6px 12px; border-radius: 7px; border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.swp-btn[disabled] { opacity: .45; cursor: default; }
.swp-btn.primary { background: #6b8afd; border-color: #6b8afd; color: #fff; }
.swp-msg { font-size: 12px; padding: 8px 10px; border-radius: 7px; }
.swp-msg.ok { background: rgba(63,185,80,.14); }
.swp-msg.err { background: rgba(248,81,73,.14); }
`

    function ensureStyle() {
      if (document.querySelector(`style[${CSS_ATTR}]`)) return
      const style = document.createElement('style')
      style.setAttribute(CSS_ATTR, '1')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function removeStyle() {
      document.querySelector(`style[${CSS_ATTR}]`)?.remove()
    }

    async function call(method, body) {
      try {
        const response = await fetch(`${ROUTE}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [HEADER]: HEADER_VALUE },
          body: JSON.stringify(body ?? {}),
        })
        const payload = await response.json().catch(() => null)
        if (payload?.ok === true) return { ok: true, value: payload.value }
        return { ok: false, error: payload?.error?.message ?? `HTTP ${response.status}` }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    }

    function SoulWeaveIcon({ size = 16, active = false } = {}) {
      const stroke = active ? '#6b8afd' : 'currentColor'
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke, strokeWidth: 1.4, strokeLinecap: 'round' },
        h('path', { d: 'M8 1.6c-2.2 1.6-2.2 3.2 0 4.8s2.2 3.2 0 4.8-2.2 3.2 0 4.8' }),
        h('path', { d: 'M8 1.6c2.2 1.6 2.2 3.2 0 4.8s-2.2 3.2 0 4.8 2.2 3.2 0 4.8', opacity: 0.55 }),
      )
    }

    function SoulWeavePanel() {
      const [items, setItems] = useState([])
      const [draft, setDraft] = useState({})
      const [file, setFile] = useState('')
      const [msg, setMsg] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        setBusy(true)
        const result = await call('state')
        setBusy(false)
        if (!result.ok) {
          setMsg({ kind: 'err', text: result.error })
          return
        }
        const list = result.value?.items ?? []
        setItems(list)
        setFile(result.value?.file ?? '')
        const next = {}
        for (const item of list) next[item.key] = item.value
        setDraft(next)
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const save = useCallback(async () => {
        setBusy(true)
        const result = await call('set', { values: draft })
        setBusy(false)
        if (!result.ok) {
          setMsg({ kind: 'err', text: result.error })
          return
        }
        setMsg({ kind: 'ok', text: '已写入覆盖文件。重启 DSH 后生效。' })
      }, [draft])

      const reset = useCallback(async () => {
        setBusy(true)
        const result = await call('reset')
        setBusy(false)
        if (!result.ok) {
          setMsg({ kind: 'err', text: result.error })
          return
        }
        setMsg({ kind: 'ok', text: '覆盖已清空，重启后回到 profile 配置。' })
        await load()
      }, [load])

      const rows = items.map((item) => {
        const value = draft[item.key]
        const onChange = (event) => {
          const next = item.type === 'bool' ? event.target.checked : Number(event.target.value)
          setDraft((current) => ({ ...current, [item.key]: next }))
        }
        return h(
          'div',
          { className: 'swp-row', key: item.key },
          h(
            'div',
            { className: 'swp-line' },
            h('span', { className: 'swp-label' }, item.label),
            item.type === 'bool'
              ? h('input', { className: 'swp-switch', type: 'checkbox', checked: value === true, onChange })
              : h('input', {
                  className: 'swp-input',
                  type: 'number',
                  min: item.min,
                  max: item.max,
                  value: value ?? '',
                  onChange,
                }),
          ),
          h('span', { className: 'swp-key' }, item.key),
          item.help ? h('span', { className: 'swp-help' }, item.help) : null,
        )
      })

      return h(
        'div',
        { className: 'swp-root' },
        h(
          'div',
          { className: 'swp-head' },
          h('span', { className: 'swp-title' }, '魂织设置'),
          file ? h('span', { className: 'swp-file' }, file) : null,
        ),
        msg ? h('div', { className: `swp-msg ${msg.kind}` }, msg.text) : null,
        ...rows,
        h(
          'div',
          { className: 'swp-actions' },
          h('button', { className: 'swp-btn primary', disabled: busy, onClick: save }, '保存'),
          h('button', { className: 'swp-btn', disabled: busy, onClick: reset }, '恢复 profile'),
          h('button', { className: 'swp-btn', disabled: busy, onClick: load }, '重新读取'),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyle()
        const cleanups = [
          ctx.slots.inject(ICON_SLOT, () =>
            ctx.slots.register(
              {
                name: ICON_SLOT,
                id: PANEL_ID,
                order: 41,
                label: () => '魂织',
              },
              SoulWeaveIcon,
            ),
          ),
          ctx.slots.inject(MAIN_SLOT, () =>
            ctx.slots.register({ name: MAIN_SLOT, key: PANEL_ID }, SoulWeavePanel),
          ),
        ]
        ctx.effect(
          () => () => {
            for (const cleanup of cleanups.reverse()) {
              try {
                cleanup()
              } catch {
                /* 卸载路径上不抛 */
              }
            }
            cleanups.length = 0
            removeStyle()
          },
          'dsh-soulweave:client',
        )
      },
    }
  },
})
