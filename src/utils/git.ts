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
  if (!parts.subject) throw new Error('Commit message 不能为空。');
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
  if (!parts.subject) throw new Error('Commit message 不能为空。');
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

export async function revertCommit(git: SimpleGit, hash: string): Promise<void> {
  const h = hash.trim();
  if (!h) throw new Error('需要提供要 revert 的 commit hash。');
  await git.raw(['revert', '--no-edit', h]);
}

export async function resetTo(git: SimpleGit, mode: 'soft' | 'mixed' | 'hard', ref: string): Promise<void> {
  const r = ref.trim();
  if (!r) throw new Error('需要提供 reset 目标（例如 HEAD~1 或 commit hash）。');
  await git.raw(['reset', `--${mode}`, r]);
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

export async function getRemoteUrl(git: SimpleGit): Promise<string> {
  try {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');
    return origin?.refs.fetch ?? origin?.refs.push ?? '';
  } catch {
    return '';
  }
}
