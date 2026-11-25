// The Bitbucket REST calls, against a stand-in for Forge's requestBitbucket
// that answers from a table of paths.
const { BitbucketClient, BitbucketError, parseAuthor, uuidSegment } = require('../bitbucket')

const WS = '{02b941e3-cfaa-40f9-9a58-cec53e20bdc3}'
const REPO = '{2004b7b2-45fc-431b-a7e4-7e7073dfad50}'
const REPO_PATH = '/2.0/repositories/%7B02b941e3-cfaa-40f9-9a58-cec53e20bdc3%7D/%7B2004b7b2-45fc-431b-a7e4-7e7073dfad50%7D'

/** A request that answers `routes[path]` (JSON, or text when a string). */
function stand (routes) {
  return jest.fn(async (path) => {
    if (!(path in routes)) return { ok: false, status: 404 }
    const value = routes[path]
    if (typeof value === 'number') return { ok: false, status: value }
    return { ok: true, status: 200, json: async () => value, text: async () => value }
  })
}

const commit = (hash, message, parents, raw = 'Jo Doe <jo@example.com>') => ({
  hash, message, parents: parents.map((p) => ({ hash: p })), author: { raw }
})

describe('uuidSegment', () => {
  test('a UUID in braces, encoded for a path', () => {
    expect(uuidSegment('02b941e3-cfaa-40f9-9a58-cec53e20bdc3')).toBe('%7B02b941e3-cfaa-40f9-9a58-cec53e20bdc3%7D')
    expect(uuidSegment(WS)).toBe('%7B02b941e3-cfaa-40f9-9a58-cec53e20bdc3%7D')
  })

  test.each([['a slug', 'atlassian'], ['a path', '../x'], ['nothing', undefined]])('refuses %s', (_, value) => {
    expect(() => uuidSegment(value)).toThrow(BitbucketError)
  })
})

describe('parseAuthor', () => {
  test.each([
    ['Jo Doe <jo@example.com>', { name: 'Jo Doe', email: 'jo@example.com' }],
    ['  jo  <jo@example.com> ', { name: 'jo', email: 'jo@example.com' }],
    ['<jo@example.com>', { name: '', email: 'jo@example.com' }],
    ['Jo Doe', { name: 'Jo Doe', email: '' }],
    [undefined, { name: '', email: '' }]
  ])('%s', (raw, expected) => {
    expect(parseAuthor(raw)).toEqual(expected)
  })
})

describe('BitbucketClient', () => {
  test('the default request is Forge\'s, as the app, on a trusted route', async () => {
    jest.resetModules()
    const requestBitbucket = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 1 }) }))
    jest.doMock('@forge/api', () => ({ asApp: () => ({ requestBitbucket }), assumeTrustedRoute: (p) => ({ trusted: p }) }))
    try {
      const { BitbucketClient: Client } = require('../bitbucket')
      await new Client().pullRequest(WS, REPO, 1)
      expect(requestBitbucket).toHaveBeenCalledWith({ trusted: `${REPO_PATH}/pullrequests/1` }, { headers: { Accept: 'application/json' } })
    } finally {
      jest.dontMock('@forge/api')
    }
  })

  test('a path off the API is refused before any request', async () => {
    const request = stand({})
    await expect(new BitbucketClient({ request }).get('https://evil.example.com/x')).rejects.toThrow('Refusing a path off the API')
    expect(request).not.toHaveBeenCalled()
  })

  test('the pull request, flattened', async () => {
    const request = stand({
      [`${REPO_PATH}/pullrequests/7`]: {
        id: 7,
        title: 'feat: x',
        description: 'Adds x',
        source: { branch: { name: 'feature/x' }, commit: { hash: 'abc' } },
        destination: { branch: { name: 'main' }, commit: { hash: 'def' } }
      }
    })
    await expect(new BitbucketClient({ request }).pullRequest(WS, REPO, 7)).resolves.toEqual({
      id: 7,
      title: 'feat: x',
      description: 'Adds x',
      sourceBranch: 'feature/x',
      sourceHash: 'abc',
      destinationBranch: 'main',
      destinationHash: 'def'
    })
  })

  test('a pull request with nothing filled in', async () => {
    const request = stand({ [`${REPO_PATH}/pullrequests/7`]: { id: 7 } })
    await expect(new BitbucketClient({ request }).pullRequest(WS, REPO, 7)).resolves.toEqual({
      id: 7, title: '', description: '', sourceBranch: '', sourceHash: '', destinationBranch: '', destinationHash: ''
    })
  })

  test('an error answer names the status and the path, without the query', async () => {
    const request = stand({ [`${REPO_PATH}/pullrequests/1/commits?pagelen=100`]: 403 })
    const err = await new BitbucketClient({ request }).pullRequestCommits(WS, REPO, 1).catch((e) => e)
    expect(err).toBeInstanceOf(BitbucketError)
    expect(err.status).toBe(403)
    expect(err.message).toBe(`Bitbucket answered 403 for ${REPO_PATH}/pullrequests/1/commits`)
  })

  describe('pullRequestCommits', () => {
    const page1 = `${REPO_PATH}/pullrequests/1/commits?pagelen=100`
    const page2 = `${REPO_PATH}/pullrequests/1/commits?pagelen=100&page=2`

    test('oldest first, across pages, with their authors and parents', async () => {
      const request = stand({
        [page1]: { values: [commit('c3', 'third', ['c2']), commit('c2', 'second', ['c1'])], next: `https://api.bitbucket.org${page2}` },
        [page2]: { values: [commit('c1', 'first', [], 'jo')] }
      })
      const { commits, more } = await new BitbucketClient({ request }).pullRequestCommits(WS, REPO, 1)
      expect(more).toBe(false)
      expect(commits).toEqual([
        { sha: 'c1', message: 'first', parents: [], author: { name: 'jo', email: '' } },
        { sha: 'c2', message: 'second', parents: ['c1'], author: { name: 'Jo Doe', email: 'jo@example.com' } },
        { sha: 'c3', message: 'third', parents: ['c2'], author: { name: 'Jo Doe', email: 'jo@example.com' } }
      ])
    })

    test('a commit with no message, parents or author', async () => {
      const request = stand({ [page1]: { values: [{ hash: 'c1' }] } })
      const { commits } = await new BitbucketClient({ request }).pullRequestCommits(WS, REPO, 1)
      expect(commits).toEqual([{ sha: 'c1', message: '', parents: [], author: { name: '', email: '' } }])
    })

    test('a page without values is empty', async () => {
      const request = stand({ [page1]: {} })
      await expect(new BitbucketClient({ request }).pullRequestCommits(WS, REPO, 1)).resolves.toEqual({ commits: [], more: false })
    })

    test('the newest `max` are kept, and the rest reported as left out', async () => {
      const request = stand({ [page1]: { values: [commit('c3', '3', []), commit('c2', '2', []), commit('c1', '1', [])] } })
      const { commits, more } = await new BitbucketClient({ request }).pullRequestCommits(WS, REPO, 1, { max: 2 })
      expect(commits.map((c) => c.sha)).toEqual(['c2', 'c3'])
      expect(more).toBe(true)
    })

    test('a page that ends exactly at `max`, with more pages, is reported as left out', async () => {
      const request = stand({ [page1]: { values: [commit('c2', '2', []), commit('c1', '1', [])], next: `https://api.bitbucket.org${page2}` } })
      const { commits, more } = await new BitbucketClient({ request }).pullRequestCommits(WS, REPO, 1, { max: 2 })
      expect(commits).toHaveLength(2)
      expect(more).toBe(true)
      expect(request).toHaveBeenCalledTimes(1)
    })

    test.each([
      ['another host', 'https://evil.example.com/2.0/x'],
      ['another listing', 'https://api.bitbucket.org/2.0/repositories/other/repo/pullrequests/1/commits?page=2']
    ])('a next link to %s is not followed', async (_, next) => {
      const request = stand({ [page1]: { values: [commit('c1', '1', [])], next } })
      await expect(new BitbucketClient({ request }).pullRequestCommits(WS, REPO, 1)).rejects.toThrow('Refusing to follow a link off the pull request')
    })
  })

  describe('configFile', () => {
    test('the first path that exists, read as text at the commit', async () => {
      const request = stand({ [`${REPO_PATH}/src/def/.github/cchk.toml`]: '[commit]\n' })
      const client = new BitbucketClient({ request })
      await expect(client.configFile(WS, REPO, 'def', ['cchk.toml', '.github/cchk.toml'])).resolves.toEqual({ path: '.github/cchk.toml', text: '[commit]\n' })
      expect(request.mock.calls[0]).toEqual([`${REPO_PATH}/src/def/cchk.toml`, { headers: { Accept: 'text/plain' } }])
    })

    test('null when there is none', async () => {
      await expect(new BitbucketClient({ request: stand({}) }).configFile(WS, REPO, 'def', ['cchk.toml'])).resolves.toBeNull()
    })

    test('a failure other than 404 is not taken for "no config"', async () => {
      const request = stand({ [`${REPO_PATH}/src/def/cchk.toml`]: 500 })
      await expect(new BitbucketClient({ request }).configFile(WS, REPO, 'def', ['cchk.toml'])).rejects.toThrow('Bitbucket answered 500')
    })
  })

  describe('behindBy', () => {
    const branch = `${REPO_PATH}/refs/branches/main`
    const compare = `${REPO_PATH}/commits?include=tip&exclude=head&pagelen=100`

    test('the commits of the target the head does not have', async () => {
      const request = stand({ [branch]: { target: { hash: 'tip' } }, [compare]: { values: [{}, {}] } })
      await expect(new BitbucketClient({ request }).behindBy(WS, REPO, 'main', 'head')).resolves.toBe(2)
    })

    test('0 when it has them all', async () => {
      const request = stand({ [branch]: { target: { hash: 'tip' } }, [compare]: {} })
      await expect(new BitbucketClient({ request }).behindBy(WS, REPO, 'main', 'head')).resolves.toBe(0)
    })

    test('null when the target branch does not exist, or names no commit', async () => {
      await expect(new BitbucketClient({ request: stand({}) }).behindBy(WS, REPO, 'main', 'head')).resolves.toBeNull()
      await expect(new BitbucketClient({ request: stand({ [branch]: {} }) }).behindBy(WS, REPO, 'main', 'head')).resolves.toBeNull()
    })
  })
})
