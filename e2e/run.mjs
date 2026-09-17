/**
 * Boots `vite preview` (which supplies the COOP/COEP headers the app needs),
 * runs the smoke suite against it, and shuts the server down again.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 4173
const BASE = `http://localhost:${PORT}`

const server = spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'inherit'],
})

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE)
      if (response.ok) return
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('vite preview did not start in time')
}

let code = 1
try {
  await waitForServer()
  // Suites share one server and run in sequence; any failure fails the run.
  code = 0
  for (const suite of ['smoke', 'tools', 'ui', 'flows', 'editor', 'ai']) {
    console.log(`\n===== ${suite} =====`)
    const child = spawn('node', [`e2e/${suite}.mjs`], { stdio: 'inherit', env: { ...process.env, BASE_URL: BASE } })
    const exit = await new Promise((resolve) => child.on('exit', resolve))
    if (exit !== 0) code = 1
  }
} finally {
  server.kill('SIGTERM')
}
process.exit(code ?? 1)
