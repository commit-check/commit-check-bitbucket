"""Run the commit-check CLI inside Pyodide, with git answered from data.

A Forge function has no git and no repository: Bitbucket hands it a pull
request through the REST API. The CLI asks git for everything it knows about
a commit, so this module answers those questions from the commits the API
returned, and runs the CLI's own ``main()`` exactly as a terminal would.
The rules, the config file handling and the JSON report are the CLI's, with
nothing re-implemented here.

Only the git commands the checks in use ask are answered (see ``_git``).
Anything else fails the way git fails on a missing object, and is listed in
the result's ``unsupported`` so that a CLI release that asks git something
new shows up in this app's tests instead of quietly skipping a rule.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import select
import shutil
import subprocess
import sys
import tomllib
import uuid

# The text of `git log --pretty=format:` placeholders this module renders.
_LITERALS = {"%%": "%", "%n": "\n", "%x00": "\x00", "%x09": "\t", "%x1f": "\x1f"}


def _split_message(message: str) -> tuple[str, str]:
    """git's subject (%s) and body (%b) of a raw message."""
    lines = message.split("\n")
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    subject = []
    while i < len(lines) and lines[i].strip():
        subject.append(lines[i].rstrip())
        i += 1
    while i < len(lines) and not lines[i].strip():
        i += 1
    return " ".join(subject), "\n".join(lines[i:])


class _Repository:
    """The commits of one pull request, as git would answer for them."""

    def __init__(self, commits: list[dict], head: str | None, branch: str):
        self.commits = {c["sha"]: c for c in commits}
        self.head = head
        self.branch = branch
        self.unsupported: list[str] = []

    def resolve(self, rev: str) -> str | None:
        rev = rev.removesuffix("^{commit}")
        if rev == "HEAD":
            return self.head
        if rev in (f"refs/heads/{self.branch}", self.branch) and self.branch:
            return self.head
        if rev in self.commits:
            return rev
        matches = [sha for sha in self.commits if len(rev) >= 4 and sha.startswith(rev)]
        return matches[0] if len(matches) == 1 else None

    def format(self, fmt: str, sha: str) -> str | None:
        commit = self.commits[sha]
        message = commit.get("message") or ""
        subject, body = _split_message(message)
        author = commit.get("author") or {}
        committer = commit.get("committer") or author
        fields = {
            "%H": sha,
            "%h": sha[:7],
            "%P": " ".join(commit.get("parents") or []),
            "%s": subject,
            "%b": body,
            "%B": message,
            "%an": author.get("name") or "",
            "%ae": author.get("email") or "",
            "%cn": committer.get("name") or "",
            "%ce": committer.get("email") or "",
        }
        out = []
        i = 0
        while i < len(fmt):
            if fmt[i] != "%":
                out.append(fmt[i])
                i += 1
                continue
            for token in sorted([*fields, *_LITERALS], key=len, reverse=True):
                if fmt.startswith(token, i):
                    out.append(fields.get(token, _LITERALS.get(token)))
                    i += len(token)
                    break
            else:
                return None
        return "".join(out)


def _git(repo: _Repository, args: list[str]) -> tuple[int, str, str]:
    """(exit code, stdout, stderr) of a git command, answered from repo."""
    missing = (128, "", "fatal: not available in a merge check")
    if args == ["rev-parse", "--git-dir"]:
        return 0, ".git\n", ""
    if args[:2] == ["rev-parse", "--verify"]:
        sha = repo.resolve(args[-1])
        if sha:
            return 0, sha + "\n", ""
        return (1, "", "") if "--quiet" in args else (128, "", "fatal: Needed a single revision\n")
    if args == ["branch", "--show-current"]:
        return 0, (repo.branch + "\n") if repo.branch else "", ""
    if args[:1] == ["config"]:
        # No git config: identities come from the commits themselves.
        return 1, "", ""
    if args[:3] == ["log", "-n", "1"] and len(args) == 5 and args[3].startswith("--pretty=format:"):
        sha = repo.resolve(args[4])
        if sha is None:
            return 128, "", f"fatal: bad revision '{args[4]}'"
        text = repo.format(args[3][len("--pretty=format:"):], sha)
        if text is not None:
            return 0, text, ""
    repo.unsupported.append(" ".join(["git", *args]))
    return missing


def _fake_run(repo: _Repository):
    real_run = subprocess.run

    def run(cmd, *args, **kwargs):
        if not isinstance(cmd, (list, tuple)) or not cmd or cmd[0] != "git":
            return real_run(cmd, *args, **kwargs)
        code, stdout, stderr = _git(repo, [str(a) for a in cmd[1:]])
        text = kwargs.get("encoding") or kwargs.get("text") or kwargs.get("universal_newlines")
        if not text:
            stdout, stderr = stdout.encode(), stderr.encode()
        captured = kwargs.get("capture_output") or kwargs.get("stdout") == subprocess.PIPE
        result = subprocess.CompletedProcess(
            list(cmd), code, stdout if captured else None, stderr if captured else None
        )
        if kwargs.get("check") and code != 0:
            raise subprocess.CalledProcessError(code, list(cmd), stdout, stderr)
        return result

    return run


@contextlib.contextmanager
def _patched(repo: _Repository, stdin: str | None):
    """git answered from repo, and stdin holding the piped text, if any."""
    saved = (subprocess.run, select.select, sys.stdin, sys.argv)
    fake_stdin = io.StringIO(stdin if stdin is not None else "")

    def fake_select(rlist, wlist, xlist, timeout=None):
        ready = [f for f in rlist if f is fake_stdin and stdin is not None]
        return ready, [], []

    subprocess.run = _fake_run(repo)
    select.select = fake_select
    sys.stdin = fake_stdin
    try:
        yield
    finally:
        subprocess.run, select.select, sys.stdin, sys.argv = saved


def run(request_json: str) -> str:
    """Run the CLI once.

    The request (JSON): ``argv`` (the CLI's arguments), ``stdin`` (piped
    text, or null), ``files`` ([{path, text}]: the config file at one of
    the paths the CLI searches, a message file), ``commits`` ([{sha, message, parents,
    author: {name, email}, committer?}]), ``head`` (the sha HEAD names) and
    ``branch`` (the branch HEAD is on).

    :returns: JSON {code, stdout, stderr, unsupported}
    """
    from commit_check import main as cli

    req = json.loads(request_json)
    repo = _Repository(req.get("commits") or [], req.get("head"), req.get("branch") or "")
    work = f"/tmp/commit-check-{uuid.uuid4().hex}"
    os.makedirs(os.path.join(work, ".git"))
    for item in req.get("files") or []:
        target = os.path.normpath(os.path.join(work, item["path"]))
        if not target.startswith(work + os.sep):
            raise ValueError(f"path outside the repository: {item['path']}")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as f:
            f.write(item["text"])

    out, err = io.StringIO(), io.StringIO()
    cwd = os.getcwd()
    try:
        with _patched(repo, req.get("stdin")):
            sys.argv = ["commit-check", *req.get("argv", [])]
            os.chdir(work)
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try:
                    code = cli.main()
                except SystemExit as e:
                    code = e.code if isinstance(e.code, int) else 2
    finally:
        os.chdir(cwd)
        shutil.rmtree(work, ignore_errors=True)
    return json.dumps({
        "code": code,
        "stdout": out.getvalue(),
        "stderr": err.getvalue(),
        "unsupported": repo.unsupported,
    })


def parse_config(text: str) -> str:
    """The config file as JSON, parsed by the same TOML reader as the CLI.

    :returns: JSON {config} or {error}
    """
    try:
        return json.dumps({"config": tomllib.loads(text)}, default=str)
    except tomllib.TOMLDecodeError as e:
        return json.dumps({"error": str(e)})


def version() -> str:
    from importlib.metadata import version as installed

    return installed("commit-check")
