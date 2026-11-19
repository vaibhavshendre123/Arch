import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { isTheme, prefersLightScheme, readStoredTheme, resolveTheme, THEMES, writeStoredTheme } from './theme.js'

const ThemeContext = createContext(null)

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => resolveTheme(readStoredTheme(), prefersLightScheme()))

  // The attribute is the single switch the stylesheet and the JS tokens both read. Apply it
  // during render, before children compute JS token colours: doing this only in an effect
  // would leave those values on the previous palette until the next unrelated re-render.
  // The write is idempotent, so StrictMode's double render is harmless.
  if (typeof document !== 'undefined') {
    const root = document.documentElement
    if (root.dataset.theme !== theme || root.style.colorScheme !== theme) {
      root.dataset.theme = theme
      root.style.colorScheme = theme
    }
  }

  useEffect(() => {
    writeStoredTheme(theme)
  }, [theme])

  const setTheme = useCallback((next) => {
    if (isTheme(next)) setThemeState(next)
  }, [])

  const toggleTheme = useCallback(() => {
    setThemeState((current) => (current === 'dark' ? 'light' : 'dark'))
  }, [])

  const value = useMemo(
    () => ({ theme, setTheme, toggleTheme, themes: THEMES }),
    [theme, setTheme, toggleTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}
