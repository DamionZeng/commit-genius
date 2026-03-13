import * as vscode from 'vscode';
import { writeFile } from 'fs/promises';
import { chatText, toUserSafeErrorMessage } from '../utils/ai';
import { getConfigWithSecrets } from '../utils/config';
import { createGit, getRecentCommits } from '../utils/git';
import { changelogPrompt } from '../utils/prompts';
import { getWorkspaceRoot, resolveWorkspacePath } from '../utils/workspace';

export async function generateChangelogCommand(context: vscode.ExtensionContext): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Git Genius: Generating CHANGELOG' },
    async () => {
      try {
        const root = getWorkspaceRoot();
        const cfg = await getConfigWithSecrets(context);
        const git = createGit(root);
        const commits = await getRecentCommits(git, 200);

        if (commits.length === 0) {
          await vscode.window.showWarningMessage('No commits found in this repository.');
          return;
        }

        const commitLines = commits.map((c) => `${c.hash.slice(0, 7)} ${c.message}`);
        const markdown = await chatText(cfg.ai, [
          { role: 'system', content: 'You generate clean, useful changelogs for developers.' },
          { role: 'user', content: changelogPrompt({ commits: commitLines }) }
        ]);

        const outPath = resolveWorkspacePath(root, cfg.changelog.path);
        await writeFile(outPath, markdown.trimEnd() + '\n', 'utf8');

        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(outPath));
        await vscode.window.showTextDocument(doc, { preview: false });

        await vscode.window.showInformationMessage(`CHANGELOG generated: ${cfg.changelog.path}`);
      } catch (err) {
        const msg = toUserSafeErrorMessage(err);
        await vscode.window.showErrorMessage(`Git Genius: ${msg}`);
      }
    }
  );
}
