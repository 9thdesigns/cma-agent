# cma-agent

Runs Configure My AI work on your own machine, using a coding CLI you already
installed and signed into — so a configuration can spend a subscription you
already pay for instead of an API key.

## Runtimes

| Runtime | Reached by | Plan it spends | Repository turns |
| --- | --- | --- | --- |
| Claude Code | `claude` | Claude Pro, Max or Team | Edit files, drive git, open PRs |
| Cursor | `cursor-agent` | Cursor Pro, Ultra or Teams | Edit files, drive git, open PRs |
| Codex CLI | `codex` | ChatGPT Plus, Pro, Business or Enterprise | Edit files, drive git, open PRs |
| Gemini CLI | `gemini` | Gemini Code Assist Standard or Enterprise | Edit files, open PRs — no shell; see below |
| Antigravity | `agy` | Free Google account, or Google AI Pro / Ultra | Edit files only — see below |
| CodeWhale | `codewhale` | DeepSeek API account, or your own models | Edit files, drive git, open PRs |
| Ollama | `http://127.0.0.1:11434` | Nothing — your own model | None — answers in text only |

Install one or install all of them; `cma-agent status` reports what it found
and what each one can do. A provider in the web app names both the machine and
the runtime, so a Cursor provider and a Claude Code provider on the same laptop
spend different subscriptions.

**Ollama is not a subscription, and not a subprocess.** The others are
CLIs this companion spawns; Ollama is an HTTP server on the same machine, so
the adapter hands the engine a request instead of an argv (`transport: "http"`
in `src/runtimes/ollama.js`). Everything downstream — the silence budget, the
heartbeat, streamed partial text, cancellation — is shared with the CLI path
and does not know the difference.

That server listens on `127.0.0.1`, which is exactly why this belongs in the
companion: the web app cannot reach a loopback address in someone's house, and
the companion is already standing on the right computer. No tunnel, no port
forward, nothing exposed.

**Ollama's models are the machine's, not ours.** Every other runtime has a
catalogue we can hold — the same models on every machine. What Ollama can run
is whatever its owner pulled, so the companion reports the list on each scan
and the web app stores it per device. `ollama pull` shows up in the picker
within about thirty seconds; `ollama rm` removes it.

**What the Ollama runtime cannot do.** It answers with text and has no tools,
so a repository turn cannot read or edit files, run git, or open a pull
request. It is a good provider for chat, drafting and anything that should stay
entirely on your own hardware — and the wrong one for work that has to change a
repository. What it *can* do that text-only suggests otherwise: read images.
A vision model (`qwen2.5vl`, `llava`, `llama3.2-vision`, …) gets a chat's
screenshots as pixels — the web app sends them only to models that can read
them, and only to a companion new enough to forward them.

**Cursor billing is not like Claude's.** A Claude Max plan is a rate limit;
Cursor Pro includes a credit pool that manually-selected frontier models draw
down, after which usage is billed on demand. Pointing widgets or scheduled bots
at a Cursor provider can exhaust a month in a way a Claude Max provider cannot.

**What the Gemini CLI runtime cannot do, and why.** A Gemini repository turn
reads and edits files but is not given a shell, so it cannot run git.
Auto-approving shell for Gemini would need either `--yolo` (auto-approve
*every* action, which is handing over the machine) or a Policy Engine file
whose format we have not verified. Given the choice between over-granting and
a stated limitation, this takes the limitation — the allowance fails closed.
Work still ships: the companion's own `git.push` is driven by the server
rather than by the model.

**What a Gemini run CAN do now: the app's own tools.** The GitHub operations
(`mcp__cma_github__*` — open, edit, comment on and merge pull requests) and
the web tools (`mcp__cma_web__*`) mount into Gemini runs through a
system-settings shim: Gemini's settings load in layers with the system
overrides file last, its path is overridable with
`GEMINI_CLI_SYSTEM_SETTINGS_PATH`, and `mcpServers` entries merge across
layers — all from Gemini's own enterprise documentation. The shim lives in the
companion's directory (never `~/.gemini`, never the repo), merges the
machine's real system settings so an enterprise policy stays in force, and
carries only `$VAR` references — Gemini redacts inherited environments for MCP
children, so each server asks for its variables by name and the CLI expands
them at spawn. The token never touches disk. So a Gemini session edits, the
machine pushes, and the model opens the pull request itself.

**Who can still sign into Gemini CLI.** Google stopped serving its consumer
plans (free, Google AI Pro, Ultra) through Gemini CLI on 2026-06-18 and moved
them to Antigravity. What remains on Gemini CLI is a Gemini Code Assist
license, an API key, or Vertex. If your Google plan stopped working here, the
Antigravity runtime is where it went.

**Antigravity (`agy`) is the same posture as Gemini, chosen the same way.**
`--mode=accept-edits` auto-approves the file-edit tools and nothing else;
`run_command` stays behind an approval no headless run can grant, so the
machine pushes for it. The flag agy offers to lift everything
(`--dangerously-skip-permissions`) is never used — that is its yolo mode.
One Antigravity login per machine (the env var that would isolate a second
one is not verified), signed in by running `agy` once in a terminal.

**Codex (`codex exec`) has no ambient login here, like Cursor.** Codex reads
MCP servers from `config.toml` inside `CODEX_HOME`, and the only directory we
may write that file into is one we own — so every Codex login, the default
included, lives in a managed directory and is signed in once with
`cma-agent runtimes:login --runtime codex`. The upside is real isolation: a
work ChatGPT and a personal one each keep their own `auth.json`, and the
account that pays is read back from it and shown on every run. Repository
turns run `--full-auto` (edits without asking, confined to the workspace);
plain chats run `--sandbox read-only`.

**CodeWhale (`codewhale exec`) spends what it is configured with.** Usually a
DeepSeek API key added inside CodeWhale itself — billed per token, not a
monthly plan — or a local model for nothing. Repository turns run `--auto
--sandbox workspace-write`; `--no-project-config` is always passed so a shared
repository cannot reconfigure the harness that runs over it. The app's GitHub
and web tools mount through `CODEWHALE_MCP_CONFIG` — CodeWhale's own way to
hand a harness its MCP servers — pointing at a file in the companion's
directory that names commands and no secrets; the tokens travel by
environment, exactly as they do for every other runtime.

## The one thing to understand

**Your vendor credentials never leave this machine.** The companion doesn't read
them, store them, or transmit them. Each CLI reads its own login from your OS
keychain or config directory when we spawn it, exactly as it does when you run
it yourself.

What Configure My AI stores is a routing target: this machine's name, the labels
you gave your logins, and which one a given provider should use. There is no
secret on the server side to leak.

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
Either way you also need at least one of
[Claude Code](https://claude.com/product/claude-code),
[Cursor CLI](https://cursor.com/cli),
[Codex CLI](https://developers.openai.com/codex/cli),
[Gemini CLI](https://github.com/google-gemini/gemini-cli),
[Antigravity CLI](https://antigravity.google/docs/cli),
[CodeWhale](https://github.com/Hmbown/CodeWhale) installed and signed
in, or [Ollama](https://ollama.com/download) with at least one model pulled —
Antigravity works on a free Google account, and Ollama needs no account at all.

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
bin/release-agent             # publish, then announce
```

#### Announcing

Publishing and announcing are two halves of one release, and `bin/release-agent`
runs both. The second half is the one that kept going missing: a tag would land,
nobody would be told, `package.json` would move on, and no later deploy would
ever look back — 0.11.1 shipped in silence exactly that way.

So after publishing, the script runs the announcement on the app itself:

```sh
heroku run --exit-code --app configure-my-ai -- bundle exec rails agent:release:announce_pending
```

`--exit-code` is load-bearing. Without it `heroku run` exits 0 no matter what
the dyno did, and a refused announcement would read as a delivered one.

Everything that could stop it is checked **before** anything is pushed — the
Heroku CLI being absent, not being logged in, the app not being one you can see
— because finding out afterwards leaves a version people can install and nobody
knows about. Each failure names the command that fixes it.

Running the script again on a version that is already published is not a no-op:
it still asks, so a release that was published but never announced gets its
notification. `announce_pending` sends nothing when there is nothing pending.

| Flag | Why |
| --- | --- |
| `--no-announce` | publish quietly; also `CMA_ANNOUNCE=0` |
| `--app NAME` | a Heroku app other than `configure-my-ai`; also `CMA_HEROKU_APP` |
| `--dry-run` | renders a formula and never announces |

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

#### The mirror is a snapshot, not a history

`cma-agent`'s default branch is **one orphan commit**, rebuilt on every release.
Nothing is lost by that: every commit it ever held was the same machine-written
`cma-agent X.Y.Z` snapshot of this directory, and the history that means
anything is the one in the main repository.

What the fake history did cost was a name. GitHub's Contributors graph reads the
default branch, so a public repository nobody had contributed to credited
whoever had run the release — a personal account with 19 commits, and a second
with 2. The release identity is pinned in `bin/release-agent` now, for a
hand-run as well as for the deploy, so there is one author and it is not a
person. Override with `CMA_RELEASE_NAME` / `CMA_RELEASE_EMAIL`.

Two rules hold that together, both covered by `test/bin/release_agent_test.rb`:

**Tags are never moved.** The published formula pins
`…/archive/refs/tags/vX.Y.Z.tar.gz` to a `sha256`. Move a tag and GitHub
generates a different tarball, the checksum stops matching, and a version that
installed yesterday fails today. Earlier releases stay reachable by tag, byte
for byte, after their commits leave the branch — the tag list is snapshotted
before the push and re-checked after it, and a release that disturbed one fails
loudly instead of quietly breaking Homebrew.

**The tap is append-only** and does *not* get the same treatment. `brew update`
runs `git rebase origin/<branch>` inside every tapped clone on a user's machine,
so rewriting the tap would leave that rebase replaying its old commits onto an
unrelated root and conflicting on the formula. `brew update` failing on every
machine that had already tapped is a worse outcome than a contributor list with
a name in it, so the names already in the tap stay.

#### Renaming either repository

GitHub redirects a renamed repository's URLs permanently, including the archive
tarballs Homebrew downloads and the git URL npm clones, so a rename breaks
nothing on the day. What it leaves behind is links naming a repository that is
no longer called that, and those are configuration rather than a deploy:

| Set | Where | Changes |
| --- | --- | --- |
| `CMA_AGENT_SOURCE_REPO` | release environment | what `bin/release-agent` pushes the mirror to |
| `CMA_AGENT_TAP_REPO` | release environment | what it pushes the formula to |
| `CMA_AGENT_SOURCE_REPO_URL` | web app | the link and the `npm install -g` line the site shows |
| `CMA_AGENT_TAP` | web app | the `brew install <tap>/cma-agent` the site shows |

The tap must still be called `homebrew-tap` on GitHub whatever else changes —
that is what lets Homebrew resolve the short form.

## Setup

```sh
cma-agent pair      # enter the code from /devices/setup
cma-agent start     # wait for work
```

`cma-agent status` shows pairing state, Claude Code version, and every Claude
login it can see.

## More than one account

Each login lives in its own config directory (`CLAUDE_CONFIG_DIR` for Claude
Code, `CURSOR_CONFIG_DIR` for Cursor, `CODEX_HOME` for Codex,
`CODEWHALE_HOME` for CodeWhale), so a work account and a personal account
never mix:

```sh
cma-agent runtimes:add --runtime claude_code --label "Work" --account you@work.com
cma-agent runtimes:add --runtime cursor --label "Personal"
```

The old `claude:add`, `claude:login`, `claude:list`, `claude:scan` and
`claude:remove` still work and still mean Claude Code — they are pinned to it,
not resolved, so they keep meaning the same thing on a machine that later
installs Cursor.

`--runtime` can be omitted when only one runtime is installed. With two or more
it is required rather than guessed, because guessing would sign you into the
wrong account.

> **Cursor and Codex have no ambient login.** Most runtimes can use whatever
> login you already have with no setup. These two cannot, because a file we
> must own bounds their runs — Cursor's permissions file, Codex's MCP
> `config.toml` — and writing it into `~/.cursor` or `~/.codex` would edit
> the config your own terminal reads. So sign in once with
> `cma-agent runtimes:login --runtime cursor` (or `--runtime codex`), even
> for the default profile.

> **Gemini and Antigravity keep one login per machine.** The environment
> variable that relocates each one's config directory is not something this
> build is willing to guess at, so they support the ambient login only rather
> than pretending to isolate profiles they cannot.

`--account` is optional. It is a note to yourself, shown masked (`y•••@work.com`)
when nothing better is known — it is not read from Claude Code's files and never
used for authentication.

Both labels then appear in the **Claude login** picker when you create a
provider in the web app.

### Choosing which account runs the work

There are two levels, and they answer different questions.

**The web app decides per provider, and it wins.** Every usable login becomes
its own provider — `Claude Code · Work`, `Claude Code · 9th` — so pointing a
configuration at an account is the same action as switching from Anthropic to
OpenAI. Pick the provider. Nothing on this machine overrides that.

**This machine decides what "no login named" means.** A provider can also leave
the login blank, which every provider does that was created before a second
login existed. Blank has always meant the ambient login — whichever account the
vendor CLI happens to be signed into — which is right with one account and a
coin toss with two. `use` makes it a choice:

```sh
cma-agent use            # what it is now, and what each alternative would spend
cma-agent use 9th        # send unnamed work to that login instead
cma-agent use default    # back to this machine's ambient login
```

```
$ cma-agent use 9th
✓ Claude Code: work that names no login now runs on
    9th [9th] — account: ds@davidos.us
    Told Configure My AI, so the web app shows the same account.

Restart the companion for it to take effect: cma-agent start
```

Restarting matters: `start` reads this once, and the banner it prints marks the
login unnamed work lands on. Per runtime, so `use --runtime cursor` is a
separate decision — "work" under Claude Code and "work" under Cursor are
different logins that share a word.

Choosing a login that has since been deleted falls back to ambient rather than
running against a directory with no credential in it.

**It is reported, not hidden.** The account this redirect lands on is what gets
sent to the web app for that provider, and the line opening each run shows the
hop:

```
→ Claude Code (account: ds@davidos.us): claude-opus-5 on "default" → "9th"…
```

That is deliberate. The web app tells you which account a run spent; a machine
that quietly sent work elsewhere while still reporting the ambient address
would turn that into a lie.

### When a login expires

```sh
cma-agent runtimes:login --runtime claude_code
```

With no `--profile`, this signs in **the login unnamed work runs on** — the one
`cma-agent use` chose — not the ambient login. Those were different before
0.18.0, and the difference was a trap: on a machine where `use 9th` had
redirected unnamed work, every run failed with "That Claude login needs signing
in again", the command in that message signed in the ambient login instead, and
the credential that had actually expired was never touched. The vendor CLI
prints the same "Welcome back" either way, so nothing on screen disagreed.

Three things now keep that honest:

- the command says which login it is signing in, and where the credential goes;
- it checks afterwards rather than congratulating you — `✓ Signed in` means the
  login was probed and answered;
- a failed run names the login in its own instruction
  (`… (cma-agent runtimes:login --runtime claude_code --profile 9th)`).

Add `--profile default` to sign in the ambient login by the name it is printed
under, and `--profile <slug>` for any other.

When the sign-in finishes, the companion starts in that same terminal — signing
a login in is never the goal, running work on it is. `--no-start` prints the
command instead, which is also what happens when the shell is not interactive,
so setup scripts are unaffected.

`cma-agent start` also says so at startup, once per credential, instead of
leaving it to be discovered from a browser:

```
! The Claude Code login "9th" is signed out — work sent to it will fail.
    Sign it in with: cma-agent runtimes:login --runtime claude_code --profile 9th
```

### Which account is this, really?

A label is what you typed. The account is what the CLI resolves, and they are
different claims — so the companion reads the account back out of each login's
own config directory (`.claude.json`, beside the credential rather than in it —
no token is ever read) and shows it everywhere the login appears:

```sh
cma-agent accounts
```

```
Claude Code  [claude_code]  2.1.220
  ✓ Default  [default]
      account:   dave@personal.com
      folder:    this machine's own Claude Code login (no CLAUDE_CONFIG_DIR override)
      provider:  "Claude Code on MacBookPro"
  ✓ Work  [work]
      account:   dave@acme.com
      folder:    ~/.configure-my-ai/claude-profiles/work
      provider:  "Claude Code · Work"
```

The same account then opens every run in the terminal…

```
→ Claude Code (account: dave@acme.com): claude-opus-5 on "work" in ~/code/site…
```

…and is the first line of the thinking log in the web app, so a session says
which subscription paid for it without you having to remember.

> **macOS note.** Claude Code stores credentials in the system Keychain, and how
> completely a per-profile `CLAUDE_CONFIG_DIR` isolates them can vary by Claude
> Code version — two logins can collapse onto one account while their labels go
> on insisting otherwise. `cma-agent accounts` says so outright when two logins
> resolve to the same address, which is the point of reading it back rather than
> trusting the label.

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
| `repo.ensure` | Clones/updates a checkout of a linked GitHub repo under `~/.configure-my-ai/workspaces` |
| `git.summary` | Branch, working-tree status, last 20 commits, branch list |
| `git.log` | Commit history |
| `git.diff` | The working diff |
| `git.push` | Commits the working tree onto a branch and pushes it |

Every one of those resolves its path against the shared-folder list and refuses
anything outside it — symlinks resolved, `..` rejected. The server asking is a
request, not permission. `git` is invoked with an argument array, never a shell
string, so a hostile branch name is a bad branch name rather than a command.

### Several repositories in one session

A session can be linked to up to five repositories. The first is the primary —
the directory the run starts in — and each of the others gets its own checkout,
prepared the same way, when the turn starts. From 0.16.0 the run is granted
those directories too (Claude Code's `--add-dir`, one per checkout), so the
model can read and edit every repository in the session, not just the one it
opens in.

Every path the server names is validated against the same allowlist as the
primary before it is granted — a path that fails validation is dropped, never
the run. The GitHub tools take a `repo` argument naming which repository an
operation acts on, and a push commits and pushes **that repository's own
checkout**: the commit happens on this machine with its own git, routed per
repository on every companion build.

### Checkouts we make ourselves

A session linked to a **GitHub** repository rather than to a folder you shared
gets a checkout under `~/.configure-my-ai/workspaces/<owner>__<repo>`, made on
demand by `repo.ensure`. That directory is usable without `repos:add` — we
created it, it lives in our own state directory, and asking you to share a
folder we made ourselves would be theatre rather than consent. Everything
outside it still needs sharing.

The clone uses **your own git credentials**, via whatever helper you already
have configured. No GitHub token is ever sent to this machine — the same
principle as your Claude login. A private repository you cannot `git clone` by
hand cannot be cloned here either, which is the correct failure.

Clones are `--filter=blob:none`: full history, so `git log` tells the truth,
with file contents fetched on demand so a large repository doesn't cost minutes
before the first answer.

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
3. It runs `claude -p --output-format stream-json --verbose
   --include-partial-messages` under the chosen profile — in the linked
   repository's directory, if the job has one.
4. It posts a heartbeat every ~10s **on a timer**, carrying what it is doing.
   The web app shows that as a live ticker, and it is what tells the server the
   run is alive. On a timer rather than on events, because a `Bash` tool running
   a test suite produces no events for minutes while being entirely alive.
5. The answer and token counts go back; the queued copy is deleted.

Connections are outbound only. Nothing listens, no ports open, no firewall rules.

### Several sessions at once

The companion claims up to three jobs at a time. Before that it ran one, so a
second and third chat session sat in a queue that expired after three minutes —
and the web app reported a machine you could watch working as offline.

The number is **"Jobs at once" on the Devices page** (Edit next to a machine,
one to five). It rides the heartbeat, so a change applies within seconds
without restarting anything. `cma-agent max-jobs <n>` sets a local ceiling for
a machine that must not go above some number whatever the account asks for —
the two are combined by taking the lower, so the local one can only ever
restrain the page. `CMA_MAX_JOBS` overrides both, for debugging.

Two things make parallel runs safe rather than merely possible:

* **Repository questions have their own lane.** `repos.list`, `repo.ensure`,
  `git.push` and friends are polled separately from model turns, because every
  coding turn *opens* with a `repo.ensure`: behind three long completions in one
  queue, that question times out and the session quietly loses its working
  directory.
* **Each session gets its own working tree.** A session linked to a GitHub
  repository is given a `git worktree` off one shared clone, named for the
  session. Two sessions on one repository therefore have separate files and
  separate branches, where before they shared a directory and edited over each
  other. The clone is still shared, so a second session costs a working tree
  rather than a second download.

Sessions running against a folder you shared yourself (`repos:add`) are *not*
isolated — that directory is yours, and moving your work somewhere else would be
a surprise. Point two sessions at one shared folder and they will collide, the
same as two terminals would.

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
| `max-jobs [n\|none]` | Local ceiling on jobs at once. The usual place to set this is the Devices page |
| `verify` | Restore a session that lapsed after two weeks of silence |
| `status` | Pairing, session and Claude login state |
| `repos:add PATH` | Share a folder so the web app can see the repositories in it |
| `repos:list` | Show shared folders and the repositories found |
| `repos:remove PATH` | Stop sharing a folder |
| `use [login]` | Which login work runs on when nothing names one. No argument shows it |
| `accounts` | Which account each login signs in as, and the provider that spends it |
| `runtimes:list` | Show every runtime and the logins on this machine |
| `runtimes:add --runtime R --label X` | Add a separate login and sign into it |
| `runtimes:login [--runtime R] [--profile X] [--no-start]` | Sign a login in again after it expires, then start the companion. No `--profile` means the login unnamed work runs on |
| `runtimes:scan` | Re-check every login and report to the web app |
| `runtimes:remove --runtime R --profile X` | Delete a login and its credential from this machine |
| `claude:*` | The same commands, pinned to Claude Code |

## Environment

| Variable | Purpose |
| --- | --- |
| `CMA_SERVER_URL` | Point at a different host (default `https://configuremyai.com`) |
| `CMA_DEVICE_TOKEN` | Supply the device token directly instead of `config.json` |
| `CMA_AGENT_HOME` | Where state lives (default `~/.configure-my-ai`) |
| `CMA_HIDE_ACCOUNT_EMAIL` | Set to `1` to keep the resolved account address on this machine. The masked hint (`d•••@acme.com`) is still reported, so two logins stay tellable apart in the web app, and this machine's own terminal still prints the address in full |
| `CMA_CLAUDE_BIN` | Path to the `claude` binary. Only needed for a non-standard install — `~/.local/bin`, Homebrew and the npm/bun globals are found automatically, on `PATH` or not |
| `CMA_CURSOR_BIN` | The same, for `cursor-agent` |
| `CMA_GEMINI_BIN` | The same, for `gemini` |
| `CMA_OLLAMA_URL` | Where Ollama listens, when it isn't `http://127.0.0.1:11434` — a container, or another box on your network. Takes precedence over `OLLAMA_HOST`, which is also read (and whose bind-address forms, `0.0.0.0:11434` and a bare port, are understood). Setting this also makes the runtime count as present even with no `ollama` binary on this machine |
| `CMA_OLLAMA_KEEP_ALIVE` | How long Ollama keeps a model loaded after a run (default `30m`; Ollama's own default is 5 minutes, so the turn after a longer pause used to pay the whole model load again before its first token). A Go duration (`10m`, `24h`) or seconds as a number; `-1` keeps the model loaded until Ollama stops, `0` restores unload-immediately for a RAM-tight machine |
| `CMA_IDLE_TIMEOUT_MS` | How long a run may produce **no output** before it is stopped (default 600000 — 10 min, which clears the longest single Bash tool call). This is a silence budget, not a duration budget — a run that keeps streaming never hits it, however long it takes |
| `CMA_MAX_RUN_MS` | Backstop for a wedged process that is somehow still emitting (default 4 h). Not a budget for real work |

## Keeping it awake

A sleeping Mac can't answer. A **locked** one can — the lock screen is a window
over a machine that never stopped, and this is a background process. So the
thing to prevent is system sleep, not locking.

Either stop it sleeping while on power (System Settings → Battery), or run it
under `caffeinate`:

```sh
caffeinate -is cma-agent start
```

`-s` blocks system sleep and is only honoured on AC power; `-i` blocks idle
sleep and holds on battery too. Both assertions belong to the wrapped process,
so they go away when it exits — nothing is left switched on.

Closing a laptop lid sleeps the machine regardless, short of clamshell mode
(external display + power + external input). Lock the screen and leave the lid
open, or pair a machine that has no lid.

Linux, same idea:

```sh
systemd-inhibit --what=idle:sleep --why="cma-agent" cma-agent start
```

## Depending on another product's CLI

One adapter per runtime, in `src/runtimes/`, each opening with a `CLI` object
that gathers every flag we depend on. When a vendor upgrade breaks a run, that
object is the only thing that should need editing — check the installed build's
`--help` first.

| Adapter | Verified against |
| --- | --- |
| `src/runtimes/claude-code.js` | Claude Code 2.1.220 |
| `src/runtimes/cursor.js` | the flag surface two independent third-party adapters use (`@sumeru/adapter-cursor-agent`, `pi-cursor-agent`) plus Cursor's CLI reference |
| `src/runtimes/codex.js` | exec-mode experiments against codex 0.114.0 (flag surface, JSONL events) plus OpenAI's non-interactive docs |
| `src/runtimes/gemini.js` | flags read out of the shipped bundle of `@google/gemini-cli` 0.54.4 |
| `src/runtimes/antigravity.js` | agy's documented headless contract (`--prompt`, `--output-format stream-json`, `--non-interactive`, `--mode=accept-edits`) and the event stream third-party harnesses consume |
| `src/runtimes/codewhale.js` | CodeWhale's published launch contract for `codewhale exec` (docs/AGENT_RUNTIME.md in its repository), including the NDJSON event vocabulary |
| `src/runtimes/ollama.js` | Ollama's `/api/chat`, `/api/tags` and `/api/version` — no argv, see `transport: "http"` |

`src/engine.js` holds everything that is the same whatever the vendor: spawning,
the NDJSON reader, the idle contract, the heartbeat, partial text, and the
cancel path. It never names a runtime.

`agent/test/runtimes.test.js` asserts that the three express the SAME allowance
in their three different syntaxes — Claude Code as `--allowedTools`, Cursor as a
`permissions.json`, Gemini as `--approval-mode` plus `--allowed-tools`. That is
the test that catches "we accidentally gave Cursor a shell".

Two behaviours worth knowing about Claude Code, both handled in its adapter:

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
