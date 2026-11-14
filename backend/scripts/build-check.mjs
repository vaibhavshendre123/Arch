/**
 * Backend "build" check.
 *
 * A Node service does not have a bundling step, so this stands in for one: it proves that
 * every source file parses and that the Express app module actually loads. That catches the
 * class of mistake a bundler would catch for a frontend — a syntax error, a bad import path,
 * a circular import that only explodes at request time — without starting a listener or
 * touching the database.
 *
 * `src/server.js` is syntax-checked but never imported: importing it would bind a port and
 * open a database connection, which is exactly what a build check must not do.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(root, 'src')

function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) collect(full, out)
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

const files = collect(srcDir).sort()
let failed = 0

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failed += 1
    const relative = path.relative(root, file)
    console.error(`[build] syntax error in ${relative}\n${result.stderr || ''}`)
  }
}

if (failed > 0) {
  console.error(`[build] ${failed} file(s) failed to parse`)
  process.exit(1)
}

const app = (await import(pathToFileURL(path.join(srcDir, 'app.js')).href)).default
if (typeof app !== 'function' || typeof app.use !== 'function') {
  console.error('[build] src/app.js did not export an Express application')
  process.exit(1)
}

console.log(`[build] ${files.length} source files parsed; the Express app loads.`)
