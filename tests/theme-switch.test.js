import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  isTheme,
  prefersLightScheme,
  readStoredTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  writeStoredTheme,
} from '../src/theme/theme.js'

function fakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed))
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  }
}

describe('theme preference', () => {
  it('accepts only the two shipped themes', () => {
    assert.equal(isTheme('dark'), true)
    assert.equal(isTheme('light'), true)
    assert.equal(isTheme('blueprint'), false)
    assert.equal(isTheme(null), false)
  })

  it('prefers a stored choice over the operating system setting', () => {
    assert.equal(resolveTheme('light', false), 'light')
    assert.equal(resolveTheme('dark', true), 'dark')
  })

  it('follows the OS only when nothing has been saved', () => {
    assert.equal(resolveTheme(null, true), 'light')
    assert.equal(resolveTheme(null, false), 'dark')
    assert.equal(resolveTheme('corrupt', true), 'light')
  })

  it('round-trips a saved theme and ignores corrupt values', () => {
    const storage = fakeStorage()
    assert.equal(readStoredTheme(storage), null)
    assert.equal(writeStoredTheme('light', storage), true)
    assert.equal(storage.getItem(THEME_STORAGE_KEY), 'light')
    assert.equal(readStoredTheme(storage), 'light')
    assert.equal(writeStoredTheme('blueprint', storage), false)
    assert.equal(storage.getItem(THEME_STORAGE_KEY), 'light')

    const corrupt = fakeStorage({ [THEME_STORAGE_KEY]: 'blueprint' })
    assert.equal(readStoredTheme(corrupt), null)
  })

  it('does not assume a browser when checking the OS scheme', () => {
    assert.equal(prefersLightScheme(), false)
  })
})
