/**
 * The verdict a merge check shows: one plain-text paragraph, since Bitbucket
 * shows a single short message and no Markdown. It reads like the GitHub
 * App's check run: the title, then the first few failures (which commit,
 * which rule, what to do), then where the rules are explained.
 *
 * Also the checks the CLI does not make here, in the CLI's check shape:
 * the Jira reference and the rebase target, decided from Bitbucket.
 */

const RULES_URL = 'https://commit-check.com/rules/'
const CONFIG_URL = 'https://commit-check.com/configuration/'

// Rule IDs are allocated by scope: CC0xx message, CC1xx author, CC2xx
// branch, CC3xx push and files, CC4xx tag. The report counts scopes, not
// rules, the same convention the Action's and the GitHub App's reports use.
const SCOPE_BY_PREFIX = {
  CC0: 'Commit message',
  CC1: 'Author',
  CC2: 'Branch',
  CC3: 'Files',
  CC4: 'Tag'
}
const SCOPE_LABELS = { CC101: 'Author name', CC102: 'Author email' }
// The app's own checks, which have no CLI rule ID to take a scope from.
const APP_SCOPES = { JIRA: 'Jira', VERIFIED: 'Signature' }
// The CLI's reason for skipping CC202 when the target branch is not in the
// repository, which here it never is.
const TARGET_NOT_FOUND = /^rebase target '.*' not found$/

/**
 * Group per-rule entries into the scopes the report counts and lists.
 *
 * A scope's status is decided in order: any real failure makes it a
 * failure, even alongside a warning in the same scope (CC2xx covers both
 * `branch` and `merge_base`, so the two can disagree); short of that, any
 * warning makes it a warning; only when every entry skipped is it a skip;
 * otherwise it passed.
 * @param {object[]} checks - CLI-shaped check entries
 * @returns {object[]} - [{ group, label, status, entries, failures, warnings }]
 */
function groupScopes (checks, { messageLabel = SCOPE_BY_PREFIX.CC0 } = {}) {
  const byLabel = new Map()
  for (const check of checks) {
    const id = check.rule_id || ''
    const prefix = id.slice(0, 3)
    const group = check.scope || (prefix === 'CC0'
      ? messageLabel
      : SCOPE_BY_PREFIX[prefix] ||
        APP_SCOPES[id] || (check.check || 'Other').replace(/_/g, '-'))
    const label = check.scope || SCOPE_LABELS[id] || group
    if (!byLabel.has(label)) byLabel.set(label, { group, label, entries: [] })
    byLabel.get(label).entries.push(check)
  }
  return [...byLabel.values()].map((scope) => {
    const failures = scope.entries.filter((c) => c.status === 'fail')
    const warnings = scope.entries.filter((c) => c.status === 'warn')
    const status = failures.length > 0
      ? 'fail'
      : warnings.length > 0
        ? 'warn'
        : scope.entries.every((c) => c.status === 'skip') ? 'skip' : 'pass'
    return { ...scope, status, failures, warnings }
  })
}

/** First line of the rule's error, without a trailing `See <url>`. */
function plainError (check) {
  const first = String(check.error || '').split('\n')[0] || 'check failed'
  return first.replace(/\s*See https?:\/\/\S+\s*$/, '')
}

/**
 * What to do about a finding that has no ready-made fix, in one line: the
 * CLI's suggestion without the tails that only matter once the reader opens
 * the rule (the list of allowed types, the config key that exempts a branch).
 */
function advice (check) {
  const suggest = String(check.suggest || '').split('\n')[0]
  if (!suggest) return plainError(check)
  return suggest
    .replace(/^In the description, /, '')
    .replace(/(, where <type> is one of: .*|, or add the branch to .*)$/, '')
}

/**
 * The failed scopes as the subject of the title: "Commit message and
 * branch", "Commit message, branch and Jira". Sentence case — the first
 * label keeps its capital, the rest drop theirs, proper nouns excepted.
 * More than three would make the title too long, so it falls back to the
 * count there.
 * @param {object[]} failed - Scopes with status 'fail'
 * @returns {string|null} - The phrase, or null for the count form
 */
function failedPhrase (failed) {
  if (failed.length === 0 || failed.length > 3) return null
  const PROPER = new Set(['Jira'])
  const labels = failed.map((s, i) => (i === 0 || PROPER.has(s.label)) ? s.label : s.label.toLowerCase())
  return labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

/**
 * The earlier commits of a pull request whose own check fails: a policy
 * failure, or a check that could not run. Oldest first.
 * @param {object[]} earlier - [{ sha, position, total, subject, checks, error }]
 * @returns {object[]} - The failing ones, each with its failed rules
 */
function earlierFailures (earlier) {
  return earlier
    .map((commit) => ({
      ...commit,
      rules: groupScopes(commit.checks || []).flatMap((scope) => scope.failures)
    }))
    .filter((commit) => commit.error || commit.rules.length > 0)
    .sort((a, b) => a.position - b.position)
}

/**
 * The verdict and its title, as the GitHub App's check run titles it:
 * failure, or neutral when nothing is enforced (no config file) or nothing
 * was validated, else success. Earlier commits that fail fail the head too.
 * @returns {object} - { conclusion, title }
 */
function verdictTitle (checks, { configured = true, squash = null, earlier = [] } = {}) {
  const scopes = groupScopes(checks, squash ? { messageLabel: 'Squash message' } : {})
  const failed = scopes.filter((s) => s.status === 'fail')
  const warned = scopes.filter((s) => s.status === 'warn')
  const skipped = scopes.filter((s) => s.status === 'skip')
  const total = scopes.length
  const unit = total === 1 ? 'check' : 'checks'
  const warningWord = (n) => `${n} warning${n === 1 ? '' : 's'}`

  const count = `${failed.length} of ${total} ${unit}`
  const what = failedPhrase(failed)

  let conclusion, title
  if (failed.length > 0 && !configured) {
    conclusion = 'neutral'
    title = what ? `${what} would fail (${count}, not enforced)` : `${count} would fail (not enforced)`
  } else if (failed.length > 0) {
    conclusion = 'failure'
    title = what ? `${what} failed (${count})` : `${count} failed`
    if (warned.length > 0) title += `, ${warningWord(warned.length)}`
  } else if (total === 0 || skipped.length === total) {
    conclusion = 'neutral'
    title = total === 0 ? 'Nothing to check' : `All ${total} ${unit} skipped`
  } else if (warned.length > 0 || skipped.length > 0) {
    conclusion = 'success'
    const passed = total - skipped.length - warned.length
    const bits = [`${passed} of ${total} ${unit} passed`]
    if (warned.length > 0) bits.push(warningWord(warned.length))
    if (skipped.length > 0) bits.push(`${skipped.length} skipped`)
    title = bits.join(', ')
  } else {
    conclusion = 'success'
    title = `All ${total} ${unit} passed`
  }

  const behind = earlierFailures(earlier)
  if (behind.length > 0) {
    const commitsWord = `${behind.length} earlier commit${behind.length === 1 ? '' : 's'}`
    if (!configured) {
      conclusion = 'neutral'
      const failing = failed.length > 0 ? `${what || count} would fail, and ${commitsWord}` : `${commitsWord} would fail`
      title = `${failing} (not enforced)`
    } else {
      conclusion = 'failure'
      title = failed.length > 0 ? `${title}; ${commitsWord} failed` : `${commitsWord} failed`
    }
  }
  return { conclusion, title }
}

/**
 * The verdict as one paragraph. The title, then the first few failures — which commit,
 * which rule, what to do — then where the rules are explained.
 *
 * @param {object[]} checks - The head's entries (or the squash message's)
 * @param {object} [options] - { configured, squash, earlier }, plus
 *   { headSha, headSubject, maxFindings, maxLength, newestOnly }:
 *   the head commit the entries are for, how many failures to name, a cap
 *   on the length, and — when older commits were left out — how many of
 *   the newest were checked
 * @returns {object} - { conclusion, title, message }
 */
function buildPlainReport (checks, { configured = true, squash = null, earlier = [], headSha = '', headSubject = '', maxFindings = 3, maxLength = 1000, newestOnly = 0 } = {}) {
  const { conclusion, title } = verdictTitle(checks, { configured, squash, earlier })
  const where = (sha, subject) => {
    if (squash) return 'Merge message'
    const short = String(sha || '').slice(0, 7)
    const first = String(subject || '').split('\n')[0].trim()
    const shown = first.length > 50 ? `${first.slice(0, 49)}…` : first
    return [short, shown && `"${shown}"`].filter(Boolean).join(' ') || 'Head commit'
  }
  const finding = (place, check) => {
    const error = plainError(check)
    const tip = advice(check)
    const rule = check.rule_id || String(check.check || '').replace(/_/g, '-')
    const said = [rule, error.replace(/\.$/, '')].filter(Boolean).join(' ')
    return `${place}: ${said}${tip && tip !== error ? ` (${tip.replace(/\.$/, '')})` : ''}.`
  }

  const findings = []
  for (const commit of earlierFailures(earlier)) {
    const place = where(commit.sha, commit.subject)
    if (commit.error) findings.push(`${place}: could not be checked.`)
    for (const rule of commit.rules) findings.push(finding(place, rule))
  }
  for (const scope of groupScopes(checks, squash ? { messageLabel: 'Squash message' } : {})) {
    for (const rule of scope.failures) findings.push(finding(where(headSha, headSubject), rule))
  }

  const parts = [`${title}.`]
  parts.push(...findings.slice(0, maxFindings))
  if (findings.length > maxFindings) parts.push(`And ${findings.length - maxFindings} more.`)
  if (newestOnly > 0) parts.push(`Only the newest ${newestOnly} commits were checked.`)
  if (!configured && findings.length > 0) parts.push(`Add a cchk.toml to enforce these rules: ${CONFIG_URL}`)
  else if (findings.length > 0) parts.push(`Rules: ${RULES_URL}`)

  let message = parts.join(' ')
  if (message.length > maxLength) message = `${message.slice(0, maxLength - 1)}…`
  return { conclusion, title, message }
}

/**
 * The branch a repository requires its branches to be rebased onto
 * ([branch] require_rebase_target), as a plain name. The CLI accepts the
 * value with regex anchors and strips them the same way.
 * @param {object} config - Parsed config
 * @returns {string|null}
 */
function rebaseTarget (config) {
  const raw = config && config.branch && config.branch.require_rebase_target
  if (typeof raw !== 'string') return null
  const name = raw.replace(/^\^/, '').replace(/\$$/, '').trim()
  return name || null
}

/**
 * The CC202 verdict, decided from Bitbucket's own history: there is no
 * repository here, so the CLI's merge-base rule has nothing to compare
 * against. "Rebased onto the target" means the target's tip is an
 * ancestor of the head, which is what behindBy === 0 says.
 * @param {object} params - { target, branch, behindBy }
 * @returns {object} - CLI-shaped check entry
 */
function mergeBaseCheck ({ target, branch, behindBy }) {
  const rebased = behindBy === 0
  return {
    rule_id: 'CC202',
    check: 'merge_base',
    status: rebased ? 'pass' : 'fail',
    value: branch,
    error: rebased ? '' : `Current branch is not rebased onto ${target} (${behindBy} commit${behindBy === 1 ? '' : 's'} behind)`,
    suggest: rebased ? '' : `Rebase or merge with ${target}`,
    docs_url: `${RULES_URL}#cc202`
  }
}

/**
 * Put this app's CC202 verdict in place of the CLI's. The CLI cannot reach
 * one here: the target branch is not in the commits it is given, so it
 * reports the rule as skipped ("rebase target 'main' not found"). A skip for any other reason (an ignored author) is left
 * alone: the author was exempted, so no verdict applies.
 * @param {object[]} checks - CLI-shaped check entries
 * @param {object} entry - From mergeBaseCheck
 * @param {object} [options] - { warned }: whether the config lists the
 *   rule under `warn`, which a skip does not show
 * @returns {object[]}
 */
function applyMergeBase (checks, entry, { warned = false } = {}) {
  const at = checks.findIndex((c) => c.rule_id === 'CC202')
  if (at === -1) return [...checks, entry]
  const cli = checks[at]
  if (cli.status === 'skip' && !TARGET_NOT_FOUND.test(String(cli.reason || ''))) return checks
  const out = checks.slice()
  // The CLI never ran this rule, but it still applied the config: a
  // `warn = ["CC202"]` or `warn = ["merge_base"]` entry shows up here as a
  // "warn" placeholder (or, skipped, only in the config). Carry that
  // severity into this app's own verdict, or a warned rule would fail the
  // run anyway.
  const isWarned = cli.status === 'warn' || warned
  const status = isWarned && entry.status === 'fail' ? 'warn' : entry.status
  out[at] = { ...entry, status }
  return out
}

/**
 * Whether the config lists a rule under its top-level `warn`, by ID or
 * by check name.
 * @param {object} config - Parsed config
 * @param {string[]} names - e.g. ['CC202', 'merge_base']
 * @returns {boolean}
 */
function isWarned (config, names) {
  const list = config && Array.isArray(config.warn) ? config.warn : []
  return list.some((name) => names.includes(name))
}

/**
 * Convert a Jira check result to the CLI's check shape.
 * @param {object} result - { valid, message, suggestion }
 * @returns {object} - CLI-shaped check entry
 */
function jiraToCheck (result) {
  return {
    rule_id: 'JIRA',
    check: 'jira-ticket',
    status: result.valid ? 'pass' : 'fail',
    value: '',
    error: result.valid ? '' : result.message,
    suggest: result.suggestion || '',
    docs_url: ''
  }
}

/**
 * How pull requests are checked: each commit on its own (the default), or
 * as the one squash commit a merge would land.
 * @param {object} config - Parsed config
 * @returns {'commits'|'squash'}
 */
function pullRequestMode (config) {
  const value = config && config.pull_request && config.pull_request.check
  return value === 'squash' ? 'squash' : 'commits'
}

/**
 * Whether the pull request description is checked against the AI rules:
 * `[pull_request] body_ai_attribution = true`.
 * @param {object} config - Parsed config
 * @returns {boolean}
 */
function checksDescription (config) {
  return Boolean(config && config.pull_request && config.pull_request.body_ai_attribution === true)
}

module.exports = {
  buildPlainReport,
  verdictTitle,
  groupScopes,
  rebaseTarget,
  mergeBaseCheck,
  applyMergeBase,
  isWarned,
  jiraToCheck,
  pullRequestMode,
  checksDescription,
  RULES_URL,
  CONFIG_URL
}
