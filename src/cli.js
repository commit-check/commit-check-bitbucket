const fs = require('fs')
const path = require('path')

/**
 * The commit-check CLI, run inside Pyodide (CPython compiled to
 * WebAssembly), so a merge check needs no server of ours: the Forge function
 * runs the same CLI release as the GitHub App, the Action and the pre-commit
 * hook. python/commit_check_forge.py answers the CLI's git questions from
 * the commits Bitbucket's API returned.
 *
 * Loading Pyodide and the CLI takes about two seconds; a warm function keeps
 * them for the next check. Nothing about a repository is kept: each run
 * writes its config into a fresh directory and removes it.
 */

const { version: CLI_VERSION } = require('../package.json').commitCheck
const WHEEL = `commit_check-${CLI_VERSION}-py3-none-any.whl`

// python/ sits next to the bundle in the deployed package, and one level up
// from src/ while developing.
function pythonDir () {
  const candidates = [path.join(__dirname, 'python'), path.join(__dirname, '..', 'python')]
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, 'commit_check_forge.py')))
  if (!found) throw new Error('python/commit_check_forge.py is missing from the package')
  return found
}

let pending = null

/** The loaded shim module, once per process. */
function engine () {
  if (!pending) {
    pending = (async () => {
      const { loadPyodide } = require('pyodide')
      const dir = pythonDir()
      const py = await loadPyodide()
      py.unpackArchive(new Uint8Array(fs.readFileSync(path.join(dir, WHEEL))), 'wheel')
      py.FS.mkdirTree('/forge')
      py.FS.writeFile('/forge/commit_check_forge.py', fs.readFileSync(path.join(dir, 'commit_check_forge.py')))
      py.runPython('import sys\nsys.path.insert(0, "/forge")')
      return py.pyimport('commit_check_forge')
    })()
    pending.catch(() => { pending = null })
  }
  return pending
}

/**
 * Run the CLI once.
 * @param {object} request - { argv, stdin, config: {path, text}|null,
 *   commits: [{ sha, message, parents, author: { name, email } }], head,
 *   branch }
 * @returns {Promise<object>} - { code, stdout, stderr, unsupported }
 */
async function runCli (request) {
  const mod = await engine()
  return JSON.parse(mod.run(JSON.stringify(request)))
}

/**
 * Parse a config file with the CLI's own TOML reader (Python's tomllib).
 * @param {string} text
 * @returns {Promise<object>} - { config } or { error }
 */
async function parseConfig (text) {
  const mod = await engine()
  return JSON.parse(mod.parse_config(text))
}

module.exports = { runCli, parseConfig, engine, CLI_VERSION, WHEEL }
