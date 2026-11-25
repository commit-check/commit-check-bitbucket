// Download the commit-check CLI wheel named in package.json ("commitCheck")
// from PyPI into python/, and check it against the pinned sha256. Run by
// `npm run build` and `npm test`; does nothing when the file is already there
// and matches.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { version, sha256 } = require('../package.json').commitCheck
const file = `commit_check-${version}-py3-none-any.whl`
const target = path.join(__dirname, '..', 'python', file)

const digest = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

async function main () {
  if (fs.existsSync(target) && digest(fs.readFileSync(target)) === sha256) return
  const meta = await fetch(`https://pypi.org/pypi/commit-check/${version}/json`)
  if (!meta.ok) throw new Error(`PyPI answered ${meta.status} for commit-check ${version}`)
  const entry = (await meta.json()).urls.find((u) => u.filename === file)
  if (!entry) throw new Error(`PyPI has no ${file}`)
  const res = await fetch(entry.url)
  if (!res.ok) throw new Error(`PyPI answered ${res.status} for ${file}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (digest(buf) !== sha256) throw new Error(`${file} does not match the sha256 in package.json`)
  fs.writeFileSync(target, buf)
  process.stdout.write(`Fetched ${file}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
})
