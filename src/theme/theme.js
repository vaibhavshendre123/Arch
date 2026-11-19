// Theme preference helpers, kept free of React so they can be used by the boot script in
// index.html and unit-tested without a DOM.

export const THEME_STORAGE_KEY = 'archai.theme'
export const THEMES = ['dark', 'light']

export function isTheme(value) {
  return value === 'dark' || value === 'light'
}

/** A stored choice wins; otherwise follow the OS colour scheme. */
export function resolveTheme(stored, prefersLightScheme) {
  return isTheme(stored) ? stored : prefersLightScheme ? 'light' : 'dark'
}

export function readStoredTheme(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY)
    return isTheme(value) ? value : null
  } catch {
    // Private browsing / disabled storage: fall back to the system preference.
    return null
  }
}

export function writeStoredTheme(theme, storage = globalThis.localStorage) {
  if (!isTheme(theme)) return false
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme)
    return true
  } catch {
    return false
  }
}

export function prefersLightScheme() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches
  )
}
