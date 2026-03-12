import * as vscode from 'vscode';
import { chatJson, toUserSafeErrorMessage } from '../utils/ai';
import { getConfigWithSecrets } from '../utils/config';
import { getAdapter } from '../adapters';
import { createGit, detectBaseRef, getCompareDiff, getCompareSummary, getHeadBranch } from '../utils/git';
import { prPrompt } from '../utils/prompts';
import { getWorkspaceRoot } from '../utils/workspace';

type PrJson = { title: string; body: string };

function isPrJson(value: unknown): value is PrJson {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.title === 'string' && typeof v.body === 'string';
}

export async function generatePrDescriptionCommand(context: vscode.ExtensionContext): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Commit Genius: Generating PR description' },
    async () => {
      try {
        const root = getWorkspaceRoot();
        const cfg = await getConfigWithSecrets(context);
        const git = createGit(root);

        const branch = await getHeadBranch(git);
        const baseRef = cfg.pr.baseRef?.trim() ? cfg.pr.baseRef.trim() : await detectBaseRef(git);
        const diff = await getCompareDiff(git, baseRef);

        if (!diff.trim()) {
          await vscode.window.showWarningMessage(`No changes found between ${baseRef} and HEAD.`);
          return;
        }

        const summary = await getCompareSummary(git, baseRef);
        const draft = await chatJson<PrJson>(
          cfg.ai,
          [
            { role: 'system', content: 'You write clear, reviewer-friendly pull request descriptions.' },
            { role: 'user', content: prPrompt({ baseRef, branch, summary, diff }) }
          ],
          isPrJson
        );

        const adapter = getAdapter(cfg.pr.platform);
        const formatted = adapter.formatDraft({ title: draft.title.trim(), body: draft.body.trim() }, { includeChecklist: cfg.pr.includeChecklist });

        const clipboardText = `# ${formatted.title}\n\n${formatted.body}\n`;
        await vscode.env.clipboard.writeText(clipboardText);
        await vscode.window.showInformationMessage('PR description generated and copied to clipboard.');
      } catch (err) {
        const msg = toUserSafeErrorMessage(err);
        await vscode.window.showErrorMessage(`Commit Genius: ${msg}`);
      }
    }
  );
}
