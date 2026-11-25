// The CLI in Pyodide, and the git it is answered with. Where the real CLI
// and git are installed (CI installs the pinned CLI), each case also runs
// the real CLI on the same commits written into a real repository, and the
// two reports must match: the stand-in git is only right if the CLI cannot
// tell it from the real one.
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const cli = require('../cli')

const realCli = spawnSync('commit-check', ['--version'], { encoding: 'utf8' })
const sameCli = realCli.status === 0 && realCli.stdout.includes(cli.CLI_VERSION)
const testReal = sameCli ? test : test.skip

const git = (dir, args, opts = {}) => {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8', ...opts })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout.trim()
}

/** The commits written into a real repository; returns { dir, shas }. */
function realRepo (commits, branch, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-parity-'))
  git(dir, ['init', '-q'])
  const tree = git(dir, ['mktree'], { input: '' })
  const shas = new Map()
  for (const c of commits) {
    const parents = c.parents.flatMap((p) => ['-p', shas.get(p)])
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: c.author.name,
      GIT_AUTHOR_EMAIL: c.author.email,
      GIT_COMMITTER_NAME: c.author.name,
      GIT_COMMITTER_EMAIL: c.author.email
    }
    shas.set(c.sha, git(dir, ['commit-tree', tree, ...parents], { input: c.message, env }))
  }
  git(dir, ['update-ref', `refs/heads/${branch}`, shas.get(commits[commits.length - 1].sha)])
  git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
  if (config) fs.writeFileSync(path.join(dir, config.path), config.text)
  return { dir, shas }
}

/** The CLI's report with each commit's sha written as its name in `names`. */
function normalized (stdout, names) {
  let text = stdout
  for (const [name, sha] of names) text = text.split(sha).join(name)
  return JSON.parse(text)
}

const author = { name: 'Jo Doe', email: 'jo@example.com' }
const sha = (n) => String(n).repeat(40).slice(0, 40)

const CASES = [
  ['a conventional commit with a body', 'feat: add x\n\nWhy it is needed.\n', '[commit]\nconventional_commits = true\n'],
  ['a message that breaks the rules', 'added x\n', '[commit]\nconventional_commits = true\nsubject_imperative = true\n'],
  ['a subject over two lines and trailers', 'fix: tidy\nup more\n\nBody.\n\nSigned-off-by: Jo Doe <jo@example.com>\nCo-authored-by: Claude <noreply@anthropic.com>\n', '[commit]\nrequire_signed_off_by = true\nai_attribution = "forbid"\n'],
  ['leading blank lines and no newline', '\n\nchore: x', '[commit]\nsubject_max_length = 10\n'],
  ['an ignored author', 'wip\n', '[commit]\nconventional_commits = true\n[author.name]\nignore_authors = ["Jo Doe"]\n'],
  ['the branch and author rules', 'feat: x\n', '[branch]\nconventional_branch = true\nrequire_rebase_target = "main"\n[author.email]\nregex = "@example\\\\.org$"\n'],
  ['no config file', 'feat: x\n', null]
]

describe('the CLI in Pyodide', () => {
  beforeAll(() => cli.engine(), 60000)

  describe.each(CASES)('%s', (_, message, configText) => {
    const commits = [
      { sha: sha(1), message: 'feat: base\n', parents: [], author },
      { sha: sha(2), message, parents: [sha(1)], author }
    ]
    const config = configText ? { path: 'cchk.toml', text: configText } : null
    const argv = ['--rev', sha(2), '-m', '-n', '-e', '-b', '--format', 'json', '--no-banner']

    test('runs, asking git nothing it cannot answer', async () => {
      const res = await cli.runCli({ argv, files: config ? [config] : [], commits, head: sha(2), branch: 'feature/x' })
      expect(res.unsupported).toEqual([])
      expect(JSON.parse(res.stdout).checks.length).toBeGreaterThan(0)
    })

    testReal('reports what the real CLI reports on a real repository', async () => {
      const ours = await cli.runCli({ argv, files: config ? [config] : [], commits, head: sha(2), branch: 'feature/x' })
      const { dir, shas } = realRepo(commits, 'feature/x', config)
      try {
        const theirs = spawnSync('commit-check', ['--rev', shas.get(sha(2)), ...argv.slice(2)], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } })
        expect(ours.code).toBe(theirs.status)
        expect(normalized(ours.stdout, [['B', sha(2)]])).toEqual(normalized(theirs.stdout, [['B', shas.get(sha(2))]]))
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  test('a description is piped as stdin', async () => {
    const res = await cli.runCli({
      argv: ['--ai-attribution-only', '--format', 'json', '--no-banner'],
      stdin: '# Summary\n\nGenerated with Claude Code',
      files: [{ path: 'cchk.toml', text: '[commit]\nai_attribution = "forbid"\n' }],
      commits: [],
      head: null,
      branch: ''
    })
    expect(res.code).toBe(1)
    expect(JSON.parse(res.stdout).checks.map((c) => [c.rule_id, c.status])).toEqual([['CC013', 'fail']])
  })

  test('a squash message is checked without an author, as git with no identity would', async () => {
    // Bitbucket does not tell a merge check who presses Merge, so the
    // squash commit's author is unknown when the CLI asks git var.
    const res = await cli.runCli({
      argv: ['.commit-check-message', '-m', '-n', '-e', '-b', '--format', 'json', '--no-banner'],
      files: [
        { path: 'cchk.toml', text: '[commit]\nai_attribution = "forbid"\n' },
        { path: '.commit-check-message', text: 'bad message' }
      ],
      commits: [{ sha: sha(1), message: 'feat: x\n', parents: [], author }],
      head: sha(1),
      branch: 'feature/x'
    })
    expect(res.unsupported).toEqual([])
    const status = Object.fromEntries(JSON.parse(res.stdout).checks.map((c) => [c.rule_id, c.status]))
    expect(status.CC001).toBe('fail')
    expect(status.CC017).not.toBe('fail')
  })

  test('a git command it does not know fails as git would, and is listed', async () => {
    const res = await cli.runCli({ argv: ['-t', '--format', 'json', '--no-banner'], files: [], commits: [], head: null, branch: '' })
    expect(res.unsupported).toEqual(['git tag --points-at HEAD'])
  })

  test('a file outside the work directory is refused', async () => {
    await expect(cli.runCli({ argv: [], files: [{ path: '../../etc/x', text: '' }], commits: [] })).rejects.toThrow(/path outside the repository/)
  })

  test('argparse errors come back as exit 2', async () => {
    const res = await cli.runCli({ argv: ['--no-such-flag'], commits: [] })
    expect(res.code).toBe(2)
    expect(res.stderr).toMatch(/unrecognized arguments/)
  })

  test('the config is parsed with the CLI\'s TOML reader', async () => {
    await expect(cli.parseConfig('[jira]\nrequired = true\nwhen = 2026-11-24\n')).resolves.toEqual({ config: { jira: { required: true, when: '2026-11-24' } } })
    await expect(cli.parseConfig('a = [1')).resolves.toEqual({ error: 'Unclosed array (at end of document)' })
  })
})

describe('the git stand-in', () => {
  const realGit = spawnSync('git', ['--version']).status === 0
  let split
  beforeAll(async () => {
    const mod = await cli.engine()
    split = (message) => mod._split_message(message).toJs()
  })

  test.each([
    ['feat: x\n', 'feat: x', ''],
    ['feat: x\n\nbody\n', 'feat: x', 'body\n'],
    ['a\nb\n\n\nc\nd', 'a b', 'c\nd'],
    ['\n\n  lead \n\nrest\n', '  lead', 'rest\n'],
    ['', '', '']
  ])('%j has the subject (%%s) and body (%%b) git gives it', (message, subject, body) => {
    expect(split(message)).toEqual([subject, body])
    if (!realGit) return
    const { dir, shas } = realRepo([{ sha: sha(3), message, parents: [], author }], 'x', null)
    try {
      const show = (fmt) => spawnSync('git', ['log', '-n', '1', `--pretty=format:${fmt}`, shas.get(sha(3))], { cwd: dir, encoding: 'utf8' }).stdout
      expect([show('%s'), show('%b')]).toEqual([subject, body])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('loading', () => {
  test('a missing python/ directory is reported, and the next call tries again', async () => {
    jest.resetModules()
    jest.doMock('fs', () => ({ ...jest.requireActual('fs'), existsSync: () => false }))
    try {
      const fresh = require('../cli')
      await expect(fresh.engine()).rejects.toThrow('python/commit_check_forge.py is missing from the package')
      await expect(fresh.engine()).rejects.toThrow('missing')
    } finally {
      jest.dontMock('fs')
      jest.resetModules()
    }
  })
})
