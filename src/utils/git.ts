import { simpleGit, SimpleGit } from 'simple-git';

export function createGit(repoPath: string): SimpleGit {
  return simpleGit({ baseDir: repoPath, binary: 'git' });
}

function splitCommitMessage(message: string): { subject: string; body?: string } {
  const trimmed = message.trim();
  if (!trimmed) return { subject: '' };
  const idx = trimmed.indexOf('\n\n');
  if (idx === -1) return { subject: trimmed };
  const subject = trimmed.slice(0, idx).trim();
  const body = trimmed.slice(idx + 2).trim();
  return body ? { subject, body } : { subject };
}

export async function getHeadBranch(git: SimpleGit): Promise<string> {
  const branch = await git.branchLocal();
  return branch.current;
}

export async function getLocalBranches(
  git: SimpleGit
): Promise<{ current: string; all: string[] }> {
  const branch = await git.branchLocal();
  return { current: branch.current, all: branch.all };
}

export async function checkoutLocalBranch(git: SimpleGit, branch: string): Promise<void> {
  const b = branch.trim();
  if (!b) throw new Error('Branch name is required.');
  await git.checkout(b);
}

export async function getDiff(git: SimpleGit, scope: 'staged' | 'workingTree'): Promise<string> {
  if (scope === 'staged') {
    return git.diff(['--cached']);
  }
  return git.diff();
}

export async function getStatusSummary(
  git: SimpleGit
): Promise<{
  current: string;
  tracking?: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  not_added: number;
  conflicted: number;
  created: number;
  deleted: number;
  renamed: number;
}> {
  const status = await git.status();
  return {
    current: status.current || '',
    tracking: status.tracking || undefined,
    ahead: status.ahead ?? 0,
    behind: status.behind ?? 0,
    staged: status.staged?.length ?? 0,
    modified: status.modified?.length ?? 0,
    not_added: status.not_added?.length ?? 0,
    conflicted: status.conflicted?.length ?? 0,
    created: status.created?.length ?? 0,
    deleted: status.deleted?.length ?? 0,
    renamed: status.renamed?.length ?? 0
  };
}

export async function stageAll(git: SimpleGit): Promise<void> {
  await git.add(['-A']);
}

export async function unstageAll(git: SimpleGit): Promise<void> {
  await git.reset(['--mixed']);
}

export async function commitWithMessage(git: SimpleGit, message: string): Promise<string> {
  const parts = splitCommitMessage(message);
  if (!parts.subject) throw new Error('Commit message cannot be empty.');
  if (parts.body) {
    await git.raw(['commit', '-m', parts.subject, '-m', parts.body]);
  } else {
    await git.raw(['commit', '-m', parts.subject]);
  }
  const log = await git.log({ maxCount: 1 });
  return log.latest?.hash ?? '';
}

export async function amendWithMessage(git: SimpleGit, message: string): Promise<string> {
  const parts = splitCommitMessage(message);
  if (!parts.subject) throw new Error('Commit message cannot be empty.');
  if (parts.body) {
    await git.raw(['commit', '--amend', '-m', parts.subject, '-m', parts.body]);
  } else {
    await git.raw(['commit', '--amend', '-m', parts.subject]);
  }
  const log = await git.log({ maxCount: 1 });
  return log.latest?.hash ?? '';
}

export async function pushCurrentBranch(git: SimpleGit): Promise<void> {
  const branch = await getHeadBranch(git);
  await git.push('origin', branch);
}

export async function pullCurrentBranch(git: SimpleGit): Promise<void> {
  const branch = await getHeadBranch(git);
  await git.pull('origin', branch);
}

export async function revertCommit(git: SimpleGit, hash: string): Promise<void> {
  const h = hash.trim();
  if (!h) throw new Error('Commit hash is required for revert.');
  await git.raw(['revert', '--no-edit', h]);
}

export async function resetTo(git: SimpleGit, mode: 'soft' | 'mixed' | 'hard', ref: string): Promise<void> {
  const r = ref.trim();
  if (!r) throw new Error('Reset target is required (e.g. HEAD~1 or a commit hash).');
  await git.raw(['reset', `--${mode}`, r]);
}

function compactTimestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export async function createSafetyBackupRef(git: SimpleGit, label: string): Promise<string> {
  const safeLabel = label.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  const name = `refs/git-genius/backup/${compactTimestamp()}${safeLabel ? `-${safeLabel}` : ''}`;
  await git.raw(['update-ref', name, 'HEAD']);
  return name;
}

export async function createSafetyStash(
  git: SimpleGit,
  message: string,
  paths?: string[]
): Promise<{ created: boolean; output: string }> {
  const args = ['stash', 'push', '-u', '-m', message];
  const ps = Array.isArray(paths)
    ? paths
        .map((p) => String(p || '').trim())
        .filter(Boolean)
        .map((p) => p.replace(/\\/g, '/'))
    : [];
  if (ps.length) args.push('--', ...ps);
  const out = await git.raw(args);
  const text = String(out || '').trim();
  const created =
    text.length > 0 &&
    !/no local changes to save/i.test(text) &&
    !/no changes/i.test(text);
  return { created, output: text };
}

export async function detectBaseRef(git: SimpleGit): Promise<string> {
  try {
    const raw = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const ref = raw.trim();
    const parts = ref.split('/');
    const branch = parts[parts.length - 1];
    if (branch) {
      return `origin/${branch}`;
    }
  } catch (e) {
    void e;
  }

  try {
    const remoteBranches = await git.branch(['-r']);
    const all = remoteBranches.all;
    if (all.includes('origin/main')) return 'origin/main';
    if (all.includes('origin/master')) return 'origin/master';
  } catch (e) {
    void e;
  }

  return 'main';
}

export async function getCompareDiff(git: SimpleGit, baseRef: string): Promise<string> {
  return git.diff([`${baseRef}...HEAD`]);
}

export async function getCompareSummary(git: SimpleGit, baseRef: string): Promise<string> {
  const summary = await git.diffSummary([`${baseRef}...HEAD`]);
  const files = summary.files
    .map((f) => {
      const insertions = 'insertions' in f && typeof f.insertions === 'number' ? f.insertions : 0;
      const deletions = 'deletions' in f && typeof f.deletions === 'number' ? f.deletions : 0;
      return `${f.file} (+${insertions} -${deletions})`;
    })
    .slice(0, 200)
    .join('\n');
  return `Files changed: ${summary.files.length}\nInsertions: ${summary.insertions}\nDeletions: ${summary.deletions}\n\n${files}`.trim();
}

export async function getRecentCommits(
  git: SimpleGit,
  maxCount: number
): Promise<Array<{ hash: string; message: string; authorName: string; date: string }>> {
  const log = await git.log({ maxCount });
  return log.all.map((c) => ({
    hash: c.hash,
    message: c.message,
    authorName: c.author_name ?? '',
    date: c.date
  }));
}

export async function getCommitDetails(git: SimpleGit, hash: string): Promise<string> {
  const h = hash.trim();
  if (!h) throw new Error('Commit hash is required.');
  const out = await git.raw(['show', '--no-patch', '--stat', '--format=fuller%n%n%B', h]);
  return out ?? '';
}

export async function getRemoteUrl(git: SimpleGit): Promise<string> {
  try {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');
    return origin?.refs.fetch ?? origin?.refs.push ?? '';
  } catch {
    return '';
  }
}
