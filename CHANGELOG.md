# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

## [Unreleased]

## [0.3.0] - 2026-09-05

### Added

- `update` and `sync` now keep both changes when a local edit and an upstream change never wrote in the same place, instead of freezing the file for either. A file is only ever combined when the version it was installed from can be read and hashes to exactly what the manifest recorded, and only when no two changes touch; otherwise it stays frozen, exactly as before. Nothing local is ever dropped to make a merge possible, and no file is left half-combined.
- `--no-merge` turns that off, leaving every edited file frozen the way earlier versions did.
- `agentic-skills diff`: for every file a local edit froze, compares three versions - the commit you installed from, your copy, and current upstream - so every difference has a known author. Without a path it lists the frozen files and says whether each is blocked by a real overlap or only by the per-file rule; with a path it prints all three versions of every changed region. Nothing is written, and nothing is merged.
- `--base-archive` supplies the version you installed from as a local tarball or URL, instead of downloading the commit recorded in the manifest. Used by `update`, `sync`, and `diff`.

### Fixed

- The manifest no longer advances the recorded hash of a file that was skipped. Nothing was written to that file, so the version it descends from has not changed; recording the newer one made it look as though the user had deleted an upstream change they had merely not taken yet.

## [0.2.0] - 2026-09-05

### Added

- `agentic-skills sync`: installs when the target is missing and updates when it is already there, so one command covers both states. It is the command for a `postinstall` hook, a CI step, or a container build, where the run cannot stop to ask which state it is in. Local edits are preserved as with `update`; `--force` overwrites them, so exit code 2 cannot happen.

### Changed

- The note about a missing manifest is printed only when files were actually skipped, and now appears for every command rather than only `update`.
- The error `init` raises on a non-empty target points at `sync` for unattended runs.

## [0.1.0] - 2026-09-03

### Added

- `agentic-skills` CLI with `init`, `update`, and `status`.
- `init` and `update` download the current [ag-kit](https://github.com/vudovn/ag-kit) archive from GitHub and install its agent roles, skills, and workflows, plus the upstream license.
- `ARCHITECTURE.md` installed with only the sections that describe the installed content, falling back to the verbatim file with a warning if upstream renames a section.
- Hash manifest in `.agentic-skills/manifest.json` recording the upstream commit and version, so updates preserve locally modified files and never touch user-created ones.
- `--ref` to install a specific upstream branch, tag, or commit, and `--archive` to install from a local tarball or URL.
- `--path`, `--dir`, `--force`, `--dry-run`, and `--json` options.
- Archives are read as untrusted input: entries that would escape the target directory are rejected, downloads time out, and decompression is capped.
