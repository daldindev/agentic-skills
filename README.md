# agentic-skills

Install the [ag-kit](https://github.com/vudovn/ag-kit) **agent roles, skills, and workflows** into any project, for any model and any agent harness.

## Why it exists

ag-kit is a large, well-organized body of agent instructions: 20 specialist roles, 47 skills, 13 workflows. Upstream delivers it as a workspace for one IDE runtime, so using any of it means adopting that runtime and the contract it comes with.

This installer removes that condition. One command downloads the current ag-kit and writes only the instructions into your project, as plain Markdown that whatever assistant you already use can read:

- The upstream roles, skills, and workflows, **verbatim** and always current, because every install reads upstream directly.
- One command to install, one to update, with local edits **preserved**.
- The exact upstream commit recorded with every install.
- **No runtime dependencies**, and no `git` needed on your machine.

Everything else upstream ships sits around that content to bind it to that one runtime: hooks, an MCP configuration, the memory and rule loading, schemas, manifests, and validators. A portable install has no use for wiring, so none of it is installed.

## Install

```bash
npx @daldindev/agentic-skills init
```

Or add it to the project so the installer version is pinned in `package.json`:

```bash
npm i -D @daldindev/agentic-skills
npx agentic-skills init
```

Requirements:

- Node.js `>=20.11`
- Network access to `codeload.github.com`, where GitHub serves source archives, when you run `init` or `update`

## Quick Start

`init` creates `.agents/` in the current project:

```plaintext
.agents/
├── ARCHITECTURE.md                 # Inventory of every agent, skill, and workflow
├── LICENSE                         # Upstream MIT license
├── agent/                          # 20 role definitions
├── skills/                         # 47 skills, each a folder with a SKILL.md
├── workflows/                      # 13 slash-command procedures
└── .agentic-skills/manifest.json   # File hashes and the upstream commit, so updates can protect your edits
```

Point your assistant at `.agents/ARCHITECTURE.md`. It lists every component with a one-line purpose, so the assistant can open only what a task needs.

## Commands

| Command | Purpose |
| --- | --- |
| `agentic-skills init` | Download ag-kit and install the content. Refuses a non-empty target unless `--force` |
| `agentic-skills update` | Download ag-kit again and update installed files, keeping the ones you edited |
| `agentic-skills status` | Show what is installed, from which upstream commit, and which files were changed locally |

| Option | Purpose |
| --- | --- |
| `-p, --path <dir>` | Project directory, default is the current directory |
| `-d, --dir <name>` | Install directory inside the project, default `.agents` |
| `-r, --ref <git-ref>` | Upstream branch, tag, or commit to install, default `main` |
| `--archive <source>` | Install from a local ag-kit `.tar.gz` or a URL instead of GitHub |
| `-f, --force` | Overwrite files that were modified locally |
| `--dry-run` | Download and print the plan without writing anything |
| `--json` | Print machine-readable output |

Exit code `2` means the command succeeded but skipped files you had modified. They are listed in the output.

## Updating

There is nothing to bump. `update` downloads the current upstream and applies it:

```bash
npx @daldindev/agentic-skills update
```

For each file it compares what is installed, what upstream now has, and the hash recorded at the last run.

| Situation | Result |
| --- | --- |
| You never touched the file | Updated, or deleted when upstream dropped it |
| You edited the file | Skipped and listed, unless `--force` |
| You created the file yourself | Never touched |
| Upstream added a file | Installed |

To stay on a known upstream state instead of `main`, pass a tag or commit. The same flag reproduces an earlier install exactly:

```bash
npx @daldindev/agentic-skills update --ref v2026.8.31
```

## What gets installed

| Upstream path | Installed as |
| --- | --- |
| `.agents/agent/` | `agent/` |
| `.agents/skills/` | `skills/` |
| `.agents/workflows/` | `workflows/` |
| `.agents/ARCHITECTURE.md` | `ARCHITECTURE.md`, see below |
| `LICENSE` | `LICENSE` |

Files are copied byte for byte from the upstream archive at the moment you run the command. Nothing is rewritten, summarized, or adapted, and the commit they came from goes into the manifest.

`ARCHITECTURE.md` is the one exception. Upstream's inventory also documents its own runtime tooling, so the installer keeps the sections that describe the installed content (**Agents**, **Skills**, **Workflows**, **Skill Loading Protocol**, **Quick Reference**) and drops the rest. Whole sections only, never edited lines. If upstream ever renames one of those sections, the file is installed verbatim and a warning is printed, so an upstream change can never block an install.

Some installed files still mention the upstream runtime or its folders in passing. Ignore those references, or point them at your own equivalent.

The archive is treated as untrusted input, and nothing in it is ever executed. See [`SECURITY.md`](./SECURITY.md) for what that means in practice.

## Using the Content

The content is deliberately tool-neutral:

- **Agents** are Markdown files with YAML frontmatter (`name`, `description`, `tools`, `skills`). Use them as system prompts or subagent definitions.
- **Skills** are folders whose `SKILL.md` frontmatter includes `when_to_use`, so an assistant can decide when to load one. Some ship Python helper scripts.
- **Workflows** are slash-command procedures, where `$ARGUMENTS` stands for the text after the command.

Keep the install at `.agents/` when you can, because paths inside the content are written relative to that folder. If your tool expects its own layout, copy or link the pieces it needs and still point it at `ARCHITECTURE.md` as the entry point.

## Scope and Non-Goals

In scope:

- Downloading the upstream roles, skills, and workflows and installing them anywhere
- Updating an install while preserving local edits
- Recording upstream provenance with every install

Out of scope:

- Authoring, editing, or hosting the content, which lives upstream and only upstream
- Rebuilding upstream's runtime wiring, which a portable install does not need
- Any dependency on a specific IDE, model, or agent runtime

## Contributing

The installer is small on purpose. Issues and pull requests are welcome for the installer itself; problems with an agent, skill, or workflow belong upstream in ag-kit. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for local checks and release validation.

## License

MIT. The installed content is © VUDOVN under the MIT License and carries its own `LICENSE` file. See [`NOTICE.md`](./NOTICE.md).
