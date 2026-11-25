// Bitbucket merge checks end to end through the commit-check CLI in
// Pyodide, with a stand-in for the Bitbucket client.
const cli = require('../cli')
const { runMergeCheck, CONFIG_PATHS, DEFAULT_MAX_COMMITS } = require('../mergeCheck')

const author = { name: 'Jo Doe', email: 'jo@example.com' }
const commit = (sha, message, parents = [], who = author) => ({ sha, message, parents, author: who })

const CONFIG = '[commit]\nconventional_commits = true\n'

/** A BitbucketClient stand-in serving one pull request. */
function fakeClient ({ commits = [], config = CONFIG, configPath = 'cchk.toml', pr = {}, more = false, behind = null } = {}) {
  return {
    pullRequest: jest.fn(async () => ({
      id: 1,
      title: 'feat: add x',
      description: '',
      sourceBranch: 'feature/add-x',
      sourceHash: 'head',
      destinationBranch: 'main',
      destinationHash: 'base',
      ...pr
    })),
    configFile: jest.fn(async () => (config === null ? null : { path: configPath, text: config })),
    pullRequestCommits: jest.fn(async () => ({ commits, more })),
    behindBy: jest.fn(async () => {
      if (behind instanceof Error) throw behind
      return behind
    })
  }
}

const event = (trigger = 'on-code-pushed', mergeProperties) => ({
  workspace: { uuid: '{ws}' },
  repository: { uuid: '{repo}' },
  pullrequest: { id: 1 },
  trigger: { type: trigger },
  ...(mergeProperties ? { mergeProperties } : {})
})

const quiet = () => ({ warn: jest.fn() })

beforeAll(() => cli.engine(), 60000)
afterEach(() => jest.restoreAllMocks())

describe('before the CLI', () => {
  test('a merge that is not a squash has nothing new to check', async () => {
    const client = fakeClient()
    await expect(runMergeCheck({ event: event('on-merge', { mergeStrategy: 'merge_commit', commitMessage: 'x' }), client })).resolves.toEqual({
      success: true,
      message: 'Nothing new to check: a merge commit merge lands the commits the pull request check already checked.'
    })
    expect(client.pullRequest).not.toHaveBeenCalled()
  })

  test('an on-merge event without merge properties is not a squash either', async () => {
    const result = await runMergeCheck({ event: event('on-merge'), client: fakeClient() })
    expect(result.message).toBe('Nothing new to check: a non-squash merge lands the commits the pull request check already checked.')
  })

  test('a pull request without commits has nothing to check', async () => {
    await expect(runMergeCheck({ event: event(), client: fakeClient() })).resolves.toEqual({
      success: true,
      message: 'Nothing to check: the pull request has no commits.'
    })
  })

  test('the config is read from the destination commit, at the CLI\'s paths', async () => {
    const client = fakeClient()
    await runMergeCheck({ event: event(), client })
    expect(client.configFile).toHaveBeenCalledWith('{ws}', '{repo}', 'base', CONFIG_PATHS)
    expect(CONFIG_PATHS).toEqual(['cchk.toml', 'commit-check.toml', '.github/cchk.toml', '.github/commit-check.toml'])
  })

  test('the destination branch stands in for a missing destination commit', async () => {
    const client = fakeClient({ pr: { destinationHash: '' } })
    await runMergeCheck({ event: event(), client })
    expect(client.configFile).toHaveBeenCalledWith('{ws}', '{repo}', 'main', CONFIG_PATHS)
  })

  test('the commits are listed up to the cap, one page of Bitbucket\'s listing', async () => {
    const client = fakeClient()
    await runMergeCheck({ event: event(), client })
    expect(client.pullRequestCommits).toHaveBeenCalledWith('{ws}', '{repo}', 1, { max: DEFAULT_MAX_COMMITS })
    expect(DEFAULT_MAX_COMMITS).toBe(100)
  })

  test('a config file that is not TOML fails the check, naming the file', async () => {
    const client = fakeClient({ commits: [commit('a1', 'feat: x')], config: '[commit\n', configPath: '.github/cchk.toml' })
    await expect(runMergeCheck({ event: event(), client })).resolves.toEqual({
      success: false,
      message: 'Config file could not be parsed: .github/cchk.toml: Expected \']\' at the end of a table declaration (at line 1, column 8)'
    })
  })
})

describe('runMergeCheck', () => {
  test('a pull request whose commits all pass', async () => {
    const result = await runMergeCheck({ event: event(), client: fakeClient({ commits: [commit('a1', 'feat: add x'), commit('a2', 'fix: tidy x', ['a1'])] }) })
    expect(result).toEqual({ success: true, message: 'All 4 checks passed.' })
  })

  test('an earlier commit that fails fails the pull request, and is named', async () => {
    const result = await runMergeCheck({ event: event(), client: fakeClient({ commits: [commit('a1aaaaaaaa', 'added x'), commit('a2', 'fix: tidy x', ['a1aaaaaaaa'])] }) })
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/^1 earlier commit failed\. a1aaaaa "added x": CC001 /)
    expect(result.message).toMatch(/Rules: https:\/\/commit-check\.com\/rules\/$/)
  })

  test('the branch name is checked on the head', async () => {
    const result = await runMergeCheck({ event: event(), client: fakeClient({ commits: [commit('a1', 'feat: add x')], pr: { sourceBranch: 'jsmith-stuff' } }) })
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/^Branch failed \(1 of 4 checks\)\. a1 "feat: add x": CC201 /)
  })

  test('a branch name is made up when Bitbucket gives none', async () => {
    const run = jest.spyOn(cli, 'runCli')
    const result = await runMergeCheck({ event: event(), client: fakeClient({ commits: [commit('a1', 'feat: add x')], pr: { sourceBranch: '' } }) })
    expect(result.message).toMatch(/CC201/)
    expect(run.mock.calls[0][0].branch).toBe('pull-request-1')
  })

  test('without a config file a failure is reported but does not block', async () => {
    const result = await runMergeCheck({ event: event(), client: fakeClient({ commits: [commit('a1', 'added x')], config: null }) })
    expect(result.success).toBe(true)
    expect(result.message).toMatch(/^Commit message would fail \(1 of 4 checks, not enforced\)\. /)
    expect(result.message).toMatch(/Add a cchk\.toml to enforce these rules: https:\/\/commit-check\.com\/configuration\/$/)
  })

  test('a config file the CLI refuses fails the check, naming the file', async () => {
    const client = fakeClient({ commits: [commit('a1', 'feat: x')], config: '[commit]\nsubject_max_length = "x"\n' })
    await expect(runMergeCheck({ event: event(), client })).resolves.toEqual({
      success: false,
      message: "Config file could not be parsed: cchk.toml: Error: [commit] subject_max_length must be a whole number, got 'x'"
    })
  })

  test('a CLI that prints no report is an error, not a verdict', async () => {
    jest.spyOn(cli, 'runCli').mockResolvedValue({ code: 1, stdout: '', stderr: 'Traceback ...', unsupported: [] })
    await expect(runMergeCheck({ event: event(), client: fakeClient({ commits: [commit('a1', 'feat: x')] }) })).rejects.toThrow('commit-check produced no parsable JSON (exit 1): Traceback ...')
    jest.spyOn(cli, 'runCli').mockResolvedValue({ code: 1, stdout: '', stderr: '', unsupported: [] })
    await expect(runMergeCheck({ event: event(), client: fakeClient({ commits: [commit('a1', 'feat: x')], config: null }) })).rejects.toThrow('(exit 1): ')
  })

  test('a refusal without a config file still fails the check', async () => {
    jest.spyOn(cli, 'runCli').mockResolvedValue({ code: 2, stdout: '', stderr: 'Error: CCHK_SUBJECT_MAX_LENGTH is not a number', unsupported: [] })
    await expect(runMergeCheck({ event: event(), client: fakeClient({ commits: [commit('a1', 'feat: x')], config: null }) })).resolves.toEqual({
      success: false,
      message: 'Config file could not be parsed: the config file: Error: CCHK_SUBJECT_MAX_LENGTH is not a number'
    })
  })

  test('git questions the app cannot answer are logged', async () => {
    const run = cli.runCli
    jest.spyOn(cli, 'runCli').mockImplementation(async (req) => ({ ...(await run(req)), unsupported: ['git describe'] }))
    const logger = quiet()
    await runMergeCheck({ event: event(), client: fakeClient({ commits: [commit('a1', 'feat: x')] }), logger })
    expect(logger.warn).toHaveBeenCalledWith('commit-check asked git what this app cannot answer: git describe')
  })

  test('a commit without a message is checked as an empty one, which the CLI does not fail', async () => {
    const client = fakeClient({ commits: [{ sha: 'a1', parents: [], author }, commit('a2', 'feat: x', ['a1'])] })
    await expect(runMergeCheck({ event: event(), client })).resolves.toMatchObject({ success: true })
  })

  test('in squash mode the pull request check leaves the message to the merge', async () => {
    const client = fakeClient({ commits: [commit('a1', 'wip')], config: CONFIG + '[pull_request]\ncheck = "squash"\n' })
    const result = await runMergeCheck({ event: event(), client })
    expect(result.success).toBe(true)
    expect(result.message).toMatch(/^Checked at merge: /)
  })

  test('the author rules read each commit\'s own author', async () => {
    const bot = { name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com' }
    const client = fakeClient({
      commits: [commit('a1', 'feat: add x', [], bot), commit('a2', 'fix: tidy x', ['a1'])],
      config: CONFIG + '[author.name]\nignore_authors = ["dependabot[bot]"]\n[author.email]\nregex = "@example\\\\.com$"\n'
    })
    const result = await runMergeCheck({ event: event(), client })
    expect(result).toEqual({ success: true, message: 'All 4 checks passed.' })
  })

  describe('on merge', () => {
    const squash = (commitMessage, mergeStrategy = 'squash') => event('on-merge', { mergeStrategy, commitMessage, commitMessageTruncated: false, closeSourceBranch: true })

    test('the squash message is checked', async () => {
      const client = fakeClient({ commits: [commit('a1', 'wip')] })
      await expect(runMergeCheck({ event: squash('feat: add x (pull request #1)\n'), client })).resolves.toEqual({ success: true, message: 'All 4 checks passed.' })
    })

    test('a squash message that breaks the rules blocks the merge', async () => {
      const client = fakeClient({ commits: [commit('a1', 'feat: add x')] })
      const result = await runMergeCheck({ event: squash('Merged in feature/add-x (pull request #1)\n', 'squash_fast_forward'), client })
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/^Squash message failed \(1 of 4 checks\)\. Merge message: CC001 /)
    })

    test('the message is checked as a file, without a config too', async () => {
      const run = jest.spyOn(cli, 'runCli')
      const client = fakeClient({ commits: [commit('a1', 'feat: add x')], config: null })
      await runMergeCheck({ event: event('on-merge', { mergeStrategy: 'squash' }), client })
      expect(run.mock.calls[0][0].files).toEqual([{ path: '.commit-check-message', text: '' }])
      expect(run.mock.calls[0][0].argv.slice(0, 1)).toEqual(['.commit-check-message'])
    })
  })

  describe('the App\'s own checks', () => {
    test('Jira: every commit needs a ticket, the head included', async () => {
      const client = fakeClient({
        commits: [commit('a1', 'feat: add x'), commit('a2', 'fix: ABC-1 tidy x', ['a1'])],
        config: CONFIG + '[jira]\nrequired = true\n'
      })
      const result = await runMergeCheck({ event: event(), client })
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/^1 earlier commit failed\. a1 "feat: add x": JIRA JIRA ticket reference not found/)
    })

    test('Jira on the squash message', async () => {
      const client = fakeClient({ commits: [commit('a1', 'feat: add x')], config: CONFIG + '[jira]\nrequired = true\n' })
      const result = await runMergeCheck({ event: event('on-merge', { mergeStrategy: 'squash', commitMessage: 'feat: add x\n' }), client })
      expect(result.message).toMatch(/^Jira failed/)
    })

    const rebase = CONFIG + '[branch]\nrequire_rebase_target = "main"\n'

    test('a head behind the rebase target fails CC202, decided from Bitbucket', async () => {
      const client = fakeClient({ commits: [commit('a1', 'feat: add x')], config: rebase, behind: 2 })
      const result = await runMergeCheck({ event: event(), client })
      expect(client.behindBy).toHaveBeenCalledWith('{ws}', '{repo}', 'main', 'a1')
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/CC202 Current branch is not rebased onto main \(2 commits behind\)/)
    })

    test('a warned rebase rule warns instead', async () => {
      const client = fakeClient({ commits: [commit('a1', 'feat: add x')], config: 'warn = ["CC202"]\n' + rebase, behind: 2 })
      await expect(runMergeCheck({ event: event(), client })).resolves.toMatchObject({ success: true })
    })

    test('a rebased head passes CC202', async () => {
      const client = fakeClient({ commits: [commit('a1', 'feat: add x')], config: rebase, behind: 0 })
      await expect(runMergeCheck({ event: event(), client })).resolves.toEqual({ success: true, message: 'All 4 checks passed.' })
    })

    test('a target that does not exist leaves the CLI\'s skip', async () => {
      const run = jest.spyOn(cli, 'runCli')
      const client = fakeClient({ commits: [commit('a1', 'feat: add x')], config: rebase, behind: null })
      await expect(runMergeCheck({ event: event(), client })).resolves.toEqual({ success: true, message: 'All 4 checks passed.' })
      const cc202 = JSON.parse((await run.mock.results[0].value).stdout).checks.find((c) => c.rule_id === 'CC202')
      expect(cc202).toMatchObject({ status: 'skip', reason: "rebase target 'main' not found" })
    })

    test('a comparison that fails is logged and leaves the CLI\'s verdict', async () => {
      const logger = quiet()
      const client = fakeClient({ commits: [commit('a1', 'feat: add x')], config: rebase, behind: new Error('HTTP 500') })
      await expect(runMergeCheck({ event: event(), client, logger })).resolves.toMatchObject({ success: true })
      expect(logger.warn).toHaveBeenCalledWith('Could not compare a1 with main: HTTP 500')
    })

    test('require_verified cannot be checked on Bitbucket, and says so as a skip', async () => {
      const client = fakeClient({ commits: [commit('a1', 'feat: add x')], config: CONFIG + 'require_verified = true\n' })
      await expect(runMergeCheck({ event: event(), client })).resolves.toEqual({ success: true, message: '4 of 5 checks passed, 1 skipped.' })
    })
  })

  test('the description\'s AI rules run when the config asks for them', async () => {
    const run = jest.spyOn(cli, 'runCli')
    const client = fakeClient({
      commits: [commit('a1', 'feat: add x')],
      config: CONFIG + 'ai_attribution = "forbid"\n[pull_request]\nbody_ai_attribution = true\n',
      pr: { description: '# Summary\r\n\r\nAdds x.\r\n\r\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\r\n' }
    })
    const result = await runMergeCheck({ event: event(), client })
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({
      argv: ['--ai-attribution-only', '--format', 'json', '--no-banner'],
      stdin: '# Summary\n\nAdds x.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'
    }))
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/PR description/)
  })

  test('a pull request longer than the cap says only the newest were checked', async () => {
    const client = fakeClient({ commits: [commit('a1', 'feat: add x')], more: true })
    await expect(runMergeCheck({ event: event(), client, maxCommits: 1 })).resolves.toEqual({
      success: true,
      message: 'All 4 checks passed. Only the newest 1 commits were checked.'
    })
  })
})
