import * as vscode from 'vscode';

export type DiffScope = 'staged' | 'workingTree';
export type PrPlatform = 'github' | 'gitlab' | 'bitbucket';

export interface ExtensionConfig {
  ai: {
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
  };
  commit: {
    diffScope: DiffScope;
  };
  changelog: {
    path: string;
  };
  pr: {
    platform: PrPlatform;
    baseRef: string;
    includeChecklist: boolean;
  };
}

export function getConfig(): ExtensionConfig {
  const c = vscode.workspace.getConfiguration('commitGenius');
  return {
    ai: {
      baseUrl: c.get<string>('ai.baseUrl', 'https://api.openai.com/v1'),
      apiKey: c.get<string>('ai.apiKey', ''),
      model: c.get<string>('ai.model', 'gpt-4o-mini'),
      temperature: c.get<number>('ai.temperature', 0.2)
    },
    commit: {
      diffScope: c.get<DiffScope>('commit.diffScope', 'staged')
    },
    changelog: {
      path: c.get<string>('changelog.path', 'CHANGELOG.md')
    },
    pr: {
      platform: c.get<PrPlatform>('pr.platform', 'github'),
      baseRef: c.get<string>('pr.baseRef', ''),
      includeChecklist: c.get<boolean>('pr.includeChecklist', true)
    }
  };
}
