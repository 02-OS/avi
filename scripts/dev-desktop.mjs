import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

function spawnNpm(args, env) {
  if (process.env.npm_execpath) {
    return spawn(process.execPath, [process.env.npm_execpath, ...args], {
      stdio: 'inherit',
      env,
    })
  }
  if (process.platform === 'win32') {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], {
      stdio: 'inherit',
      env,
    })
  }
  return spawn('npm', args, {
    stdio: 'inherit',
    env,
  })
}

if (!existsSync(path.resolve('app/src/wasm-pkg/avi_wasm.js'))) {
  console.log('avi: building pixel filters (wasm-pack)')
  const wasmDir = path.resolve('wasm')
  const outDir = path.resolve('app/src/wasm-pkg')
  const built = spawnSync(
    'wasm-pack',
    ['build', '--target', 'web', '--release', '--out-dir', outDir, '--out-name', 'avi_wasm'],
    { cwd: wasmDir, stdio: 'inherit' }
  )
  if (built.status !== 0) {
    console.error('avi: wasm-pack build failed. Install wasm-pack and the wasm32-unknown-unknown target, then retry.')
    process.exit(built.status ?? 1)
  }
}

const child = spawnNpm(['run', 'dev:app'], { ...process.env, AVI_DEV_PORT: '1420' })

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal)
  }
}

process.on('SIGINT', () => forwardSignal('SIGINT'))
process.on('SIGTERM', () => forwardSignal('SIGTERM'))

child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
