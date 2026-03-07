import { PlatformAdapter, PrDraft } from './types';

export const gitlabAdapter: PlatformAdapter = {
  platform: 'gitlab',
  formatDraft(draft: PrDraft, options: { includeChecklist: boolean }): PrDraft {
    if (!options.includeChecklist) return draft;
    const checklist = [
      '',
      '## Checklist',
      '- [ ] Tests added/updated',
      '- [ ] Documentation updated (if needed)',
      '- [ ] Screenshots attached (if UI change)'
    ].join('\n');
    return { ...draft, body: `${draft.body.trim()}\n${checklist}\n` };
  }
};
