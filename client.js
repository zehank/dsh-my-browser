/**
 * my-browser / client —— 侧边栏「浏览器+」tab。
 *
 * 与内置浏览器（@deepseek-ai/dsh-client-ui-sidebar-browser）共用同一套
 * Electron guest 机制：window.dshDesktop.browser.acquire() 申请租约 →
 * <webview partition=… src="about:blank#<lease>"> → dom-ready 之后才 loadURL。
 * 区别在于这一份自己管数据：收藏夹、历史、密码库都在 localStorage 里，
 * 并且在每次 dom-ready 后往页面里注入一段填表脚本。
 *
 * 不 import 任何 @deepseek-ai/*（装不进 profile）；只用框架注入的
 * slots / sidebarRightTabs 两个服务，和页面上的 window.dshDesktop。
 */
window.__ModuleLoader__.load({
  id: '@local/my-browser',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const TYPE_ID = '@local/my-browser'
    const TYPE_KIND = 'mybrowser'
    const STORE_KEY = 'dsh.my-browser.v1'
    const MAX_HISTORY = 1500

    // 全部走主题 token，跟随明暗色
    const C = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      dim2: 'var(--dsw-alias-label-tertiary)',
      bg: 'var(--dsw-alias-bg-base)',
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      border: 'var(--dsw-alias-border-l2)',
      border3: 'var(--dsw-alias-border-l3)',
      accent: 'var(--dsw-alias-brand-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
    }

    // ───────────────────────────── 存储 ─────────────────────────────
    function emptyStore() {
      return { bookmarks: [], history: [], creds: [], autofill: true }
    }

    function loadStore() {
      try {
        const raw = localStorage.getItem(STORE_KEY)
        if (!raw) return emptyStore()
        const parsed = JSON.parse(raw)
        return {
          bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
          history: Array.isArray(parsed.history) ? parsed.history : [],
          creds: Array.isArray(parsed.creds) ? parsed.creds : [],
          autofill: parsed.autofill !== false,
        }
      } catch {
        return emptyStore()
      }
    }

    function saveStore(next) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next))
      } catch {
        /* 配额满了就只留在内存里 */
      }
    }

    // ───────────────────────────── 导入解析 ─────────────────────────────
    /** Edge/Chrome 导出的收藏夹 HTML（Netscape bookmarks）。 */
    function parseBookmarksHtml(text) {
      const doc = new DOMParser().parseFromString(text, 'text/html')
      const out = []
      const seen = new Set()
      for (const a of doc.querySelectorAll('a[href]')) {
        const url = (a.getAttribute('href') || '').trim()
        if (!/^https?:\/\//i.test(url)) continue
        if (seen.has(url)) continue
        seen.add(url)
        out.push({ title: (a.textContent || url).trim(), url, added: Date.now() })
      }
      return out
    }

    /** Edge 导出的密码 CSV：name,url,username,password,note（允许引号内逗号）。 */
    function parseCsv(text) {
      const rows = []
      let row = []
      let field = ''
      let quoted = false
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i]
        if (quoted) {
          if (ch === '"') {
            if (text[i + 1] === '"') {
              field += '"'
              i += 1
            } else quoted = false
          } else field += ch
        } else if (ch === '"') quoted = true
        else if (ch === ',') {
          row.push(field)
          field = ''
        } else if (ch === '\n') {
          row.push(field)
          rows.push(row)
          row = []
          field = ''
        } else if (ch !== '\r') field += ch
      }
      if (field.length > 0 || row.length > 0) {
        row.push(field)
        rows.push(row)
      }
      return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
    }

    function hostOf(url) {
      try {
        const u = new URL(url)
        return u.hostname.toLowerCase()
      } catch {
        const m = /^(?:[a-z]+:\/\/)?([^/?#]+)/i.exec(String(url || ''))
        return m ? m[1].toLowerCase() : ''
      }
    }

    function parsePasswordsCsv(text) {
      const rows = parseCsv(text)
      if (rows.length === 0) return []
      const header = rows[0].map((c) => c.trim().toLowerCase())
      const idx = (name) => header.indexOf(name)
      const hasHeader = idx('password') >= 0
      const cUrl = hasHeader ? idx('url') : 1
      const cUser = hasHeader ? idx('username') : 2
      const cPass = hasHeader ? idx('password') : 3
      const cName = hasHeader ? idx('name') : 0
      const out = []
      for (const r of rows.slice(hasHeader ? 1 : 0)) {
        const password = (r[cPass] || '').trim()
        const url = (r[cUrl] || '').trim()
        if (!password || !url) continue
        out.push({
          name: (r[cName] || '').trim() || hostOf(url),
          url,
          host: hostOf(url),
          username: (r[cUser] || '').trim(),
          password,
        })
      }
      return out
    }

    // ───────────────────────────── 页面内填表 ─────────────────────────────
    /** 在 guest 页面里执行：按 host 匹配密码库，填账号 + 密码。返回填了几个。 */
    function pageFill(creds) {
      try {
        const host = (location.hostname || '').toLowerCase()
        if (!host) return 0
        let best = null
        let bestLen = -1
        for (let i = 0; i < creds.length; i += 1) {
          const c = creds[i]
          if (!c.host) continue
          const ch = c.host
          const hit = host === ch || host.endsWith('.' + ch) || ch.endsWith('.' + host)
          if (hit && ch.length > bestLen) {
            best = c
            bestLen = ch.length
          }
        }
        if (!best) return 0
        const pw = document.querySelector('input[type="password"]')
        if (!pw) return 0
        if (pw.value) return 0
        const form = pw.form || document
        const inputs = form.querySelectorAll('input')
        let user = null
        for (let j = 0; j < inputs.length; j += 1) {
          const inp = inputs[j]
          if (inp === pw) break
          const t = (inp.getAttribute('type') || 'text').toLowerCase()
          if (t === 'text' || t === 'email' || t === 'tel') user = inp
        }
        const set = (el, value) => {
          if (!el || !value) return
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          const desc = Object.getOwnPropertyDescriptor(proto, 'value')
          if (desc && desc.set) desc.set.call(el, value)
          else el.value = value
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }
        set(user, best.username)
        set(pw, best.password)
        return 1
      } catch {
        return 0
      }
    }

    function fillCode(creds) {
      const payload = creds.map((c) => ({ host: c.host, username: c.username, password: c.password }))
      return '(' + pageFill.toString() + ')(' + JSON.stringify(payload) + ')'
    }

    // ───────────────────────────── 样式 ─────────────────────────────
    const S = {
      root: {
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: C.bg,
        color: C.text,
        font: 'var(--dsw-font-xxs-12)',
      },
      bar: {
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '5px 6px',
        borderBottom: `0.5px solid ${C.border3}`,
        flex: 'none',
      },
      iconBtn: {
        width: 26,
        height: 26,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 0,
        borderRadius: 6,
        background: 'transparent',
        color: C.dim,
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: 1,
      },
      address: {
        flex: 'auto',
        minWidth: 0,
        height: 26,
        padding: '0 8px',
        border: `0.5px solid ${C.border}`,
        borderRadius: 6,
        background: C.bg1,
        color: C.text,
        font: 'inherit',
        outline: 'none',
      },
      body: { position: 'relative', flex: 'auto', minHeight: 0, display: 'flex' },
      viewport: { position: 'absolute', inset: 0 },
      aside: {
        flex: 'none',
        width: 250,
        borderRight: `0.5px solid ${C.border3}`,
        background: C.bg1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      },
      asideHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 10px',
        borderBottom: `0.5px solid ${C.border3}`,
        flex: 'none',
      },
      asideTitle: { fontWeight: 600, flex: 'auto' },
      asideBody: { overflow: 'auto', flex: 'auto', padding: '4px 0' },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        cursor: 'pointer',
        border: 0,
        background: 'transparent',
        color: 'inherit',
        textAlign: 'left',
        width: '100%',
        font: 'inherit',
        overflow: 'hidden',
      },
      rowTitle: { flex: 'auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rowMeta: { flex: 'none', color: C.dim2, fontSize: 10 },
      small: {
        height: 24,
        padding: '0 8px',
        borderRadius: 5,
        border: `0.5px solid ${C.border}`,
        background: C.bg2,
        color: C.text,
        font: 'inherit',
        cursor: 'pointer',
        flex: 'none',
      },
      hint: { padding: '10px 12px', color: C.dim, lineHeight: 1.6 },
      start: {
        position: 'absolute',
        inset: 0,
        overflow: 'auto',
        padding: '18px 16px',
        background: C.bg,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      },
      startTitle: { fontWeight: 600, fontSize: 13 },
      grid: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      chip: {
        maxWidth: 200,
        padding: '6px 10px',
        borderRadius: 7,
        border: `0.5px solid ${C.border}`,
        background: C.bg1,
        color: C.text,
        cursor: 'pointer',
        font: 'inherit',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
    }

    function iconBtn(label, title, onClick, disabled) {
      return h('button', {
        type: 'button',
        title,
        'aria-label': title,
        disabled: !!disabled,
        onClick,
        style: { ...S.iconBtn, opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer' },
      }, label)
    }

    function hostLabel(url) {
      try {
        const u = new URL(url)
        return u.host + (u.pathname !== '/' ? u.pathname : '')
      } catch {
        return url
      }
    }

    function when(ts) {
      const d = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    // ───────────────────────────── 组件 ─────────────────────────────
    function BrowserPane() {
      const [store, setStore] = useState(loadStore)
      const [panel, setPanel] = useState(null)
      const [url, setUrl] = useState('')
      const [address, setAddress] = useState('')
      const [title, setTitle] = useState('')
      const [loading, setLoading] = useState(false)
      const [canBack, setCanBack] = useState(false)
      const [canForward, setCanForward] = useState(false)
      const [status, setStatus] = useState('boot')
      const [notice, setNotice] = useState('')

      const storeRef = useRef(store)
      storeRef.current = store

      const viewportRef = useRef(null)
      const viewRef = useRef(null)
      const leaseRef = useRef('')
      const firstReadyRef = useRef(true)
      const lastNavRef = useRef({ url: '', at: 0 })
      const bmInputRef = useRef(null)
      const pwInputRef = useRef(null)

      const commit = useCallback((patch) => {
        setStore((prev) => {
          const next = { ...prev, ...patch }
          saveStore(next)
          return next
        })
      }, [])

      const pushHistory = useCallback((nextUrl, nextTitle) => {
        if (!/^https?:\/\//i.test(nextUrl || '')) return
        const now = Date.now()
        const last = lastNavRef.current
        if (last.url === nextUrl && now - last.at < 1500) return
        lastNavRef.current = { url: nextUrl, at: now }
        setStore((prev) => {
          const entry = { url: nextUrl, title: nextTitle || '', time: now }
          const next = { ...prev, history: [entry, ...prev.history].slice(0, MAX_HISTORY) }
          saveStore(next)
          return next
        })
      }, [])

      const runAutofill = useCallback(async () => {
        const view = viewRef.current
        if (!view) return 0
        const s = storeRef.current
        if (!s.autofill || s.creds.length === 0) return 0
        try {
          const filled = await view.executeJavaScript(fillCode(s.creds))
          return typeof filled === 'number' ? filled : 0
        } catch {
          return 0
        }
      }, [])

      // 申请租约 + 建 webview
      useEffect(() => {
        let disposed = false
        const bridge = window.dshDesktop && window.dshDesktop.browser
        if (!bridge || !viewportRef.current) {
          setStatus('unsupported')
          return undefined
        }
        ;(async () => {
          try {
            const reservation = await bridge.acquire('my-browser')
            if (disposed) {
              bridge.release(reservation.lease).catch(() => {})
              return
            }
            leaseRef.current = reservation.lease
            const view = document.createElement('webview')
            view.setAttribute('name', reservation.lease)
            view.setAttribute('partition', reservation.partition)
            view.setAttribute('allowpopups', '')
            view.setAttribute('src', 'about:blank#' + reservation.lease)
            view.dataset.sidebarBrowserFrame = 'webview'
            view.style.cssText = 'display:flex;width:100%;height:100%;background:#fff'

            const syncNav = () => {
              try {
                setCanBack(view.canGoBack())
                setCanForward(view.canGoForward())
              } catch {
                /* 未就绪 */
              }
            }

            view.addEventListener('dom-ready', () => {
              setLoading(false)
              syncNav()
              if (firstReadyRef.current) {
                firstReadyRef.current = false
                return
              }
              runAutofill()
            })
            view.addEventListener('did-start-loading', () => setLoading(true))
            view.addEventListener('did-stop-loading', () => {
              setLoading(false)
              syncNav()
            })
            view.addEventListener('did-navigate', (event) => {
              const next = event.url || ''
              setUrl(next)
              setAddress(next)
              syncNav()
              if (next && !next.startsWith('about:')) pushHistory(next, '')
            })
            view.addEventListener('did-navigate-in-page', (event) => {
              if (!event.isMainFrame) return
              setUrl(event.url || '')
              setAddress(event.url || '')
              syncNav()
            })
            view.addEventListener('page-title-updated', (event) => {
              const nextTitle = event.title || ''
              setTitle(nextTitle)
              setUrl((current) => {
                if (/^https?:\/\//i.test(current)) {
                  setStore((prev) => {
                    const idx = prev.history.findIndex((e) => e.url === current && !e.title)
                    if (idx < 0) return prev
                    const history = prev.history.slice()
                    history[idx] = { ...history[idx], title: nextTitle }
                    const next = { ...prev, history }
                    saveStore(next)
                    return next
                  })
                }
                return current
              })
            })
            view.addEventListener('did-fail-load', (event) => {
              if (event.errorCode === -3) return // 用户中断
              setStatus('ready')
              setNotice(`加载失败 (${event.errorCode}): ${event.errorDescription || ''}`)
            })

            viewportRef.current.append(view)
            viewRef.current = view
            setStatus('ready')
          } catch (error) {
            setStatus('error')
            setNotice(error && error.message ? String(error.message) : '无法创建浏览器')
          }
        })()
        return () => {
          disposed = true
          const view = viewRef.current
          viewRef.current = null
          if (view) view.remove()
          const lease = leaseRef.current
          leaseRef.current = ''
          if (lease && bridge) bridge.release(lease).catch(() => {})
        }
      }, [pushHistory, runAutofill])

      const navigate = useCallback((raw) => {
        const view = viewRef.current
        if (!view) return
        let target = String(raw || '').trim()
        if (!target) return
        if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) target = 'https://' + target
        if (!/^https?:\/\//i.test(target)) {
          setNotice('只接受 http(s) 地址')
          return
        }
        setNotice('')
        setAddress(target)
        view.loadURL(target).catch(() => {})
      }, [])

      const importBookmarks = useCallback(async (file) => {
        if (!file) return
        const text = await file.text()
        const found = parseBookmarksHtml(text)
        setStore((prev) => {
          const seen = new Set(prev.bookmarks.map((b) => b.url))
          const merged = prev.bookmarks.concat(found.filter((b) => !seen.has(b.url)))
          const next = { ...prev, bookmarks: merged }
          saveStore(next)
          return next
        })
        setNotice(`导入收藏 ${found.length} 条`)
        setPanel('bookmarks')
      }, [])

      const importPasswords = useCallback(async (file) => {
        if (!file) return
        const text = await file.text()
        const found = parsePasswordsCsv(text)
        setStore((prev) => {
          const map = new Map(prev.creds.map((c) => [c.host + '\u0000' + c.username, c]))
          for (const c of found) map.set(c.host + '\u0000' + c.username, c)
          const next = { ...prev, creds: Array.from(map.values()) }
          saveStore(next)
          return next
        })
        setNotice(`导入密码 ${found.length} 条`)
        setPanel('passwords')
      }, [])

      const panelList = () => {
        if (panel === 'bookmarks') {
          if (store.bookmarks.length === 0) {
            return h('div', { style: S.hint }, '还没有收藏。点上面的「导入收藏夹」，选 Edge 导出的 .html 文件。')
          }
          return store.bookmarks.map((b) => h('button', {
            key: b.url,
            type: 'button',
            style: S.row,
            title: b.url,
            onClick: () => navigate(b.url),
          }, h('span', { style: S.rowTitle }, b.title || b.url)))
        }
        if (panel === 'history') {
          if (store.history.length === 0) return h('div', { style: S.hint }, '还没有浏览记录。')
          return store.history.map((e, i) => h('button', {
            key: e.url + '#' + i,
            type: 'button',
            style: S.row,
            title: e.url,
            onClick: () => navigate(e.url),
          },
          h('span', { style: S.rowTitle }, e.title || hostLabel(e.url)),
          h('span', { style: S.rowMeta }, when(e.time))))
        }
        if (panel === 'passwords') {
          if (store.creds.length === 0) {
            return h('div', { style: S.hint }, '还没有密码。点上面的「导入密码」，选 Edge 导出的 .csv 文件。')
          }
          return store.creds.map((c, i) => h('div', {
            key: c.host + '#' + i,
            style: { ...S.row, cursor: 'default', flexDirection: 'column', alignItems: 'flex-start', gap: 2 },
          },
          h('span', { style: { ...S.rowTitle, width: '100%', fontWeight: 500 } }, c.name || c.host),
          h('span', { style: { ...S.rowMeta, width: '100%' } }, (c.username || '（无账号）') + ' · ' + c.host)))
        }
        return null
      }

      const startPage = status === 'ready' && !/^https?:\/\//i.test(url)
        ? h('div', { style: S.start },
          h('div', { style: S.startTitle }, '浏览器+'),
          h('div', { style: { ...S.hint, padding: 0 } },
            '收藏夹、历史、密码自动填写都在这一份里。地址栏输入网址回车即可。'),
          h('div', { style: S.grid },
            h('button', { type: 'button', style: S.chip, onClick: () => bmInputRef.current && bmInputRef.current.click() }, '导入收藏夹 (.html)'),
            h('button', { type: 'button', style: S.chip, onClick: () => pwInputRef.current && pwInputRef.current.click() }, '导入密码 (.csv)')),
          store.bookmarks.length > 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: S.startTitle }, '常用收藏'),
              h('div', { style: S.grid },
                store.bookmarks.slice(0, 12).map((b) => h('button', {
                  key: b.url,
                  type: 'button',
                  style: S.chip,
                  title: b.url,
                  onClick: () => navigate(b.url),
                }, b.title || hostLabel(b.url)))))
            : null)
        : null

      return h('div', { style: S.root },
        h('div', { style: S.bar },
          iconBtn('‹', '后退', () => { const v = viewRef.current; if (v) v.goBack() }, !canBack),
          iconBtn('›', '前进', () => { const v = viewRef.current; if (v) v.goForward() }, !canForward),
          iconBtn('⟳', '刷新', () => { const v = viewRef.current; if (v) v.reload() }),
          h('input', {
            style: S.address,
            value: address,
            placeholder: '输入网址',
            spellCheck: false,
            onChange: (e) => setAddress(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') navigate(address)
            },
          }),
          iconBtn('🔑', '填一次密码', async () => {
            const n = await runAutofill()
            setNotice(n > 0 ? '已填入密码' : '这个页面没匹配到密码')
          }),
          iconBtn('★', '收藏夹', () => setPanel(panel === 'bookmarks' ? null : 'bookmarks')),
          iconBtn('🕘', '历史', () => setPanel(panel === 'history' ? null : 'history')),
          iconBtn('⚿', '密码', () => setPanel(panel === 'passwords' ? null : 'passwords'))),
        h('div', { style: S.body },
          panel
            ? h('div', { style: S.aside },
              h('div', { style: S.asideHead },
                h('span', { style: S.asideTitle },
                  panel === 'bookmarks' ? '收藏夹' : panel === 'history' ? '历史' : '密码'),
                panel === 'bookmarks'
                  ? h('button', { type: 'button', style: S.small, onClick: () => bmInputRef.current && bmInputRef.current.click() }, '导入')
                  : null,
                panel === 'passwords'
                  ? h('button', {
                    type: 'button',
                    style: S.small,
                    onClick: () => commit({ autofill: !store.autofill }),
                  }, store.autofill ? '自动填写：开' : '自动填写：关')
                  : null,
                panel === 'passwords'
                  ? h('button', { type: 'button', style: S.small, onClick: () => pwInputRef.current && pwInputRef.current.click() }, '导入')
                  : null,
                h('button', { type: 'button', style: S.small, onClick: () => setPanel(null) }, '收起')),
              h('div', { style: S.asideBody }, panelList()))
            : null,
          h('div', { style: S.viewport, ref: viewportRef }),
          startPage,
          status === 'unsupported'
            ? h('div', { style: S.start }, h('div', { style: S.startTitle }, '需要在桌面版中使用'),
              h('div', { style: S.hint, padding: 0 }, '网页版没有 Electron guest 通道，这个 tab 打不开页面。'))
            : null,
          notice ? h('div', {
            style: {
              position: 'absolute', left: 8, bottom: 8, maxWidth: '80%',
              padding: '4px 8px', borderRadius: 6, background: C.bg2,
              border: `0.5px solid ${C.border}`, color: C.dim, fontSize: 11,
            },
            onClick: () => setNotice(''),
          }, notice) : null),
        h('input', {
          ref: bmInputRef,
          type: 'file',
          accept: '.html,.htm',
          style: { display: 'none' },
          onChange: (e) => { const f = e.target.files && e.target.files[0]; importBookmarks(f); e.target.value = '' },
        }),
        h('input', {
          ref: pwInputRef,
          type: 'file',
          accept: '.csv,.txt',
          style: { display: 'none' },
          onChange: (e) => { const f = e.target.files && e.target.files[0]; importPasswords(f); e.target.value = '' },
        }))
    }

    return {
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TYPE_ID,
          kind: TYPE_KIND,
          priority: 'extension',
          multiple: true,
          keepMounted: true,
          title: () => '浏览器+',
          guide: [{
            id: 'open',
            order: 35,
            title: () => '浏览器+',
            description: () => '带收藏夹 / 历史 / 密码自动填写',
          }],
        }), 'my-browser: tab type')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TYPE_ID,
        }, BrowserPane)), 'my-browser: tab body')
      },
    }
  },
})
