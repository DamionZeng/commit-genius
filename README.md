# Git Genius

AI-powered Conventional Commit generator, CHANGELOG generator, and PR description generator for VS Code. Works with any Git repository and formats PR descriptions for GitHub, GitLab, and Bitbucket.

## Features

- Generate a Conventional Commit message from your git diff and fill the Source Control input box
- Generate `CHANGELOG.md` from commit history (Conventional Commits-aware)
- Generate a PR title + description from branch changes and copy to clipboard

## Installation

- Marketplace: search for "Git Genius"
- Local `.vsix`: package the extension and install via `Extensions: Install from VSIX...`

## Configuration

Open VS Code Settings and search for "Git Genius".

Required:

- `gitGenius.ai.apiKey`: API key for an OpenAI-compatible provider

Common:

- `gitGenius.ai.baseUrl` (default `https://api.openai.com/v1`)
- `gitGenius.ai.model` (default `gpt-4o-mini`)
- `gitGenius.ai.temperature` (default `0.2`)

Commit generation:

- `gitGenius.commit.diffScope`: `staged` (default) or `workingTree`

Changelog:

- `gitGenius.changelog.path`: output file path (default `CHANGELOG.md`)

PR description:

- `gitGenius.pr.platform`: `github` | `gitlab` | `bitbucket`
- `gitGenius.pr.baseRef`: e.g. `origin/main` (optional, auto-detected when empty)
- `gitGenius.pr.includeChecklist`: include a small checklist (default `true`)

## Usage

Open the Command Palette:

- `Git Genius: Generate Commit Message`
  - Stages recommended: it uses `git diff --cached` by default
  - Fills the Source Control commit input box
- `Git Genius: Generate CHANGELOG`
  - Writes/overwrites the changelog file configured by `gitGenius.changelog.path`
- `Git Genius: Generate PR Description`
  - Generates a title + Markdown body and copies it to clipboard

## Local Development

Prerequisites:

- Node.js 18+ (or compatible with your VS Code engine)

Commands:

```bash
npm install
npm run compile
```

Debug:

- Open this folder in VS Code
- Press `F5` (launches an Extension Development Host)

Tests:

```bash
npm test
```

Package:

```bash
npm run package
```

## Project Bootstrap (generator-code)

This project follows the official `generator-code` TypeScript extension structure. To bootstrap a similar skeleton:

```bash
npx --yes yo generator-code
```

