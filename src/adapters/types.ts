import { PrPlatform } from '../utils/config';

export interface PrDraft {
  title: string;
  body: string;
}

export interface PlatformAdapter {
  platform: PrPlatform;
  formatDraft(draft: PrDraft, options: { includeChecklist: boolean }): PrDraft;
}
