const { BitbucketClient } = require('./bitbucket')
const mergeCheck = require('./mergeCheck')

const OUTAGE = 'Commit Check could not run, so nothing was validated. Re-run the check to try again.'
const LATE = 'Commit Check did not finish in time, so nothing was validated. Re-run the check to try again.'
// Bitbucket gives the whole check 25 seconds; answer before Forge stops the
// function, so the pull request says what happened.
const BUDGET_MS = 20000

/**
 * Both merge checks. Any failure to reach a verdict is a failed check,
 * never a pass: a check that could not run has validated nothing.
 * @param {object} event - The merge check's event
 * @param {object} [options] - { client, budgetMs, logger }, for tests
 * @returns {Promise<object>} - { success, message }
 */
async function run (event, { client = new BitbucketClient(), budgetMs = BUDGET_MS, logger = console } = {}) {
  const what = `${event?.repository?.uuid}#${event?.pullrequest?.id} (${event?.trigger?.type || 'unknown trigger'})`
  let timer
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs)
  })
  const work = mergeCheck.runMergeCheck({ event, client, logger }).then(
    (verdict) => ({ verdict }),
    (error) => ({ error })
  )
  try {
    const done = await Promise.race([work, late])
    if (done === null) {
      logger.warn(`Merge check ${what} ran past ${budgetMs} ms`)
      return { success: false, message: LATE }
    }
    if (done.error) {
      logger.error(`Merge check ${what} could not run: ${done.error.stack || done.error.message}`)
      return { success: false, message: OUTAGE }
    }
    logger.info(`Merge check ${what}: ${done.verdict.success ? 'pass' : 'fail'}${ruleCodes(done.verdict.message)}`)
    return done.verdict
  } finally {
    clearTimeout(timer)
  }
}

// The rule codes a verdict names, for the log: enough to tell why a check
// failed without writing anyone's commit messages into the app's logs.
function ruleCodes (message) {
  const codes = [...new Set(String(message).match(/\bCC\d{3}\b/g) || [])]
  return codes.length ? ` (${codes.join(', ')})` : ''
}

// Forge calls the handler with (event, context).
exports.run = (event) => run(event)
exports.runWith = run
exports.OUTAGE = OUTAGE
exports.LATE = LATE
