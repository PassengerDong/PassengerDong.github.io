(() => {
  'use strict'

  const root = document.documentElement
  root.classList.add('js')
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false

  const reveal = () => {
    const nodes = document.querySelectorAll('.reveal')
    if (reduceMotion || !('IntersectionObserver' in window)) {
      nodes.forEach((node) => node.classList.add('is-visible'))
      return
    }
    const observer = new IntersectionObserver((entries, instance) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        entry.target.classList.add('is-visible')
        instance.unobserve(entry.target)
      })
    }, { threshold: 0.08, rootMargin: '0px 0px -20px' })
    nodes.forEach((node) => observer.observe(node))
  }

  const pointerField = () => {
    if (reduceMotion) return
    let frame = 0
    window.addEventListener('pointermove', (event) => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        root.style.setProperty('--pointer-x', `${Math.round((event.clientX / window.innerWidth) * 100)}%`)
        root.style.setProperty('--pointer-y', `${Math.round((event.clientY / window.innerHeight) * 100)}%`)
        frame = 0
      })
    }, { passive: true })
  }

  const markCurrentRoute = () => {
    const current = window.location.pathname.replace(/\/$/, '') || '/'
    document.querySelectorAll('.nav-link').forEach((link) => {
      const target = new URL(link.href, window.location.origin).pathname.replace(/\/$/, '') || '/'
      const isNestedRoute = target !== '/' && current.startsWith(`${target}/`)
      const isTaxonomyRoute = target === '/tags' && (current.startsWith('/tags/') || current.startsWith('/categories/'))
      link.classList.toggle('is-active', target === current || isNestedRoute || isTaxonomyRoute)
    })
  }

  const updateThemeToggle = (mode) => {
    const toggle = document.getElementById('theme-toggle')
    if (!toggle) return
    const isDark = mode === 'dark'
    const themeColor = document.querySelector('meta[name="theme-color"]')
    if (themeColor) themeColor.setAttribute('content', isDark ? '#091126' : '#f2f5f9')
    toggle.setAttribute('aria-pressed', String(isDark))
    toggle.setAttribute('aria-label', isDark ? 'Switch to day mode' : 'Switch to night mode')
    const label = toggle.querySelector('.theme-toggle-label')
    if (label) label.textContent = isDark ? 'DAY' : 'NIGHT'
  }

  const setTheme = (mode, persist = true) => {
    const next = mode === 'dark' ? 'dark' : 'light'
    root.setAttribute('data-theme', next)
    if (persist) {
      try {
        window.localStorage.setItem('somniomancer-theme', next)
      } catch (error) {}
    }
    updateThemeToggle(next)
  }

  const initThemeToggle = () => {
    const toggle = document.getElementById('theme-toggle')
    if (!toggle) return
    const initial = root.getAttribute('data-theme') || 'light'
    updateThemeToggle(initial)
    toggle.addEventListener('click', () => {
      setTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark')
    })
  }

  const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[character]))

  const initSearch = () => {
    const form = document.getElementById('site-search-form')
    const input = document.getElementById('site-search-input')
    const results = document.getElementById('search-results')
    const source = document.getElementById('site-search-data')
    if (!form || !input || !results || !source) return

    let records = []
    try {
      records = JSON.parse(source.textContent || '[]').map((record) => ({
        title: String(record.title || ''),
        path: String(record.path || ''),
        summary: String(record.summary || ''),
        haystack: `${record.title || ''} ${record.summary || ''}`.toLocaleLowerCase()
      }))
    } catch (error) {
      records = []
    }

    const render = () => {
      const query = input.value.trim().toLocaleLowerCase()
      if (!query) {
        results.hidden = true
        results.innerHTML = ''
        return
      }
      const matches = records.filter((record) => record.haystack.includes(query)).slice(0, 7)
      if (!matches.length) {
        results.innerHTML = '<div class="search-empty">NO RECORDS FOUND</div>'
        results.hidden = false
        return
      }
      results.innerHTML = matches.map((record) => `
        <a class="search-result" href="${escapeHtml(record.path)}">
          <small>ARCHIVE / MATCH</small>
          <strong>${escapeHtml(record.title)}</strong>
          <span>${escapeHtml(record.summary)}</span>
        </a>
      `).join('')
      results.hidden = false
    }

    input.addEventListener('input', render)
    input.addEventListener('focus', render)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        input.value = ''
        results.hidden = true
        results.innerHTML = ''
        input.blur()
      }
    })
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const query = input.value.trim().toLocaleLowerCase()
      const match = records.find((record) => record.haystack.includes(query))
      if (match && query) window.location.assign(match.path)
    })
    document.addEventListener('click', (event) => {
      if (!form.parentElement.contains(event.target)) results.hidden = true
    })
  }

  const initTraceFilter = () => {
    const input = document.getElementById('trace-filter')
    const rows = Array.from(document.querySelectorAll('.trace-results .archive-row'))
    if (!input || !rows.length) return
    input.addEventListener('input', () => {
      const query = input.value.trim().toLocaleLowerCase()
      rows.forEach((row) => {
        row.hidden = Boolean(query) && !row.textContent.toLocaleLowerCase().includes(query)
      })
    })
  }

  const initArchiveLoader = () => {
    const loader = document.getElementById('archive-loader')
    const rows = Array.from(document.querySelectorAll('.archive-record[data-archive-index]'))
    if (!loader || rows.length <= 3) {
      if (loader) loader.hidden = true
      return
    }

    const batchSize = 3
    let visibleCount = batchSize
    rows.slice(batchSize).forEach((row) => {
      row.hidden = true
    })

    const revealNext = () => {
      rows.slice(visibleCount, visibleCount + batchSize).forEach((row) => {
        row.hidden = false
      })
      visibleCount += batchSize
      if (visibleCount >= rows.length) {
        loader.hidden = true
        if (observer) observer.disconnect()
      }
    }

    if (!('IntersectionObserver' in window)) {
      rows.forEach((row) => {
        row.hidden = false
      })
      loader.hidden = true
      return
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) revealNext()
    }, { rootMargin: '0px 0px 240px' })
    observer.observe(loader)
  }

  const start = () => {
    if (document.body.classList.contains('is-ready')) return
    document.body.classList.add('is-ready')
    initThemeToggle()
    initSearch()
    initTraceFilter()
    initArchiveLoader()
    reveal()
    pointerField()
    markCurrentRoute()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }
})()
