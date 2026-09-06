# Contributing

Thanks for helping improve `agentic-skills`.

## Local Setup

Use Node.js `>=20.11`.

```bash
npm ci
npm run check
```

`npm run check` runs the linter and the tests. The tests build their own upstream archives, so they never touch the network.

## Project Scope

- This repository is an installer. It downloads the ag-kit archive at run time and writes the agent roles, skills, and workflows into a project.
- It does not host, author, edit, or improve the content. Content changes belong upstream in ag-kit, and every install picks them up on its own.
- It does not rebuild upstream's runtime wiring: hooks, MCP configuration, memory, rules, schemas, or validators.
- It has no runtime dependencies and does not require `git` on the user's machine. Keep it that way.
- `ARCHITECTURE.md` is filtered by whole sections listed in `src/upstream.mjs`. Never add line-level rewriting of upstream text.

## Pull Request Expectations

- Add tests for every behavior change. Use `buildArchive` from `tests/helpers.mjs` to fake upstream.
- Update the README and `CHANGELOG.md` for user-visible changes.
- Keep the CLI commands and flags compatible.
- Run `npm run check` before opening the pull request.

