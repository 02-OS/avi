import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

function runNpm(args) {
  if (process.env.npm_execpath) {
    return spawnSync(process.execPath, [process.env.npm_execpath, ...args], { stdio: 'inherit' })
  }
  if (process.platform === 'win32') {
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], {
      stdio: 'inherit',
    })
  }
  return spawnSync('npm', args, { stdio: 'inherit' })
}

if (!existsSync(path.resolve('app/src/wasm-pkg/avi_wasm.js'))) {
  console.log('avi: building pixel filters (wasm-pack)')
  const wasmDir = path.resolve('wasm')
  const outDir = path.resolve('app/src/wasm-pkg')
  const wasmBuilt = spawnSync(
    'wasm-pack',
    ['build', '--target', 'web', '--release', '--out-dir', outDir, '--out-name', 'avi_wasm'],
    { cwd: wasmDir, stdio: 'inherit' }
  )
  if (wasmBuilt.status !== 0) {
    console.error('avi: wasm-pack build failed. Install wasm-pack and the wasm32-unknown-unknown target, then retry.')
    process.exit(wasmBuilt.status ?? 1)
  }
}

const built = runNpm(['run', 'build:app'])
process.exit(built.status ?? 1)
