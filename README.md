# cma-agent

Runs Configure My AI work on your own machine, using the Claude Code you already
installed and signed into — so a configuration can spend your Claude Pro or Max
plan instead of an API key.

## The one thing to understand

**Your Claude credential never leaves this machine.** The companion doesn't read
it, store it, or transmit it. Claude Code reads its own login from your OS
keychain when we spawn it, exactly as it does when you run `claude` yourself.

What Configure My AI stores is a routing target: this machine's name, the labels
you gave your Claude logins, and which one a given provider should use. There is
no secret on the server side to leak.

## Install

```sh
brew install 9thdesigns/tap/cma-agent
```

Or, without Homebrew — npm installs the git URL directly, so this is still one
line:

```sh
npm install -g https://github.com/9thdesigns/cma-agent
```

Homebrew pulls Node in as a dependency; npm assumes you already have Node 20+.
Either way you also need [Claude Code](https://claude.com/product/claude-code)
installed and signed in.

To uninstall: `brew uninstall cma-agent`, or
`npm uninstall -g @configuremyai/cma-agent`.

### Publishing

`bin/release-agent` in the main repository does the whole release: it mirrors
this directory into a public source repository, tags the version from
`package.json`, checksums the tarball GitHub generates for that tag, and commits
the filled-in formula to the tap.

It needs two repositories, both **public**, both empty to start with:

| Repository | Holds |
| --- | --- |
| `github.com/9thdesigns/cma-agent` | this directory, mirrored on each release |
| `github.com/9thdesigns/homebrew-tap` | `Formula/cma-agent.rb` |

The tap **must** be called `homebrew-tap`. That name is what lets Homebrew
resolve the short form `9thdesigns/tap`. (An earlier version of these docs said
`configuremyai/tap` — no such org, which is why `brew install` failed.)

```sh
bin/release-agent --dry-run   # render everything, push nothing
bin/release-agent             # publish
```

Then set these on the web app so the walkthrough and docs stop telling people to
build from source:

```sh
CMA_AGENT_INSTALL_COMMAND="brew install 9thdesigns/tap/cma-agent"
CMA_AGENT_UNINSTALL_COMMAND="brew uninstall cma-agent"
```

`agent/` here stays the source of truth — the public repository is a publish
target, overwritten on every release, so the two cannot drift.

The formula lives at `agent/homebrew/cma-agent.rb` with placeholders the script
fills. Edit that one, never the copy in the tap.

## Setup

```sh
cma-agent pair      # enter the code from /devices/setup
cma-agent start     # wait for work
```

`cma-agent status` shows pairing state, Claude Code version, and every Claude
login it can see.

## More than one Claude account

Each login lives in its own `CLAUDE_CONFIG_DIR`, so a work account and a personal
account never mix:

```sh
cma-agent claude:add --label "Work" --account you@work.com
cma-agent claude:add --label "Personal"
```

`--account` is optional and only used to show a masked hint (`y•••@work.com`) so
you can tell two logins apart in a dropdown. It is not read from Claude Code's
files, and it is not used for authentication.

Both labels then appear in the **Claude login** picker when you create an
Anthropic provider in the web app.

> **macOS note.** Claude Code stores credentials in the system Keychain, and how
> completely a per-profile `CLAUDE_CONFIG_DIR` isolates them can vary by Claude
> Code version. Run `cma-agent claude:scan` after adding a second login and check
> the reported state — if two profiles have collapsed onto the same account, you
> will see it there rather than discovering it when the wrong plan gets billed.

## Local repositories

The Code feature can work against a git repository that already exists on this
machine — its real history, real branches, real uncommitted changes — instead of
cloning one from GitHub. The turn then runs as Claude Code *inside* that
directory, so it reads and edits the actual files.

**Nothing is visible until you share a folder.** There is no default root and no
"scan my home directory" mode:

```sh
cma-agent repos:add ~/code      # share a folder of projects
cma-agent repos:add ~/work/api  # or a single repository
cma-agent repos:list            # what's shared, and what was found in it
cma-agent repos:remove ~/code   # stop sharing
```

Then in the web app: **Repo** tab → *Local repository* → find repositories →
pick one. The session's provider must be this machine.

What the server can then ask for, and nothing else:

| Request | What this machine does |
| --- | --- |
| `repos.list` | Lists git repositories inside shared folders (2 levels deep) |
| `git.summary` | Branch, working-tree status, last 20 commits, branch list |
| `git.log` | Commit history |
| `git.diff` | The working diff |
| `git.push` | Commits the working tree onto a branch and pushes it |

Every one of those resolves its path against the shared-folder list and refuses
anything outside it — symlinks resolved, `..` rejected. The server asking is a
request, not permission. `git` is invoked with an argument array, never a shell
string, so a hostile branch name is a bad branch name rather than a command.

The pull request itself is opened by the web app using your GitHub
authorization; this machine only pushes, using whatever git credentials you
already have. Neither side needs the other's secret.

Claude Code runs with `--permission-mode acceptEdits` when (and only when) a
job is anchored to a shared repository: it may edit files in that directory, it
is not given free rein over the machine. A plain chat completion gets no working
directory and no elevated mode.

## How a run works

1. The web app queues a prompt for this machine.
2. `cma-agent start` is long-polling, and claims it.
3. It runs `claude -p --output-format stream-json --verbose` under the chosen
   profile — in the linked repository's directory, if the job has one.
4. As events arrive it posts a heartbeat every ~10s saying what it is doing.
   The web app shows that as a live ticker, and it is what tells the server the
   run is alive.
5. The answer and token counts go back; the queued copy is deleted.

Connections are outbound only. Nothing listens, no ports open, no firewall rules.

### A run is bounded by silence, not by duration

There is no "maximum run length" setting, on purpose. Every value we tried was
wrong: a coding turn is four seconds or forty minutes, and nothing about the
request tells you which. Streaming is what makes the question answerable —
Claude Code emits events continuously, so we can ask *"has this gone quiet?"*
instead of *"has this taken too long?"*. A run producing output keeps running;
one silent for `CMA_IDLE_TIMEOUT_MS` is stopped and reported.

If your Claude Code is too old for `--output-format stream-json`, the companion
detects that and falls back to the buffered invocation. That path can't
distinguish a long run from a dead one — buffering emits nothing until the end
— which is exactly why it is the fallback.

## Commands

| Command | What it does |
| --- | --- |
| `pair` | Link this machine to your account |
| `start` | Claim and run work (leave running) |
| `verify` | Restore a session that lapsed after two weeks of silence |
| `status` | Pairing, session and Claude login state |
| `repos:add PATH` | Share a folder so the web app can see the repositories in it |
| `repos:list` | Show shared folders and the repositories found |
| `repos:remove PATH` | Stop sharing a folder |
| `claude:add --label X` | Add a separate Claude login and sign into it |
| `claude:login --profile X` | Sign a login in again after it expires |
| `claude:list` | Show logins on this machine |
| `claude:scan` | Re-check every login and report to the web app |
| `claude:remove --profile X` | Delete a login and its credential from this machine |

## Environment

| Variable | Purpose |
| --- | --- |
| `CMA_SERVER_URL` | Point at a different host (default `https://configuremyai.com`) |
| `CMA_DEVICE_TOKEN` | Supply the device token directly instead of `config.json` |
| `CMA_AGENT_HOME` | Where state lives (default `~/.configure-my-ai`) |
| `CMA_CLAUDE_BIN` | Path to the `claude` binary. Only needed for a non-standard install — `~/.local/bin`, Homebrew and the npm/bun globals are found automatically, on `PATH` or not |
| `CMA_IDLE_TIMEOUT_MS` | How long a run may produce **no output** before it is stopped (default 120000). This is a silence budget, not a duration budget — a run that keeps streaming never hits it, however long it takes |
| `CMA_MAX_RUN_MS` | Backstop for a wedged process that is somehow still emitting (default 4 h). Not a budget for real work |

## Keeping it awake

A sleeping Mac can't answer. Either stop it sleeping while on power (System
Settings → Battery), or run it under `caffeinate`:

```sh
caffeinate -s cma-agent start
```

## Depending on another product's CLI

Every Claude Code flag this companion relies on is gathered in the `CLI` object
at the top of `src/claude.js`. They are verified against **Claude Code 2.1.220**.
If a Claude Code upgrade breaks a run, that object is the only place that should
need editing.

Two behaviours worth knowing about that build, both handled in `src/claude.js`:

- The result envelope has no top-level `model`; the model that ran is the key of
  `modelUsage`.
- In-band failures (API errors, rate limits) come back with **exit code 0** and
  `is_error: true`. Trusting the exit code alone would render the error text as
  the assistant's reply.

## Limits

- Headless Claude Code takes a single prompt, so prior turns are flattened into
  it. Long conversations cost more here than the same conversation would on the
  Messages API with prompt caching.
- Work only runs while this machine is awake and online. Chat, code sessions and
  the composer are fine; embedded widgets, API endpoints and scheduled bots need
  a credential that works without you.
