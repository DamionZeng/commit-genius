import * as vscode from 'vscode';
import { chatText } from '../utils/ai';
import { getConfig } from '../utils/config';
import { createGit, getDiff, getHeadBranch } from '../utils/git';
import { commitPrompt } from '../utils/prompts';
import { getWorkspaceRoot } from '../utils/workspace';

export async function generateCommitMessageCommand(): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Commit Genius: Generating commit message' },
    async () => {
      try {
        const root = getWorkspaceRoot();
        const cfg = getConfig();
        const git = createGit(root);
        const branch = await getHeadBranch(git);
        const diff = await getDiff(git, cfg.commit.diffScope);

        if (!diff.trim()) {
          await vscode.window.showWarningMessage('No diff found. Stage changes or switch diff scope.');
          return;
        }

        const message = await chatText(cfg.ai, [
          { role: 'system', content: 'You are a senior software engineer writing high-quality git commits.' },
          { role: 'user', content: commitPrompt({ diff, branch }) }
        ]);

        await vscode.commands.executeCommand('workbench.view.scm');
        if (vscode.scm?.inputBox) {
          vscode.scm.inputBox.value = message;
        } else {
          await vscode.env.clipboard.writeText(message);
          await vscode.window.showInformationMessage('Commit message copied to clipboard (SCM input box unavailable).');
          return;
        }

        await vscode.window.showInformationMessage('Commit message generated and filled into the Source Control input box.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await vscode.window.showErrorMessage(`Commit Genius: ${msg}`);
      }
    }
  );
}
