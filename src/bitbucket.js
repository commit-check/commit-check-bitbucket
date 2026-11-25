/**
 * The few Bitbucket Cloud REST calls a merge check needs, made as the app
 * through Forge (`requestBitbucket`), so no token ever leaves Atlassian.
 * Repositories and workspaces are named by UUID, which is what a merge
 * check's event carries.
 *
 * https://developer.atlassian.com/cloud/bitbucket/rest/
 */

// Bitbucket's largest page size for commit listings.
const PAGE_LEN = 100

class BitbucketError extends Error {
  constructor (message, { status = null } = {}) {
    super(message)
    this.name = 'BitbucketError'
    this.status = status
  }
}

/**
 * `{uuid}` for a path segment: Bitbucket takes a UUID in braces where a
 * slug would go.
 * @param {string} uuid
 * @returns {string}
 */
function uuidSegment (uuid) {
  const bare = String(uuid || '').trim().replace(/^\{|\}$/g, '')
  if (!/^[0-9a-fA-F-]{36}$/.test(bare)) throw new BitbucketError(`Not a Bitbucket UUID: ${uuid}`)
  return encodeURIComponent(`{${bare}}`)
}

/**
 * Split a git author line, "Name <email>", the way Bitbucket reports it.
 * @param {string} raw
 * @returns {object} - { name, email }
 */
function parseAuthor (raw) {
  const text = String(raw || '').trim()
  const match = text.match(/^(.*?)\s*<([^<>]*)>$/)
  if (!match) return { name: text, email: '' }
  return { name: match[1].trim(), email: match[2].trim() }
}

/** Forge's own Bitbucket request, as the app. */
function forgeRequest (path, options) {
  const api = require('@forge/api')
  return api.asApp().requestBitbucket(api.assumeTrustedRoute(path), options)
}

class BitbucketClient {
  /**
   * @param {object} [params] - { request }: (path, options) => Response,
   *   Forge's requestBitbucket unless a test gives its own
   */
  constructor ({ request = forgeRequest } = {}) {
    this.request = request
  }

  /**
   * GET a path under /2.0/ as JSON (or text). Null on 404 when `optional`.
   */
  async get (path, { optional = false, text = false } = {}) {
    if (!path.startsWith('/2.0/')) throw new BitbucketError('Refusing a path off the API')
    const res = await this.request(path, { headers: { Accept: text ? 'text/plain' : 'application/json' } })
    if (res.status === 404 && optional) return null
    if (!res.ok) {
      throw new BitbucketError(`Bitbucket answered ${res.status} for ${path.split('?')[0]}`, { status: res.status })
    }
    return text ? res.text() : res.json()
  }

  repoPath (workspace, repository) {
    return `/2.0/repositories/${uuidSegment(workspace)}/${uuidSegment(repository)}`
  }

  /**
   * The pull request: title, description, branches and their commits.
   * @returns {Promise<object>} - { id, title, description, sourceBranch,
   *   sourceHash, destinationBranch, destinationHash }
   */
  async pullRequest (workspace, repository, id) {
    const pr = await this.get(`${this.repoPath(workspace, repository)}/pullrequests/${Number(id)}`)
    return {
      id: pr.id,
      title: String(pr.title || ''),
      description: String(pr.description || ''),
      sourceBranch: pr.source?.branch?.name || '',
      sourceHash: pr.source?.commit?.hash || '',
      destinationBranch: pr.destination?.branch?.name || '',
      destinationHash: pr.destination?.commit?.hash || ''
    }
  }

  /**
   * The pull request's commits, oldest first, at most `max` of the newest.
   * Bitbucket lists them newest first; a `next` link is followed only when
   * it stays on this repository's own listing.
   * @returns {Promise<object>} - { commits: [{ sha, message, parents,
   *   author: { name, email } }], more: whether older ones were left out }
   */
  async pullRequestCommits (workspace, repository, id, { max = PAGE_LEN } = {}) {
    const listing = `${this.repoPath(workspace, repository)}/pullrequests/${Number(id)}/commits`
    const listed = []
    let next = `${listing}?pagelen=${PAGE_LEN}`
    let more = false
    while (next) {
      const page = await this.get(next)
      for (const c of page.values || []) {
        if (listed.length >= max) {
          more = true
          break
        }
        listed.push({
          sha: c.hash,
          message: String(c.message || ''),
          parents: (c.parents || []).map((p) => p.hash),
          author: parseAuthor(c.author?.raw)
        })
      }
      if (more || !page.next) break
      if (listed.length >= max) {
        more = true
        break
      }
      const url = new URL(page.next)
      next = `${url.pathname}${url.search}`
      if (url.origin !== 'https://api.bitbucket.org' || !url.pathname.startsWith(listing)) {
        throw new BitbucketError('Refusing to follow a link off the pull request')
      }
    }
    return { commits: listed.reverse(), more }
  }

  /**
   * The first config file found at `paths` in a commit, or null.
   * @returns {Promise<object|null>} - { path, text }
   */
  async configFile (workspace, repository, hash, paths) {
    for (const rel of paths) {
      const encoded = rel.split('/').map(encodeURIComponent).join('/')
      const text = await this.get(`${this.repoPath(workspace, repository)}/src/${encodeURIComponent(hash)}/${encoded}`, { optional: true, text: true })
      if (text !== null) return { path: rel, text }
    }
    return null
  }

  /**
   * How many commits of `target` the commit `head` does not have, 0 when
   * the target's tip is an ancestor of the head. Counted up to one page:
   * a branch that far behind is reported as PAGE_LEN behind. Null when
   * the target branch does not exist.
   * @returns {Promise<number|null>}
   */
  async behindBy (workspace, repository, target, head) {
    const repo = this.repoPath(workspace, repository)
    const branch = await this.get(`${repo}/refs/branches/${encodeURIComponent(target)}`, { optional: true })
    const tip = branch && branch.target && branch.target.hash
    if (!tip) return null
    const page = await this.get(`${repo}/commits?include=${encodeURIComponent(tip)}&exclude=${encodeURIComponent(head)}&pagelen=${PAGE_LEN}`)
    return (page.values || []).length
  }
}

module.exports = { BitbucketClient, BitbucketError, parseAuthor, uuidSegment, PAGE_LEN }
