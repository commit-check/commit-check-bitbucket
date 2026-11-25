<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/commit-check/.github/main/branding/banner-dark.png">
  <img src="https://raw.githubusercontent.com/commit-check/.github/main/branding/banner-light.png" alt="Commit Check">
</picture>

**Commit policy as code on Bitbucket Cloud pull requests, run entirely on Atlassian.**

[![CI](https://img.shields.io/github/actions/workflow/status/commit-check/commit-check-bitbucket/ci.yml?branch=main&labelColor=0b1620&label=CI)](https://github.com/commit-check/commit-check-bitbucket/actions/workflows/ci.yml)

[Docs](https://commit-check.com/) ·
[Rules](https://commit-check.com/rules/) ·
[CLI](https://github.com/commit-check/commit-check) ·
[GitHub Action](https://github.com/commit-check/commit-check-action) ·
[GitHub App](https://github.com/apps/commit-check)

</div>

A [Forge](https://developer.atlassian.com/platform/forge/) app that adds two
[custom merge checks](https://support.atlassian.com/bitbucket-cloud/docs/set-up-and-use-custom-merge-checks/)
to Bitbucket Cloud pull requests. It runs entirely on Atlassian: the
commit-check CLI runs inside the Forge function in
[Pyodide](https://pyodide.org/) (Python compiled to WebAssembly), and the pull
request is read through Forge. Nothing is sent anywhere else, and there is no
server of ours to keep running. It is the same CLI release as the GitHub App,
the Action and the pre-commit hook, so the rules and the config file are the
same everywhere.

| Check | Runs | Checks |
|---|---|---|
| **Commit Check** | on every push to the pull request | every commit's message and author, the branch name on the head, and the description's AI rules when `[pull_request] body_ai_attribution = true` |
| **Commit Check merge message** | when someone presses Merge | the message a squash merge is about to land (other strategies land the commits already checked) |

The rules come from `cchk.toml` (or `commit-check.toml`, `.github/cchk.toml`,
`.github/commit-check.toml`) on the **destination** branch, so a pull request
cannot loosen the rules it is checked against. Without a config file the
defaults apply and nothing is blocked. `[jira]` and `require_rebase_target`
work as on GitHub; `require_verified` shows as skipped, since Bitbucket does
not tell apps whether a commit is verified. `[pull_request] check = "squash"`
leaves the pull request check passing and checks the squash message at merge.
`inherit_from` cannot fetch a parent config here, since the app makes no
outside requests; the CLI notes it and runs on the file's own settings.

**Blocking a merge needs Bitbucket Premium.** On other plans a failed check is
shown on the pull request but does not stop the merge (Atlassian's rule for
every custom merge check).

## How it works

```
Bitbucket ──event──▶ Forge function (src/index.js)
                       │ read the PR, its commits and the config (requestBitbucket, as the app)
                       │ run commit-check in Pyodide for each commit (src/cli.js)
                       │   git questions answered from those commits (python/commit_check_forge.py)
                       │ add Jira and the rebase target, write the verdict (src/report.js)
          ◀──────────── { success, message }
```

A merge check has 25 seconds and no checkout. The CLI asks git about each
commit (`git log --pretty=format:%s`, `git branch --show-current`, ...), so
`python/commit_check_forge.py` answers those questions from the commits
Bitbucket's API returned and runs the CLI's own `main()`. A git command it
does not know fails as git fails on a missing object and is logged, and the
tests run every case through the real CLI on a real repository as well, so a
CLI release that asks git something new shows up there first.

Loading Pyodide and the CLI takes about two seconds on a cold start; after
that a commit takes a few milliseconds. The function answers within 20
seconds; a check that cannot finish, or cannot run at all, fails and says to
re-run it.

## Developing

```
npm ci
npm test                     # downloads the pinned CLI wheel, runs jest
npm run lint
npm run build                # lays out out/, the package `forge deploy` uploads
```

With the pinned CLI on `PATH` (`pipx install commit-check==<version>`), the
tests also compare every case with the real CLI.

The CLI version is `commitCheck.version` in `package.json`, with the wheel's
sha256 from PyPI next to it; bump both together. A new CLI release changes
what the checks report, so it is bumped by hand.

## Deploying

1. Install the Forge CLI and log in with an Atlassian API token:
   `npm install -g @forge/cli` then `forge login`.
2. Register the app, from this directory: `forge register "Commit Check"`.
   This writes the real `app.id` into `manifest.yml`; commit that change.
3. Build and deploy: `npm run build` then `forge deploy`.
   The package is built by hand (`app.package.bundler: manual@2026`, a Forge
   preview feature), because Forge's default bundler cannot ship Pyodide's
   WebAssembly.
4. Install in a test workspace: `forge install`, choosing Bitbucket and the
   workspace.
5. In Bitbucket, a workspace admin turns on **Custom merge checks** in the
   workspace settings; then a repository admin enables **Commit Check** (and
   **Commit Check merge message** for squash merges) under the repository's
   merge checks. On Premium, tick **Required** to block merges.
6. Open a pull request and push a commit. `forge logs` shows
   `Merge check {repo}#1 (on-code-pushed): pass`.

For production, `forge deploy -e production` and `forge install -e production`.
Atlassian lists Bitbucket Forge apps on the Marketplace as information only
(no install button, no billing); installs go through the app's distribution
link in the developer console. The Forge CLI's eligibility check shows whether the app
qualifies for Runs on Atlassian.

## Community

Questions and ideas go to [Discussions](https://github.com/commit-check/commit-check/discussions),
bugs to [Issues](https://github.com/commit-check/commit-check-bitbucket/issues).
Released under the
[MIT License](https://github.com/commit-check/commit-check-bitbucket/blob/main/LICENSE).
