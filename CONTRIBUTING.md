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

## Releasing

1. Update `CHANGELOG.md`, moving entries out of `Unreleased`.
2. Bump `version` in `package.json` and run `npm install` so the lockfile follows.
3. Run `npm run release:check`.
4. Commit as `chore: release vX.Y.Z` and push.
5. Publish a GitHub release for tag `vX.Y.Z`. The `Publish` workflow runs the release checks again and publishes to npm with provenance.

Publishing uses npm Trusted Publishing through GitHub OIDC, so no npm token is stored in the repository. The `@daldindev` scope must exist on npm and the package must be configured there for trusted publishing from this repository's `Publish` workflow.
