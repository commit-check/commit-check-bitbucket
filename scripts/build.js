// Lay out out/, the directory `forge deploy` uploads as it is (manifest:
// app.package.bundler manual@2026):
//
//   out/index.js                 the function, bundled into one file
//   out/node_modules/            pyodide and @forge/api, which must stay
//                                files: Pyodide reads its .wasm and stdlib
//   out/python/                  the git stand-in and the pinned CLI wheel
//
// Forge's default bundler (webpack, one JavaScript file) cannot ship
// Pyodide's WebAssembly, which is why this app packages itself.
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const out = path.join(root, 'out')
const { version } = require('../package.json').commitCheck
const wheel = `commit_check-${version}-py3-none-any.whl`
const EXTERNAL = ['pyodide', '@forge/api']

async function main () {
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(path.join(out, 'python'), { recursive: true })

  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'index.js')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: path.join(out, 'index.js'),
    external: EXTERNAL,
    legalComments: 'eof'
  })

  for (const file of ['commit_check_forge.py', wheel]) {
    fs.copyFileSync(path.join(root, 'python', file), path.join(out, 'python', file))
  }

  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, file), path.join(out, file))
  }
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: out, stdio: 'inherit' })
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`)
  process.exit(1)
})
