import type { SimpleGit } from 'simple-git';

import {
  amendWithMessage,
  checkoutLocalBranch,
  commitWithMessage,
  createGit,
  createSafetyBackupRef,
  createSafetyStash,
  detectBaseRef,
  getCompareDiff,
  getCompareSummary,
  getCommitDetails,
  getDiff,
  getHeadBranch,
  getLocalBranches,
  getRecentCommits,
  getRemoteUrl,
  getStatusSummary,
  pullCurrentBranch,
  pushCurrentBranch,
  resetTo,
  revertCommit,
  stageAll,
  unstageAll
} from '../../utils/git';

export type { SimpleGit };

export {
  amendWithMessage,
  checkoutLocalBranch,
  commitWithMessage,
  createGit,
  createSafetyBackupRef,
  createSafetyStash,
  detectBaseRef,
  getCompareDiff,
  getCompareSummary,
  getCommitDetails,
  getDiff,
  getHeadBranch,
  getLocalBranches,
  getRecentCommits,
  getRemoteUrl,
  getStatusSummary,
  pullCurrentBranch,
  pushCurrentBranch,
  resetTo,
  revertCommit,
  stageAll,
  unstageAll
};

export async function renderStatusText(git: SimpleGit): Promise<string> {
  const s = await getStatusSummary(git);
  const remote = await getRemoteUrl(git);
  const tracking = s.tracking ? ` (${s.tracking})` : '';
  const aheadBehind = s.ahead || s.behind ? ` ahead:${s.ahead} behind:${s.behind}` : '';
  const lines = [
    `branch: ${s.current || '(detached)'}${tracking}${aheadBehind}`,
    `remote: ${remote || ''}`,
    `staged: ${s.staged}`,
    `modified: ${s.modified}`,
    `untracked: ${s.not_added}`,
    `conflicted: ${s.conflicted}`,
    `created: ${s.created}`,
    `deleted: ${s.deleted}`,
    `renamed: ${s.renamed}`
  ];
  return lines.join('\n');
}

