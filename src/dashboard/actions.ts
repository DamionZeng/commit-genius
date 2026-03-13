import { rm } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

import { getConfigWithSecrets } from '../utils/config';
import { getWorkspaceRoot, resolveWorkspacePath } from '../utils/workspace';
import type { DashboardAction, LogLevel, PanelToWebviewMessage } from './protocol';
import { isRecord } from './protocol';
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
  getStatusSummary,
  pullCurrentBranch,
  pushCurrentBranch,
  renderStatusText,
  resetTo,
  revertCommit,
  stageAll,
  unstageAll
} from './services/gitService';
import {
  streamChangelog,
  streamCommitMessage,
  streamPrDescription,
  streamRewrittenCommitMessage,
  testAiConnection,
  toUserSafeErrorMessage
} from './services/aiService';

type PromptWithPanel = (options: {
  panel: vscode.WebviewPanel;
  title: string;
  message: string;
  placeholder?: string;
  confirmLabel: string;
  cancelLabel?: string;
  expected?: string;
}) => Promise<string | undefined>;

export async function runDashboardAction(args: {
  extensionContext: vscode.ExtensionContext;
  sourcePanel: vscode.WebviewPanel;
  action: DashboardAction;
  payload?: unknown;
  post: (message: PanelToWebviewMessage) => Promise<void>;
  postTo: (panel: vscode.WebviewPanel, message: PanelToWebviewMessage) => Promise<void>;
  confirm: (message: string, confirmLabel: string) => Promise<boolean>;
  promptWithPanel: PromptWithPanel;
  openCommitEditor: (initialMessage: string) => void;
  getAbortController: () => AbortController | undefined;
  setAbortController: (controller: AbortController | undefined) => void;
}): Promise<void> {
  const { action, payload, sourcePanel } = args;

  if (action === 'openCommitEditor') {
    const initialMessage = isRecord(payload) && typeof payload.message === 'string' ? payload.message : '';
    args.openCommitEditor(initialMessage);
    return;
  }

  if (args.getAbortController()) {
    await args.post({
      type: 'toast',
      level: 'error',
      message: 'A task is already running. Cancel it or wait for it to finish.'
    });
    return;
  }

  const startedAt = Date.now();
  args.setAbortController(new AbortController());

  const log = async (level: LogLevel, text: string) => {
    await args.post({ type: 'log', level, message: text });
  };

  await args.post({ type: 'runState', state: 'running', action });

  try {
    if (action === 'openSettings') {
      await vscode.commands.executeCommand('workbench.action.openSettings');
      await args.post({ type: 'toast', level: 'success', message: 'Opened Settings.' });
      return;
    }

    const root = getWorkspaceRoot();
    const cfg = await getConfigWithSecrets(args.extensionContext);
    const git = createGit(root);

    await log('info', `workspace=${root}`);
    await log('info', `ai.baseUrl=${cfg.ai.baseUrl}`);
    await log('info', `ai.model=${cfg.ai.model}`);

    const renderBranches = async (): Promise<void> => {
      const b = await getLocalBranches(git);
      await args.post({ type: 'branches', current: b.current, branches: b.all });
    };

    const renderWorkingFiles = async (): Promise<void> => {
      const s = await git.status();
      const files = (s.files ?? [])
        .filter((f) => f.working_dir && f.working_dir !== ' ')
        .slice(0, 200)
        .map((f) => {
          const pathText = String(f.path || '');
          const wd = String(f.working_dir || '');
          const idx = String(f.index || '');
          let kind: 'modified' | 'untracked' | 'deleted' | 'renamed' | 'other' = 'other';
          if (idx === '?' || wd === '?') kind = 'untracked';
          else if (wd === 'D') kind = 'deleted';
          else if (wd === 'R') kind = 'renamed';
          else if (wd !== ' ') kind = 'modified';
          return { path: pathText, kind };
        })
        .filter((f) => f.path);
      await args.post({ type: 'workingFiles', files });
    };

    const renderCommits = async (): Promise<void> => {
      const commits = await getRecentCommits(git, 30);
      await args.post({ type: 'commits', commits });
    };

    const confirm = async (message: string, confirmLabel: string): Promise<boolean> => {
      return await args.confirm(message, confirmLabel);
    };

    const preflightText = (s: Awaited<ReturnType<typeof getStatusSummary>>): string => {
      const untracked = s.not_added + s.created;
      const parts: string[] = [];
      parts.push(`Branch: ${s.current || '(unknown)'}`);
      parts.push(`Staged: ${s.staged}`);
      parts.push(`Modified: ${s.modified}`);
      parts.push(`Untracked: ${untracked}`);
      parts.push(`Conflicted: ${s.conflicted}`);
      return parts.join('\n');
    };

    const isDirty = (s: Awaited<ReturnType<typeof getStatusSummary>>): boolean => {
      return (
        s.staged > 0 ||
        s.modified > 0 ||
        s.not_added > 0 ||
        s.created > 0 ||
        s.deleted > 0 ||
        s.renamed > 0 ||
        s.conflicted > 0
      );
    };

    let isRepo = false;
    try {
      isRepo = await git.checkIsRepo();
    } catch (err) {
      void err;
      isRepo = false;
    }

    if (!isRepo && action !== 'testConnection' && action !== 'initGit') {
      await args.postTo(sourcePanel, { type: 'repoState', state: 'needsInit', root });
      return;
    }

    if (action === 'initGit') {
      if (!isRepo) {
        await git.init();
      }
      await args.postTo(sourcePanel, { type: 'repoState', state: 'ready', root });
      const content = await renderStatusText(git);
      await renderBranches();
      await renderWorkingFiles();
      await renderCommits();
      await args.post({ type: 'result', action: 'gitStatus', title: 'Git Status', content });
      await args.post({
        type: 'toast',
        level: 'success',
        message: isRepo ? 'Git is already initialized.' : 'Git initialization completed.'
      });
      return;
    }

    if (isRepo) {
      await args.postTo(sourcePanel, { type: 'repoState', state: 'ready', root });
    }

    if (action === 'testConnection') {
      await log('info', 'calling AI...');
      const text = await testAiConnection(cfg.ai, args.getAbortController()!.signal);
      await log('success', 'AI responded.');
      await args.post({ type: 'result', action, title: 'Connection test result', content: text });
      await args.post({ type: 'toast', level: 'success', message: 'Connection test completed.' });
      return;
    }

    if (action === 'gitStatus') {
      const content = await renderStatusText(git);
      await renderBranches();
      await renderWorkingFiles();
      await renderCommits();
      await args.post({ type: 'result', action, title: 'Git Status', content });
      await args.post({ type: 'toast', level: 'success', message: 'Git status refreshed.' });
      return;
    }

    if (action === 'checkoutBranch') {
      if (!isRecord(payload) || typeof payload.branch !== 'string') {
        await args.post({ type: 'toast', level: 'error', message: 'Missing branch parameter.' });
        return;
      }

      await checkoutLocalBranch(git, payload.branch);
      const content = await renderStatusText(git);
      await renderBranches();
      await renderWorkingFiles();
      await renderCommits();
      await args.post({ type: 'result', action: 'gitStatus', title: 'Git Status', content });
      await args.post({ type: 'toast', level: 'success', message: `Switched to branch: ${payload.branch}` });
      return;
    }

    if (action === 'commitDetails') {
      if (!isRecord(payload) || typeof payload.hash !== 'string') {
        await args.post({ type: 'toast', level: 'error', message: 'Missing commit hash.' });
        return;
      }
      const hash = payload.hash.trim();
      if (!hash) {
        await args.post({ type: 'toast', level: 'error', message: 'Invalid commit hash.' });
        return;
      }
      const content = await getCommitDetails(git, hash);
      await args.postTo(sourcePanel, { type: 'commitDetails', hash, content });
      return;
    }

    if (action === 'resetToCommit') {
      if (
        !isRecord(payload) ||
        typeof payload.hash !== 'string' ||
        typeof payload.mode !== 'string' ||
        !['soft', 'mixed', 'hard'].includes(payload.mode)
      ) {
        await args.post({ type: 'toast', level: 'error', message: 'Missing reset parameters.' });
        return;
      }

      const ref = payload.hash.trim();
      const mode = payload.mode as 'soft' | 'mixed' | 'hard';

      if (!ref) {
        await args.post({ type: 'toast', level: 'error', message: 'Invalid commit hash.' });
        return;
      }

      if (mode === 'hard') {
        const s = await getStatusSummary(git);
        const token = await args.promptWithPanel({
          panel: sourcePanel,
          title: 'Dangerous action confirmation',
          message: `Hard reset will discard changes.\n\nPreflight:\n${preflightText(s)}\n\nA safety backup ref will be created.\nIf your working tree is dirty, a safety stash will also be created.\n\nType RESET to continue.`,
          placeholder: 'RESET',
          confirmLabel: 'Continue',
          cancelLabel: 'Cancel',
          expected: 'RESET'
        });
        if (token !== 'RESET') {
          await args.post({ type: 'toast', level: 'success', message: 'Hard reset cancelled.' });
          return;
        }

        const backupRef = await createSafetyBackupRef(git, 'hard-reset');
        await log('info', `safetyBackup=${backupRef}`);
        await args.post({ type: 'toast', level: 'success', message: `Safety backup created: ${backupRef}` });

        if (isDirty(s)) {
          try {
            const stash = await createSafetyStash(git, `git-genius: safety stash before hard reset (${ref})`);
            await log('info', `safetyStash=${stash.output || '(no output)'}`);
            if (stash.created) {
              await args.post({ type: 'toast', level: 'success', message: 'Safety stash created.' });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const ok = await confirm(`Safety stash failed.\n\n${msg}\n\nContinue without stash backup?`, 'Continue');
            if (!ok) {
              await args.post({ type: 'toast', level: 'success', message: 'Hard reset cancelled.' });
              return;
            }
          }
        }
      } else {
        const s = await getStatusSummary(git);
        const ok = await confirm(`Run: git reset --${mode} ${ref}?\n\nPreflight:\n${preflightText(s)}`, 'Continue');
        if (!ok) {
          await args.post({ type: 'toast', level: 'success', message: 'Reset cancelled.' });
          return;
        }
      }

      await resetTo(git, mode, ref);
      const content = await renderStatusText(git);
      await renderBranches();
      await renderWorkingFiles();
      await renderCommits();
      await args.post({ type: 'result', action: 'reset', title: `Reset --${mode}`, content });
      await args.post({ type: 'toast', level: 'success', message: 'Reset complete.' });
      return;
    }

    if (action === 'openDiff') {
      if (!isRecord(payload) || typeof payload.path !== 'string' || typeof payload.kind !== 'string') {
        await args.post({ type: 'toast', level: 'error', message: 'Missing diff parameters.' });
        return;
      }

      const requestedPath = payload.path.trim();
      if (!requestedPath) {
        await args.post({ type: 'toast', level: 'error', message: 'Invalid file path.' });
        return;
      }

      let abs: string;
      let relPath: string;
      try {
        abs = resolveWorkspacePath(root, requestedPath);
        relPath = path.relative(path.resolve(root), abs).replace(/\\/g, '/');
      } catch (err) {
        await args.post({ type: 'toast', level: 'error', message: toUserSafeErrorMessage(err) });
        return;
      }
      const rightFile = vscode.Uri.file(abs);

      const makeGitUri = (ref: string): vscode.Uri => {
        const q = new URLSearchParams({ ref, path: relPath }).toString();
        return vscode.Uri.parse(`git-genius-git:/${encodeURIComponent(relPath)}?${q}`);
      };
      const emptyUri = vscode.Uri.parse(`git-genius-empty:/${encodeURIComponent(relPath)}`);

      const kind = payload.kind;

      let left = makeGitUri('HEAD');
      let right = rightFile;
      let title = `Diff: ${relPath}`;

      if (kind === 'untracked') {
        left = emptyUri;
        right = rightFile;
        title = `Diff (untracked): ${relPath}`;
      } else if (kind === 'deleted') {
        left = makeGitUri('HEAD');
        right = emptyUri;
        title = `Diff (deleted): ${relPath}`;
      } else {
        left = makeGitUri('HEAD');
        right = rightFile;
      }

      await vscode.commands.executeCommand('vscode.diff', left, right, title);
      return;
    }

    if (action === 'stageFiles') {
      const rawPaths: unknown =
        isRecord(payload) && Array.isArray(payload.paths)
          ? (payload.paths as unknown[])
          : isRecord(payload) && Array.isArray(payload.files)
            ? (payload.files as unknown[])
            : [];

      let paths = (rawPaths as unknown[])
        .map((p) => (typeof p === 'string' ? p : isRecord(p) && typeof p.path === 'string' ? p.path : ''))
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 500);

      if (paths.length === 0) {
        await args.post({ type: 'toast', level: 'error', message: 'No file paths provided.' });
        return;
      }

      try {
        paths = paths.map((p) => path.relative(path.resolve(root), resolveWorkspacePath(root, p)).replace(/\\/g, '/'));
      } catch (err) {
        await args.post({ type: 'toast', level: 'error', message: toUserSafeErrorMessage(err) });
        return;
      }

      const posixPaths = paths.map((p) => p.replace(/\\/g, '/'));
      await git.raw(['add', '-A', '--', ...posixPaths]);
      await renderWorkingFiles();
      await args.post({ type: 'result', action, title: 'Staged selected files', content: await renderStatusText(git) });
      await args.post({ type: 'toast', level: 'success', message: 'Staged.' });
      return;
    }

    if (action === 'checkoutFiles') {
      const rawFiles: unknown =
        isRecord(payload) && Array.isArray(payload.files)
          ? (payload.files as unknown[])
          : isRecord(payload) && Array.isArray(payload.paths)
            ? (payload.paths as unknown[]).map((p) => ({ path: p, kind: 'other' }))
            : [];

      let files = (rawFiles as unknown[])
        .map((f) =>
          isRecord(f) && typeof f.path === 'string'
            ? { path: f.path.trim(), kind: typeof f.kind === 'string' ? f.kind : 'other' }
            : typeof f === 'string'
              ? { path: f.trim(), kind: 'other' }
              : { path: '', kind: 'other' }
        )
        .filter((f) => Boolean(f.path))
        .slice(0, 500);

      if (files.length === 0) {
        await args.post({ type: 'toast', level: 'error', message: 'No files provided.' });
        return;
      }

      try {
        files = files.map((f) => ({
          ...f,
          path: path.relative(path.resolve(root), resolveWorkspacePath(root, f.path)).replace(/\\/g, '/')
        }));
      } catch (err) {
        await args.post({ type: 'toast', level: 'error', message: toUserSafeErrorMessage(err) });
        return;
      }

      const s = await getStatusSummary(git);
      const untracked = files.filter((f) => f.kind === 'untracked').map((f) => f.path);
      const tracked = files.filter((f) => f.kind !== 'untracked').map((f) => f.path);
      const ok = await confirm(
        `Checkout selected files? This will discard local changes for these paths.\n\nFiles: ${files.length} (tracked: ${tracked.length}, untracked: ${untracked.length})\n\nPreflight:\n${preflightText(s)}\n\nA safety stash will be created before checkout.`,
        'Checkout'
      );
      if (!ok) {
        await args.post({ type: 'toast', level: 'success', message: 'Checkout cancelled.' });
        return;
      }

      const allPaths = files.map((f) => f.path);
      try {
        const stash = await createSafetyStash(
          git,
          `git-genius: safety stash before checkoutFiles (${files.length} files)`,
          allPaths
        );
        await log('info', `safetyStash=${stash.output || '(no output)'}`);
        if (stash.created) {
          await args.post({ type: 'toast', level: 'success', message: 'Safety stash created.' });
        }
      } catch (err) {
        const msg = toUserSafeErrorMessage(err);
        const ok2 = await confirm(`Safety stash failed.\n\n${msg}\n\nContinue without stash backup?`, 'Continue');
        if (!ok2) {
          await args.post({ type: 'toast', level: 'success', message: 'Checkout cancelled.' });
          return;
        }
      }

      if (tracked.length) {
        const posixPaths = tracked.map((p) => p.replace(/\\/g, '/'));
        await git.raw(['checkout', '--', ...posixPaths]);
      }

      if (untracked.length) {
        const unique = Array.from(new Set(untracked));
        for (const rel of unique) {
          const abs = resolveWorkspacePath(root, rel);
          try {
            await rm(abs, { recursive: true, force: true });
          } catch (err) {
            void err;
          }
        }
      }

      await renderWorkingFiles();
      await args.post({ type: 'result', action, title: 'Checked out files', content: await renderStatusText(git) });
      await args.post({ type: 'toast', level: 'success', message: 'Checked out.' });
      return;
    }

    if (action === 'stageAll') {
      await stageAll(git);
      await renderWorkingFiles();
      await args.post({ type: 'result', action, title: 'Staged all changes', content: await renderStatusText(git) });
      await args.post({ type: 'toast', level: 'success', message: 'All changes staged.' });
      return;
    }

    if (action === 'unstageAll') {
      await unstageAll(git);
      await renderWorkingFiles();
      await args.post({ type: 'result', action, title: 'Unstaged changes', content: await renderStatusText(git) });
      await args.post({ type: 'toast', level: 'success', message: 'Unstaged.' });
      return;
    }

    if (action === 'commitMessage') {
      const branch = await getHeadBranch(git);
      await log('info', `branch=${branch}`);
      await log('info', `diffScope=${cfg.commit.diffScope}`);
      const diff = await getDiff(git, cfg.commit.diffScope);

      if (!diff.trim()) {
        await args.post({
          type: 'toast',
          level: 'error',
          message: 'No diff found. Stage changes or switch diff scope.'
        });
        return;
      }

      await log('info', 'calling AI...');
      await args.post({ type: 'streamStart', action, title: 'Commit Message (streaming)' });
      let buffered = '';
      let lastPostAt = 0;
      const flush = async () => {
        if (!buffered) return;
        await args.post({ type: 'streamDelta', action, chunk: buffered });
        buffered = '';
        lastPostAt = Date.now();
      };

      const message = await streamCommitMessage(
        cfg.ai,
        { diff, branch },
        async (chunk) => {
          buffered += chunk;
          if (buffered.length >= 160 || Date.now() - lastPostAt >= 80) {
            await flush();
          }
        },
        args.getAbortController()!.signal
      );
      await flush();

      await vscode.commands.executeCommand('workbench.view.scm');
      if (vscode.scm?.inputBox) {
        vscode.scm.inputBox.value = message;
        await log('success', 'filled into SCM input box.');
      } else {
        await vscode.env.clipboard.writeText(message);
        await log('warn', 'SCM input box unavailable; copied to clipboard.');
      }

      await args.post({ type: 'result', action, title: 'Commit Message', content: message });
      await args.post({ type: 'toast', level: 'success', message: 'Commit message generated.' });
      return;
    }

    if (action === 'rewriteCommitMessage') {
      const currentMessage = isRecord(payload) && typeof payload.message === 'string' ? payload.message : '';
      const mode = isRecord(payload) && typeof payload.mode === 'string' ? payload.mode : '';
      const style = isRecord(payload) && typeof payload.style === 'string' ? payload.style : '';
      const lang = isRecord(payload) && typeof payload.lang === 'string' ? payload.lang : '';

      if (!currentMessage.trim()) {
        await args.post({ type: 'toast', level: 'error', message: 'No commit message provided.' });
        return;
      }

      let selectedStyle = style;
      let selectedLang = lang;
      if (!selectedStyle && !selectedLang && mode) {
        if (mode === 'zh' || mode === 'en') selectedLang = mode;
        else selectedStyle = mode;
      }

      const baseInstruction = 'Improve clarity while keeping it correct.';
      const styleInstruction =
        selectedStyle === 'shorter'
          ? 'Make it shorter and more direct.'
          : selectedStyle === 'moreDetailed'
            ? 'Add a bit more detail in the body if useful.'
            : selectedStyle === 'moreFormal'
              ? 'Make the tone more formal and professional.'
              : '';
      const langInstruction =
        selectedLang === 'zh'
          ? 'Rewrite in Simplified Chinese.'
          : selectedLang === 'en'
            ? 'Rewrite in English.'
            : '';

      const instruction = [baseInstruction, styleInstruction, langInstruction].filter(Boolean).join(' ');

      const branch = await getHeadBranch(git);
      const status = await getStatusSummary(git);
      const diffScope = status.staged > 0 ? 'staged' : cfg.commit.diffScope;
      const diff = await getDiff(git, diffScope);

      await log('info', `branch=${branch}`);
      await log(
        'info',
        `rewrite=${[selectedStyle || 'auto', selectedLang || 'auto'].join('+')}${mode ? ` (legacy:${mode})` : ''}`
      );
      await log('info', 'calling AI...');

      await args.post({ type: 'streamStart', action, title: 'Commit Message (rewriting)' });
      let buffered = '';
      let lastPostAt = 0;
      const flush = async () => {
        if (!buffered) return;
        await args.post({ type: 'streamDelta', action, chunk: buffered });
        buffered = '';
        lastPostAt = Date.now();
      };

      const next = await streamRewrittenCommitMessage(
        cfg.ai,
        { currentMessage, instruction, branch, diff },
        async (chunk) => {
          buffered += chunk;
          if (buffered.length >= 160 || Date.now() - lastPostAt >= 80) {
            await flush();
          }
        },
        args.getAbortController()!.signal
      );
      await flush();

      await vscode.commands.executeCommand('workbench.view.scm');
      if (vscode.scm?.inputBox) {
        vscode.scm.inputBox.value = next;
      }

      await args.post({ type: 'result', action, title: 'Commit Message', content: next });
      await args.post({ type: 'toast', level: 'success', message: 'Commit message updated.' });
      return;
    }

    if (action === 'commitGenerated') {
      const status = await getStatusSummary(git);
      if (status.staged === 0) {
        await args.post({
          type: 'toast',
          level: 'error',
          message: 'No staged changes. Stage changes before committing.'
        });
        return;
      }

      let message: string;

      if (isRecord(payload) && typeof payload.message === 'string' && payload.message.trim()) {
        message = payload.message;
      } else {
        const branch = await getHeadBranch(git);
        await log('info', `branch=${branch}`);
        const diff = await getDiff(git, 'staged');
        if (!diff.trim()) {
          await args.post({ type: 'toast', level: 'error', message: 'No staged diff found. Stage changes first.' });
          return;
        }

        await log('info', 'calling AI...');
        await args.post({ type: 'streamStart', action, title: 'Commit Message (streaming)' });
        let buffered = '';
        let lastPostAt = 0;
        const flush = async () => {
          if (!buffered) return;
          await args.post({ type: 'streamDelta', action, chunk: buffered });
          buffered = '';
          lastPostAt = Date.now();
        };

        message = await streamCommitMessage(
          cfg.ai,
          { diff, branch },
          async (chunk) => {
            buffered += chunk;
            if (buffered.length >= 160 || Date.now() - lastPostAt >= 80) {
              await flush();
            }
          },
          args.getAbortController()!.signal
        );
        await flush();
      }

      const ok = await confirm('Commit changes?', 'Commit');
      if (!ok) {
        await args.post({ type: 'toast', level: 'success', message: 'Commit cancelled.' });
        return;
      }

      const hash = await commitWithMessage(git, message);
      await vscode.env.clipboard.writeText(message);
      await renderWorkingFiles();
      await renderCommits();

      await args.post({
        type: 'result',
        action,
        title: hash ? `Committed ${hash.slice(0, 7)}` : 'Committed',
        content: `${message.trimEnd()}\n\n${await renderStatusText(git)}`
      });
      await args.post({ type: 'toast', level: 'success', message: 'Committed.' });
      return;
    }

    if (action === 'amendGenerated') {
      const status = await getStatusSummary(git);
      if (status.staged === 0) {
        await args.post({
          type: 'toast',
          level: 'error',
          message: 'No staged changes. Stage changes before amending.'
        });
        return;
      }

      let message: string;

      if (isRecord(payload) && typeof payload.message === 'string' && payload.message.trim()) {
        message = payload.message;
      } else {
        const branch = await getHeadBranch(git);
        await log('info', `branch=${branch}`);
        const diff = await getDiff(git, 'staged');
        if (!diff.trim()) {
          await args.post({ type: 'toast', level: 'error', message: 'No staged diff found. Stage changes first.' });
          return;
        }

        await log('info', 'calling AI...');
        await args.post({ type: 'streamStart', action, title: 'Commit Message (streaming)' });
        let buffered = '';
        let lastPostAt = 0;
        const flush = async () => {
          if (!buffered) return;
          await args.post({ type: 'streamDelta', action, chunk: buffered });
          buffered = '';
          lastPostAt = Date.now();
        };

        message = await streamCommitMessage(
          cfg.ai,
          { diff, branch },
          async (chunk) => {
            buffered += chunk;
            if (buffered.length >= 160 || Date.now() - lastPostAt >= 80) {
              await flush();
            }
          },
          args.getAbortController()!.signal
        );
        await flush();
      }

      const ok = await confirm('Amend the last commit?', 'Amend');
      if (!ok) {
        await args.post({ type: 'toast', level: 'success', message: 'Amend cancelled.' });
        return;
      }

      const hash = await amendWithMessage(git, message);
      await vscode.env.clipboard.writeText(message);
      await renderWorkingFiles();
      await renderCommits();

      await args.post({
        type: 'result',
        action,
        title: hash ? `Amended ${hash.slice(0, 7)}` : 'Amended',
        content: `${message.trimEnd()}\n\n${await renderStatusText(git)}`
      });
      await args.post({ type: 'toast', level: 'success', message: 'Amended.' });
      return;
    }

    if (action === 'push') {
      const ok = await confirm('Push the current branch to origin?', 'Push');
      if (!ok) {
        await args.post({ type: 'toast', level: 'success', message: 'Push cancelled.' });
        return;
      }

      await pushCurrentBranch(git);
      await args.post({ type: 'result', action, title: 'Pushed', content: await renderStatusText(git) });
      await args.post({ type: 'toast', level: 'success', message: 'Pushed.' });
      return;
    }

    if (action === 'pull') {
      const ok = await confirm('Pull the current branch from origin?', 'Pull');
      if (!ok) {
        await args.post({ type: 'toast', level: 'success', message: 'Pull cancelled.' });
        return;
      }

      await pullCurrentBranch(git);
      await args.post({ type: 'result', action, title: 'Pulled', content: await renderStatusText(git) });
      await args.post({ type: 'toast', level: 'success', message: 'Pulled.' });
      return;
    }

    if (action === 'revert') {
      const commits = await getRecentCommits(git, 30);
      if (commits.length === 0) {
        await args.post({ type: 'toast', level: 'error', message: 'No commits found in this repo.' });
        return;
      }

      const picked = await vscode.window.showQuickPick(
        commits.map((c) => ({
          label: `${c.hash.slice(0, 7)} ${c.message}`,
          description: `${c.authorName} · ${c.date}`,
          hash: c.hash
        })),
        { title: 'Select a commit to revert (creates a new revert commit)' }
      );
      if (!picked) {
        await args.post({ type: 'toast', level: 'success', message: 'Revert cancelled.' });
        return;
      }

      const ok = await confirm(`Revert: ${picked.label}?`, 'Revert');
      if (!ok) {
        await args.post({ type: 'toast', level: 'success', message: 'Revert cancelled.' });
        return;
      }

      await revertCommit(git, picked.hash);
      await renderWorkingFiles();
      await renderCommits();
      await args.post({ type: 'result', action, title: 'Reverted', content: await renderStatusText(git) });
      await args.post({ type: 'toast', level: 'success', message: 'Reverted.' });
      return;
    }

    if (action === 'reset') {
      const option = await vscode.window.showQuickPick(
        [
          { label: 'Undo last commit (keep changes)', mode: 'soft' as const, ref: 'HEAD~1', dangerous: false },
          { label: 'Undo last commit (unstage changes)', mode: 'mixed' as const, ref: 'HEAD~1', dangerous: false },
          { label: 'Hard reset last commit (discard changes)', mode: 'hard' as const, ref: 'HEAD~1', dangerous: true },
          { label: 'Reset to a specific commit…', mode: undefined, ref: undefined, dangerous: true }
        ],
        { title: 'Reset (be careful)' }
      );
      if (!option) {
        await args.post({ type: 'toast', level: 'success', message: 'Reset cancelled.' });
        return;
      }

      let mode: 'soft' | 'mixed' | 'hard';
      let ref: string;

      if (option.mode && option.ref) {
        mode = option.mode;
        ref = option.ref;
      } else {
        const commits = await getRecentCommits(git, 30);
        if (commits.length === 0) {
          await args.post({ type: 'toast', level: 'error', message: 'No commits found in this repo.' });
          return;
        }

        const target = await vscode.window.showQuickPick(
          commits.map((c) => ({
            label: `${c.hash.slice(0, 7)} ${c.message}`,
            description: `${c.authorName} · ${c.date}`,
            hash: c.hash
          })),
          { title: 'Select a reset target (HEAD will move to this commit)' }
        );
        if (!target) {
          await args.post({ type: 'toast', level: 'success', message: 'Reset cancelled.' });
          return;
        }
        ref = target.hash;

        const modePick = await vscode.window.showQuickPick(
          [
            { label: 'soft (keep changes)', mode: 'soft' as const, dangerous: false },
            { label: 'mixed (unstage changes)', mode: 'mixed' as const, dangerous: false },
            { label: 'hard (discard changes)', mode: 'hard' as const, dangerous: true }
          ],
          { title: 'Select a reset mode' }
        );
        if (!modePick) {
          await args.post({ type: 'toast', level: 'success', message: 'Reset cancelled.' });
          return;
        }
        mode = modePick.mode;
        option.dangerous = modePick.dangerous;
      }

      if (mode === 'hard') {
        const s = await getStatusSummary(git);
        const token = await args.promptWithPanel({
          panel: sourcePanel,
          title: 'Dangerous action confirmation',
          message: `Hard reset will discard changes.\n\nPreflight:\n${preflightText(s)}\n\nA safety backup ref will be created.\nIf your working tree is dirty, a safety stash will also be created.\n\nType RESET to continue.`,
          placeholder: 'RESET',
          confirmLabel: 'Continue',
          cancelLabel: 'Cancel',
          expected: 'RESET'
        });
        if (token !== 'RESET') {
          await args.post({ type: 'toast', level: 'success', message: 'Hard reset cancelled.' });
          return;
        }

        const backupRef = await createSafetyBackupRef(git, 'hard-reset');
        await log('info', `safetyBackup=${backupRef}`);
        await args.post({ type: 'toast', level: 'success', message: `Safety backup created: ${backupRef}` });

        if (isDirty(s)) {
          try {
            const stash = await createSafetyStash(git, `git-genius: safety stash before hard reset (${ref})`);
            await log('info', `safetyStash=${stash.output || '(no output)'}`);
            if (stash.created) {
              await args.post({ type: 'toast', level: 'success', message: 'Safety stash created.' });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const ok = await confirm(`Safety stash failed.\n\n${msg}\n\nContinue without stash backup?`, 'Continue');
            if (!ok) {
              await args.post({ type: 'toast', level: 'success', message: 'Hard reset cancelled.' });
              return;
            }
          }
        }
      } else {
        const s = await getStatusSummary(git);
        const ok = await confirm(`Run: git reset --${mode} ${ref}?\n\nPreflight:\n${preflightText(s)}`, 'Continue');
        if (!ok) {
          await args.post({ type: 'toast', level: 'success', message: 'Reset cancelled.' });
          return;
        }
      }

      await resetTo(git, mode, ref);
      await renderWorkingFiles();
      await renderCommits();
      await args.post({ type: 'result', action, title: `Reset --${mode}`, content: await renderStatusText(git) });
      await args.post({ type: 'toast', level: 'success', message: 'Reset complete.' });
      return;
    }

    if (action === 'changelog') {
      const commits = await getRecentCommits(git, 200);
      if (commits.length === 0) {
        await args.post({ type: 'toast', level: 'error', message: 'No commits found in this repo.' });
        return;
      }

      const commitLines = commits.map((c) => `${c.hash.slice(0, 7)} ${c.message}`);
      await log('info', `commits=${commits.length}`);
      await log('info', 'calling AI...');

      await args.post({ type: 'streamStart', action, title: 'CHANGELOG (streaming)' });
      let buffered = '';
      let lastPostAt = 0;
      const flush = async () => {
        if (!buffered) return;
        await args.post({ type: 'streamDelta', action, chunk: buffered });
        buffered = '';
        lastPostAt = Date.now();
      };

      const markdown = await streamChangelog(
        cfg.ai,
        { commits: commitLines },
        async (chunk) => {
          buffered += chunk;
          if (buffered.length >= 240 || Date.now() - lastPostAt >= 120) {
            await flush();
          }
        },
        args.getAbortController()!.signal
      );
      await flush();

      await args.post({ type: 'result', action, title: 'CHANGELOG', content: markdown.trimEnd() });
      await args.post({ type: 'toast', level: 'success', message: 'CHANGELOG generated.' });
      return;
    }

    if (action === 'prDescription') {
      const branch = await getHeadBranch(git);
      const baseRef = cfg.pr.baseRef?.trim() ? cfg.pr.baseRef.trim() : await detectBaseRef(git);
      await log('info', `branch=${branch}`);
      await log('info', `baseRef=${baseRef}`);

      const diff = await getCompareDiff(git, baseRef);
      if (!diff.trim()) {
        await args.post({ type: 'toast', level: 'error', message: `No difference between ${baseRef} and HEAD.` });
        return;
      }

      await log('info', 'building summary...');
      const summary = await getCompareSummary(git, baseRef);
      await log('info', 'calling AI...');

      await args.post({ type: 'streamStart', action, title: 'PR Description (streaming draft JSON)' });
      let buffered = '';
      let lastPostAt = 0;
      const flush = async () => {
        if (!buffered) return;
        await args.post({ type: 'streamDelta', action, chunk: buffered });
        buffered = '';
        lastPostAt = Date.now();
      };

      const out = await streamPrDescription(
        cfg,
        { baseRef, branch, summary, diff },
        async (chunk) => {
          buffered += chunk;
          if (buffered.length >= 240 || Date.now() - lastPostAt >= 120) {
            await flush();
          }
        },
        args.getAbortController()!.signal
      );
      await flush();

      await vscode.env.clipboard.writeText(out.clipboardText);
      await log('success', 'copied to clipboard.');

      await args.post({ type: 'result', action, title: 'PR Description (copied)', content: out.clipboardText.trimEnd() });
      await args.post({ type: 'toast', level: 'success', message: 'PR description generated and copied to clipboard.' });
      return;
    }
  } catch (err) {
    const msg = toUserSafeErrorMessage(err);
    await log('error', msg);
    await args.post({ type: 'toast', level: 'error', message: msg });
  } finally {
    args.setAbortController(undefined);
    await args.post({ type: 'runState', state: 'idle', action, durationMs: Date.now() - startedAt });
  }
}
