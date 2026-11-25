const JiraChecker = require('./jira')
const report = require('./report')
const cli = require('./cli')

/**
 * Bitbucket Cloud merge checks: the verdict Bitbucket shows, as
 * `{ success, message }`.
 *
 * Bitbucket gives a merge check 25 seconds and no checkout, so the commits
 * come from the REST API and the commit-check CLI runs in Pyodide with git
 * answered from them (see cli.js). The report text and the checks the CLI
 * does not make (Jira, the rebase target) are in report.js and jira.js, and
 * read the same as the GitHub App's.
 *
 * Two triggers:
 * - `on-code-pushed` (and `on-reviewer-status-changed`): every commit of the
 *   pull request, the branch name on the head, and the description's AI
 *   rules when the config asks for them. The verdict is the head's, with the
 *   earlier commits' failures folded in, as on GitHub.
 * - `on-merge`: the message a squash merge is about to land, which Bitbucket
 *   hands over in the event. Other strategies land the commits already
 *   checked before the merge, so there is nothing new to check.
 *
 * The rules come from the config file on the destination branch, not the
 * pull request's own: a merge check gates what reaches that branch, and a
 * pull request must not be able to loosen the rules it is checked against.
 */

const SQUASH_STRATEGIES = new Set(['squash', 'squash_fast_forward'])
// Where the CLI looks for its config, in its order.
const CONFIG_PATHS = ['cchk.toml', 'commit-check.toml', '.github/cchk.toml', '.github/commit-check.toml']
// One page of Bitbucket's commit listing. A pull request with more has its
// newest ones checked, and the verdict says so.
const DEFAULT_MAX_COMMITS = 100
const JSON_ARGS = ['--format', 'json', '--no-banner']
// The CLI drops `#` lines from a message file, as git does from a commit
// message; the squash message is checked the way it would be committed.
const MESSAGE_FILE = '.commit-check-message'
const DESCRIPTION_SCOPE = 'PR description'

class ConfigFileError extends Error {
  constructor (message, path) {
    super(message)
    this.name = 'ConfigFileError'
    this.path = path
  }
}

/**
 * Verdict for an event.
 * @param {object} params - { event, client, maxCommits, logger }: the merge
 *   check's event ({ workspace, repository, pullrequest, trigger,
 *   mergeProperties }) and a BitbucketClient
 * @returns {Promise<object>} - { success, message }
 */
async function runMergeCheck ({ event, client, maxCommits = DEFAULT_MAX_COMMITS, logger = console }) {
  const workspace = event.workspace && event.workspace.uuid
  const repository = event.repository && event.repository.uuid
  const id = event.pullrequest && event.pullrequest.id
  const onMerge = event.trigger && event.trigger.type === 'on-merge'
  const strategy = event.mergeProperties && event.mergeProperties.mergeStrategy

  if (onMerge && !SQUASH_STRATEGIES.has(strategy)) {
    return {
      success: true,
      message: `Nothing new to check: a ${strategy ? strategy.replace(/_/g, ' ') : 'non-squash'} merge lands the commits the pull request check already checked.`
    }
  }

  const pr = await client.pullRequest(workspace, repository, id)
  const [config, listed] = await Promise.all([
    client.configFile(workspace, repository, pr.destinationHash || pr.destinationBranch, CONFIG_PATHS),
    client.pullRequestCommits(workspace, repository, id, { max: maxCommits })
  ])
  const commits = listed.commits
  if (commits.length === 0) return { success: true, message: 'Nothing to check: the pull request has no commits.' }

  let parsed = {}
  if (config) {
    const read = await cli.parseConfig(config.text)
    if (read.error) return configError(config.path, read.error)
    parsed = read.config
  }
  const configured = config !== null
  const head = commits[commits.length - 1]
  const check = (argv, extra = {}) => run({
    argv: [...argv, ...JSON_ARGS],
    files: config ? [config] : [],
    commits,
    head: head.sha,
    branch: pr.sourceBranch || `pull-request-${id}`,
    ...extra
  }, { config, logger })

  try {
    if (onMerge) {
      // Bitbucket cuts the message at 1000 characters; the subject and the
      // trailers that matter are well inside that.
      const message = String(event.mergeProperties.commitMessage || '')
      let checks = (await check([MESSAGE_FILE, '-m', '-n', '-e', '-b'], {
        files: [...(config ? [config] : []), { path: MESSAGE_FILE, text: message }]
      })).checks
      checks = await withAppChecks({ checks, parsed, message, client, workspace, repository, pr, headSha: head.sha, logger })
      return verdict(report.buildPlainReport(checks, { configured, squash: { note: '' } }))
    }

    if (report.pullRequestMode(parsed) === 'squash') {
      return {
        success: true,
        message: 'Checked at merge: this repository checks the squash message (check = "squash"), so enable the Commit Check merge-message check.'
      }
    }

    const results = new Map()
    for (const commit of commits) {
      const isHead = commit === head
      let checks = (await check(['--rev', commit.sha, '-m', '-n', '-e', ...(isHead ? ['-b'] : [])])).checks
      if (isHead) {
        checks = await withAppChecks({ checks, parsed, message: commit.message, client, workspace, repository, pr, headSha: commit.sha, logger })
      } else if (parsed.jira && parsed.jira.required) {
        checks.push(report.jiraToCheck(JiraChecker.check(commit.message, parsed.jira)))
      }
      results.set(commit.sha, checks)
    }

    let headChecks = results.get(head.sha)
    if (report.checksDescription(parsed)) {
      const body = pr.description.replace(/\r\n/g, '\n').trim()
      const described = await check(['--ai-attribution-only'], { stdin: body })
      headChecks = [...headChecks, ...described.checks.map((check) => ({ ...check, scope: DESCRIPTION_SCOPE }))]
    }

    const earlier = commits.filter((c) => c !== head).map((c, i) => ({
      sha: c.sha,
      position: i + 1,
      total: commits.length,
      subject: String(c.message || '').split('\n')[0].trim(),
      checks: results.get(c.sha),
      error: false
    }))
    return verdict(report.buildPlainReport(headChecks, {
      configured,
      earlier,
      headSha: head.sha,
      headSubject: head.message,
      newestOnly: listed.more ? maxCommits : 0
    }))
  } catch (error) {
    if (error instanceof ConfigFileError) return configError(error.path, error.message)
    throw error
  }
}

/**
 * One CLI run, as its parsed JSON report. A CLI that refuses to start
 * (`Error: ...`, exit 2) is refusing the config file, which is the
 * repository's to fix and not an outage.
 */
async function run (request, { config, logger }) {
  const res = await cli.runCli(request)
  if (res.unsupported.length > 0) {
    logger.warn(`commit-check asked git what this app cannot answer: ${res.unsupported.join('; ')}`)
  }
  try {
    return JSON.parse(res.stdout)
  } catch (err) {
    const printed = [res.stderr, res.stdout].map((s) => s.trim()).find(Boolean) || ''
    if (printed.startsWith('Error:')) throw new ConfigFileError(printed.slice(0, 500), config && config.path)
    throw new Error(`commit-check produced no parsable JSON (exit ${res.code}): ${printed.slice(0, 500)}`)
  }
}

/**
 * The checks the CLI cannot make here, added to the head's (or the squash
 * message's) entries: the Jira reference, the rebase rule decided from
 * Bitbucket's own history, and a skip for `require_verified`, which
 * Bitbucket gives apps no verdict for.
 */
async function withAppChecks ({ checks, parsed, message, client, workspace, repository, pr, headSha, logger }) {
  let out = checks
  if (parsed.jira && parsed.jira.required) out = [...out, report.jiraToCheck(JiraChecker.check(message, parsed.jira))]
  const target = report.rebaseTarget(parsed)
  if (target) {
    try {
      const behind = await client.behindBy(workspace, repository, target, headSha)
      if (behind !== null) {
        const entry = report.mergeBaseCheck({ target, branch: pr.sourceBranch, behindBy: behind })
        out = report.applyMergeBase(out, entry, { warned: report.isWarned(parsed, ['CC202', 'merge_base']) })
      }
    } catch (error) {
      logger.warn(`Could not compare ${headSha} with ${target}: ${error.message}`)
    }
  }
  if (parsed.commit && parsed.commit.require_verified === true) {
    out = [...out, {
      rule_id: 'VERIFIED',
      check: 'verified_commit',
      status: 'skip',
      value: '',
      error: 'Bitbucket does not tell apps whether a commit is verified',
      suggest: '',
      docs_url: ''
    }]
  }
  return out
}

function verdict ({ conclusion, message }) {
  return { success: conclusion !== 'failure', message }
}

function configError (file, reason) {
  const first = String(reason).trim().split('\n')[0].replace(/:$/, '')
  return {
    success: false,
    message: `Config file could not be parsed: ${file || 'the config file'}: ${first}`.slice(0, 1000)
  }
}

module.exports = { runMergeCheck, CONFIG_PATHS, SQUASH_STRATEGIES, DEFAULT_MAX_COMMITS }
