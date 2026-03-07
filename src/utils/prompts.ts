export function commitPrompt(input: { diff: string; branch: string }): string {
  return [
    'Generate a single Conventional Commit message based on the git diff.',
    '',
    'Rules:',
    '- Output only the final commit message (no markdown).',
    '- Use Conventional Commits: <type>(<scope>): <description>',
    '- Use one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.',
    '- Scope is optional but preferred when obvious.',
    '- Keep the subject <= 72 chars, imperative mood.',
    '- If needed, add a blank line and a body with bullet points.',
    '',
    `Branch: ${input.branch}`,
    '',
    'Diff:',
    input.diff.slice(0, 120_000)
  ].join('\n');
}

export function changelogPrompt(input: { commits: string[] }): string {
  return [
    'Generate a CHANGELOG.md in Markdown from commit history.',
    '',
    'Rules:',
    '- Follow Conventional Commits semantics to group changes.',
    '- Output only markdown.',
    '- Use a top-level "# Changelog" header.',
    '- Include an "## Unreleased" section with subsections like "### Added", "### Fixed", "### Changed", "### Deprecated", "### Removed", "### Security" as needed.',
    '- Prefer concise bullet points.',
    '',
    'Commits:',
    input.commits.join('\n').slice(0, 120_000)
  ].join('\n');
}

export function prPrompt(input: { baseRef: string; branch: string; summary: string; diff: string }): string {
  return [
    'You are generating a pull request description.',
    '',
    'Return JSON with exactly this schema:',
    '{ "title": string, "body": string }',
    '',
    'Rules:',
    '- title: concise, descriptive, not prefixed with "feat:" etc.',
    '- body: Markdown with sections: Summary, Changes, Testing, Notes.',
    '- Mention high-level intent, not code line-by-line.',
    '',
    `Base: ${input.baseRef}`,
    `Head: ${input.branch}`,
    '',
    'Diff summary:',
    input.summary.slice(0, 20_000),
    '',
    'Diff:',
    input.diff.slice(0, 120_000)
  ].join('\n');
}
