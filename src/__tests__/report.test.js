// The verdict text and the app's own checks, in the CLI's check shape.
const report = require('../report')

describe('CC202 from Bitbucket\'s history', () => {
  test('rebaseTarget strips the anchors the CLI strips', () => {
    expect(report.rebaseTarget({})).toBeNull()
    expect(report.rebaseTarget({ branch: { require_rebase_target: '' } })).toBeNull()
    expect(report.rebaseTarget({ branch: { require_rebase_target: 'main' } })).toBe('main')
    expect(report.rebaseTarget({ branch: { require_rebase_target: '^develop$' } })).toBe('develop')
  })

  test('behind by zero is a pass, anything else a failure that says how far', () => {
    const ok = report.mergeBaseCheck({ target: 'main', branch: 'feat/x', behindBy: 0 })
    expect(ok).toMatchObject({ rule_id: 'CC202', check: 'merge_base', status: 'pass', value: 'feat/x', error: '' })

    const bad = report.mergeBaseCheck({ target: 'main', branch: 'feat/x', behindBy: 3 })
    expect(bad.status).toBe('fail')
    expect(bad.error).toBe('Current branch is not rebased onto main (3 commits behind)')
    expect(bad.suggest).toBe('Rebase or merge with main')
    expect(bad.docs_url).toBe('https://commit-check.com/rules/#cc202')
  })

  test("applyMergeBase replaces the CLI's always-pass entry, appends when absent, leaves a skip", () => {
    const entry = report.mergeBaseCheck({ target: 'main', branch: 'b', behindBy: 2 })
    const cliPass = { rule_id: 'CC202', check: 'merge_base', status: 'pass', value: 'b', error: '', suggest: '', docs_url: '' }
    const other = { rule_id: 'CC201', check: 'branch', status: 'pass', value: 'b', error: '', suggest: '', docs_url: '' }

    expect(report.applyMergeBase([other, cliPass], entry)).toEqual([other, entry])
    expect(report.applyMergeBase([other], entry)).toEqual([other, entry])
    const skipped = { ...cliPass, status: 'skip', reason: 'author Jane is in [branch].ignore_authors' }
    expect(report.applyMergeBase([other, skipped], entry)).toEqual([other, skipped])
    const noReason = { ...cliPass, status: 'skip' }
    expect(report.applyMergeBase([other, noReason], entry)).toEqual([other, noReason])
  })

  // The App's clone never has the target branch, and the CLI says so with a
  // skip: that skip is exactly what the App's own verdict is for.
  test("applyMergeBase replaces the CLI's target-not-found skip", () => {
    const failing = report.mergeBaseCheck({ target: 'main', branch: 'b', behindBy: 2 })
    const notFound = { rule_id: 'CC202', check: 'merge_base', status: 'skip', value: '', error: '', suggest: '', docs_url: '', reason: "rebase target 'main' not found" }

    expect(report.applyMergeBase([notFound], failing)).toEqual([failing])
    // A skip carries no severity, so the config's `warn` is passed in.
    expect(report.applyMergeBase([notFound], failing, { warned: true })).toEqual([{ ...failing, status: 'warn' }])
    const passing = report.mergeBaseCheck({ target: 'main', branch: 'b', behindBy: 0 })
    expect(report.applyMergeBase([notFound], passing, { warned: true })).toEqual([passing])
  })

  test('isWarned reads the config\'s warn list by rule ID or check name', () => {
    expect(report.isWarned({ warn: ['CC202'] }, ['CC202', 'merge_base'])).toBe(true)
    expect(report.isWarned({ warn: ['merge_base'] }, ['CC202', 'merge_base'])).toBe(true)
    expect(report.isWarned({ warn: ['CC001'] }, ['CC202', 'merge_base'])).toBe(false)
    expect(report.isWarned({ warn: 'CC202' }, ['CC202'])).toBe(false)
    expect(report.isWarned(null, ['CC202'])).toBe(false)
  })

  test('applyMergeBase keeps a warned CC202 a warning, not a failure', () => {
    const failing = report.mergeBaseCheck({ target: 'main', branch: 'b', behindBy: 2 })
    const warned = { rule_id: 'CC202', check: 'merge_base', status: 'warn', value: 'b', error: '', suggest: '', docs_url: '' }

    const out = report.applyMergeBase([warned], failing)
    expect(out).toEqual([{ ...failing, status: 'warn' }])

    // A pass stays a pass regardless of the config's severity for this rule.
    const passing = report.mergeBaseCheck({ target: 'main', branch: 'b', behindBy: 0 })
    expect(report.applyMergeBase([warned], passing)).toEqual([passing])
  })
})

describe('pullRequestMode', () => {
  test('defaults to commits, and only "squash" changes it', () => {
    expect(report.pullRequestMode({})).toBe('commits')
    expect(report.pullRequestMode({ pull_request: { check: 'commits' } })).toBe('commits')
    expect(report.pullRequestMode({ pull_request: { check: 'title' } })).toBe('commits')
    expect(report.pullRequestMode({ pull_request: { check: 'squash' } })).toBe('squash')
  })
})

describe('checksDescription', () => {
  test('checksDescription: only body_ai_attribution = true', () => {
    expect(report.checksDescription({ pull_request: { body_ai_attribution: true } })).toBe(true)
    expect(report.checksDescription({ pull_request: { body_ai_attribution: 'true' } })).toBe(false)
    expect(report.checksDescription({})).toBe(false)
    expect(report.checksDescription(null)).toBe(false)
  })
})

describe('jiraToCheck', () => {
  test('maps a failing Jira result into the CLI check shape', () => {
    const check = report.jiraToCheck({
      valid: false,
      message: 'JIRA ticket reference not found',
      suggestion: 'Include JIRA ticket reference'
    })

    expect(check).toMatchObject({
      rule_id: 'JIRA',
      check: 'jira-ticket',
      status: 'fail',
      error: 'JIRA ticket reference not found',
      suggest: 'Include JIRA ticket reference',
      docs_url: ''
    })
  })

  test('maps a passing Jira result', () => {
    expect(report.jiraToCheck({ valid: true, message: 'found' }).status).toBe('pass')
  })
})

describe('buildPlainReport', () => {
  const entry = (ruleId, check, status, extra = {}) => ({ rule_id: ruleId, check, status, value: '', error: '', suggest: '', docs_url: '', ...extra })
  const bad = (n) => entry(`CC00${n}`, 'message', 'fail', { error: `Problem ${n}.`, suggest: `Do ${n}.` })

  test('a pass is the title alone', () => {
    expect(report.buildPlainReport([entry('CC001', 'message', 'pass')])).toEqual({ conclusion: 'success', title: 'All 1 check passed', message: 'All 1 check passed.' })
  })

  test('at most maxFindings findings, then how many more', () => {
    const { message } = report.buildPlainReport([bad(1), bad(2), entry('CC201', 'branch', 'fail', { error: 'Bad branch' })], { headSha: 'abcdef123456', headSubject: 'x', maxFindings: 2 })
    expect(message).toBe('Commit message and branch failed (2 of 2 checks). abcdef1 "x": CC001 Problem 1 (Do 1). abcdef1 "x": CC002 Problem 2 (Do 2). And 1 more. Rules: https://commit-check.com/rules/')
  })

  test('a long subject is cut, and a missing commit is the head commit', () => {
    const long = 'feat: ' + 'x'.repeat(60)
    expect(report.buildPlainReport([bad(1)], { headSubject: long }).message).toContain(`"${long.slice(0, 49)}…": CC001`)
    expect(report.buildPlainReport([bad(1)]).message).toContain('Head commit: CC001')
  })

  test('a finding without a rule ID is named by its check; advice equal to the error is not repeated', () => {
    const { message } = report.buildPlainReport([{ check: 'jira_ticket', status: 'fail', error: 'No ticket' }], { headSha: 'a1' })
    expect(message).toContain('a1: jira-ticket No ticket. ')
    expect(report.buildPlainReport([{ status: 'fail', error: 'Odd' }], { headSha: 'a1' }).message).toContain('a1: Odd. ')
  })

  test('an earlier commit that could not be checked says so', () => {
    const { message, conclusion } = report.buildPlainReport([entry('CC001', 'message', 'pass')], {
      earlier: [{ sha: 'e1', position: 1, total: 2, subject: 'old', checks: [], error: true }]
    })
    expect(conclusion).toBe('failure')
    expect(message).toContain('e1 "old": could not be checked.')
  })

  test('a squash message is named as the merge message', () => {
    const { message, title } = report.buildPlainReport([bad(1)], { squash: { note: '' }, headSha: 'abcdef1' })
    expect(title).toBe('Squash message failed (1 of 1 check)')
    expect(message).toBe('Squash message failed (1 of 1 check). Merge message: CC001 Problem 1 (Do 1). Rules: https://commit-check.com/rules/')
  })

  test('an earlier commit\'s failures come first, and a cut list says how many were checked', () => {
    const { message } = report.buildPlainReport([entry('CC001', 'message', 'pass', { value: 'feat: x' })], {
      earlier: [{ sha: 'e1e1e1e1e1', position: 1, total: 2, subject: 'old', checks: [bad(1)], error: false }],
      newestOnly: 100
    })
    expect(message).toBe('1 earlier commit failed. e1e1e1e "old": CC001 Problem 1 (Do 1). Only the newest 100 commits were checked. Rules: https://commit-check.com/rules/')
  })

  test('without a config file the findings say how to enforce them', () => {
    const { conclusion, message } = report.buildPlainReport([bad(1)], { configured: false, headSha: 'a1' })
    expect(conclusion).toBe('neutral')
    expect(message).toBe('Commit message would fail (1 of 1 check, not enforced). a1: CC001 Problem 1 (Do 1). Add a cchk.toml to enforce these rules: https://commit-check.com/configuration/')
  })

  test('the message is capped', () => {
    const { message } = report.buildPlainReport([bad(1), bad(2)], { maxLength: 40 })
    expect(message).toHaveLength(40)
    expect(message.endsWith('…')).toBe(true)
  })
})

describe('verdictTitle', () => {
  const entry = (ruleId, status, extra = {}) => ({ rule_id: ruleId, check: 'x', status, ...extra })
  const bad = (n) => entry(`CC00${n}`, 'fail')
  const old = (checks, extra = {}) => ({ sha: 'e1', position: 1, total: 2, subject: 'old', checks, error: false, ...extra })

  test.each([
    ['nothing at all', [], {}, 'neutral', 'Nothing to check'],
    ['every check skipped', [entry('CC001', 'skip')], {}, 'neutral', 'All 1 check skipped'],
    ['two warnings', [entry('CC001', 'warn'), entry('CC201', 'warn'), entry('CC101', 'pass')], {}, 'success', '1 of 3 checks passed, 2 warnings'],
    ['a warning and a skip', [entry('CC001', 'warn'), entry('CC201', 'skip'), entry('CC101', 'pass')], {}, 'success', '1 of 3 checks passed, 1 warning, 1 skipped'],
    ['a failure beside a warning', [bad(1), entry('CC201', 'warn')], {}, 'failure', 'Commit message failed (1 of 2 checks), 1 warning'],
    ['more failed scopes than a title names', [bad(1), entry('CC201', 'fail'), entry('CC101', 'fail'), entry('CC102', 'fail')], {}, 'failure', '4 of 4 checks failed'],
    ['the same, not enforced', [bad(1), entry('CC201', 'fail'), entry('CC101', 'fail'), entry('CC102', 'fail')], { configured: false }, 'neutral', '4 of 4 checks would fail (not enforced)'],
    ['a rule the app adds, without a scope of its own', [{ status: 'fail' }], {}, 'failure', 'Other failed (1 of 1 check)'],
    ['earlier commits only', [entry('CC001', 'pass')], { earlier: [old([bad(1)]), old([bad(2)], { sha: 'e2', position: 2 })] }, 'failure', '2 earlier commits failed'],
    ['the head and an earlier commit', [bad(1)], { earlier: [old([bad(1)])] }, 'failure', 'Commit message failed (1 of 1 check); 1 earlier commit failed'],
    ['an earlier commit, not enforced', [entry('CC001', 'pass')], { configured: false, earlier: [old([bad(1)])] }, 'neutral', '1 earlier commit would fail (not enforced)'],
    ['the head and an earlier commit, not enforced', [bad(1)], { configured: false, earlier: [old([bad(1)])] }, 'neutral', 'Commit message would fail, and 1 earlier commit (not enforced)'],
    ['four failed scopes and an earlier commit, not enforced', [bad(1), entry('CC201', 'fail'), entry('CC101', 'fail'), entry('CC102', 'fail')], { configured: false, earlier: [old([bad(1)])] }, 'neutral', '4 of 4 checks would fail, and 1 earlier commit (not enforced)'],
    ['an earlier commit with no checks that passed', [entry('CC001', 'pass')], { earlier: [old(undefined)] }, 'success', 'All 1 check passed']
  ])('%s', (_, checks, options, conclusion, title) => {
    expect(report.verdictTitle(checks, options)).toEqual({ conclusion, title })
  })

  test('the defaults are a configured repository with no earlier commits', () => {
    expect(report.verdictTitle([bad(1)])).toEqual({ conclusion: 'failure', title: 'Commit message failed (1 of 1 check)' })
  })

  test('a failure without an error says only that it failed', () => {
    expect(report.buildPlainReport([bad(1)], { headSha: 'a1' }).message).toContain('a1: CC001 check failed.')
  })

  test('one commit behind is singular', () => {
    expect(report.mergeBaseCheck({ target: 'main', branch: 'b', behindBy: 1 }).error).toBe('Current branch is not rebased onto main (1 commit behind)')
  })
})
