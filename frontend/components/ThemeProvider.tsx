'use client'

/**
 * Headless: resolves the chosen theme ('dark' | 'light' | 'system') to a concrete
 * value and applies it as <html data-theme>. In 'system' mode it follows the OS
 * via matchMedia and re-applies on change. Mounted once in the layout; the
 * pre-paint script there sets the initial value so there's no flash.
 */

import { useEffect } from 'react'
import { useThemeStore } from '@/store/theme.store'

export function ThemeProvider() {
  const theme = useThemeStore((s) => s.theme)

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: light)')
    const apply = () => {
      const resolved = theme === 'system' ? (mql.matches ? 'light' : 'dark') : theme
      document.documentElement.setAttribute('data-theme', resolved)
    }
    apply()
    if (theme === 'system') {
      mql.addEventListener('change', apply)
      return () => mql.removeEventListener('change', apply)
    }
  }, [theme])

  return null
}
