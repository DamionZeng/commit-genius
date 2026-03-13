import * as vscode from 'vscode';

import { generateChangelogCommand } from './commands/generateChangelog';
import { generateCommitMessageCommand } from './commands/generateCommitMessage';
import { generatePrDescriptionCommand } from './commands/generatePrDescription';
import { EmptyContentProvider, GitRefContentProvider } from './dashboard/contentProviders';
import { DashboardPanel } from './dashboard/panel';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('git-genius-git', new GitRefContentProvider()),
    vscode.workspace.registerTextDocumentContentProvider('git-genius-empty', new EmptyContentProvider()),
    vscode.commands.registerCommand('gitGenius.generateCommitMessage', () => generateCommitMessageCommand(context)),
    vscode.commands.registerCommand('gitGenius.generateChangelog', () => generateChangelogCommand(context)),
    vscode.commands.registerCommand('gitGenius.generatePrDescription', () => generatePrDescriptionCommand(context)),
    vscode.commands.registerCommand('gitGenius.openPanel', () => DashboardPanel.createOrShow(context))
  );
}

export function deactivate() {
}
