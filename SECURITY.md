# Security Policy

## Reporting a Vulnerability

Do not open a public issue or pull request for a suspected security problem.

Report vulnerabilities through GitHub private vulnerability reporting. Include affected version, impact, reproduction steps, and any known mitigation.

## Scope

This package downloads the [ag-kit](https://github.com/vudovn/ag-kit) source archive from GitHub over HTTPS at run time and writes Markdown and helper scripts from it into a project directory. It never executes anything it downloads.

The archive is parsed as untrusted input: entries that would escape the target directory are rejected, every write is checked against the destination root, downloads time out after 30 seconds, and decompression is capped so a small hostile file cannot expand into gigabytes. Symbolic and hard links in an archive are skipped rather than created.

- Report issues with the download, the extraction, the install and update logic, or the release pipeline here.
- Report issues with the content itself upstream in ag-kit. Because installs read upstream directly, a fix there reaches users on their next `update` without a release here.

By default the installer follows upstream `main`. To install a reviewed state instead, pass `--ref` with a tag or commit, or `--archive` with a file you have inspected.

## Supported Versions

Security fixes are only guaranteed for the latest published release.
