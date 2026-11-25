// The Forge handler: a verdict, or a failed check that says it is not one.
const handler = require('../index')
const mergeCheck = require('../mergeCheck')

const event = { repository: { uuid: '{repo}' }, pullrequest: { id: 1 }, trigger: { type: 'on-code-pushed' } }
const logger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })

afterEach(() => jest.restoreAllMocks())

test('the verdict is passed on, and logged', async () => {
  jest.spyOn(mergeCheck, 'runMergeCheck').mockResolvedValue({ success: true, message: 'All 4 checks passed.' })
  const log = logger()
  await expect(handler.runWith(event, { client: {}, logger: log })).resolves.toEqual({ success: true, message: 'All 4 checks passed.' })
  expect(log.info).toHaveBeenCalledWith('Merge check {repo}#1 (on-code-pushed): pass')
})

test('a failing verdict is logged as one', async () => {
  jest.spyOn(mergeCheck, 'runMergeCheck').mockResolvedValue({ success: false, message: 'x' })
  const log = logger()
  await handler.runWith({}, { client: {}, logger: log })
  expect(log.info).toHaveBeenCalledWith('Merge check undefined#undefined (unknown trigger): fail')
})

test('a failing verdict logs the rule codes it names, not the messages', async () => {
  jest.spyOn(mergeCheck, 'runMergeCheck').mockResolvedValue({
    success: false,
    message: 'Commit message failed (2 of 4 checks). abc1234 "fix stuff": CC001 ... CC202 ... CC001 ...'
  })
  const log = logger()
  await handler.runWith(event, { client: {}, logger: log })
  expect(log.info).toHaveBeenCalledWith('Merge check {repo}#1 (on-code-pushed): fail (CC001, CC202)')
})

test('a check that cannot run fails, saying nothing was validated', async () => {
  jest.spyOn(mergeCheck, 'runMergeCheck').mockRejectedValue(new Error('Bitbucket answered 500'))
  const log = logger()
  await expect(handler.runWith(event, { client: {}, logger: log })).resolves.toEqual({ success: false, message: handler.OUTAGE })
  expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/^Merge check \{repo\}#1 \(on-code-pushed\) could not run: Error: Bitbucket answered 500/))
})

test('an error without a stack is logged by its message', async () => {
  jest.spyOn(mergeCheck, 'runMergeCheck').mockRejectedValue({ message: 'odd' })
  const log = logger()
  await handler.runWith(event, { client: {}, logger: log })
  expect(log.error).toHaveBeenCalledWith('Merge check {repo}#1 (on-code-pushed) could not run: odd')
})

test('a check that runs past the budget answers in time', async () => {
  jest.spyOn(mergeCheck, 'runMergeCheck').mockReturnValue(new Promise(() => {}))
  const log = logger()
  await expect(handler.runWith(event, { client: {}, budgetMs: 10, logger: log })).resolves.toEqual({ success: false, message: handler.LATE })
  expect(log.warn).toHaveBeenCalledWith('Merge check {repo}#1 (on-code-pushed) ran past 10 ms')
})

test('the Forge entry point uses the real client and console', async () => {
  const run = jest.spyOn(mergeCheck, 'runMergeCheck').mockResolvedValue({ success: true, message: 'ok' })
  jest.spyOn(console, 'info').mockImplementation(() => {})
  await expect(handler.run(event)).resolves.toEqual({ success: true, message: 'ok' })
  expect(run.mock.calls[0][0].client.constructor.name).toBe('BitbucketClient')
  expect(run.mock.calls[0][0].logger).toBe(console)
})
