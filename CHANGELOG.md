# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

## [Unreleased]

## [0.1.0] - 2026-09-03

### Added

- `agentic-skills` CLI with `init`, `update`, and `status`.
- `init` and `update` download the current [ag-kit](https://github.com/vudovn/ag-kit) archive from GitHub and install its agent roles, skills, and workflows, plus the upstream license.
- `ARCHITECTURE.md` installed with only the sections that describe the installed content, falling back to the verbatim file with a warning if upstream renames a section.
- Hash manifest in `.agentic-skills/manifest.json` recording the upstream commit and version, so updates preserve locally modified files and never touch user-created ones.
- `--ref` to install a specific upstream branch, tag, or commit, and `--archive` to install from a local tarball or URL.
- `--path`, `--dir`, `--force`, `--dry-run`, and `--json` options.
- Archives are read as untrusted input: entries that would escape the target directory are rejected, downloads time out, and decompression is capped.
