import { PrPlatform } from '../utils/config';
import { bitbucketAdapter } from './bitbucket';
import { githubAdapter } from './github';
import { gitlabAdapter } from './gitlab';
import { PlatformAdapter } from './types';

export function getAdapter(platform: PrPlatform): PlatformAdapter {
  switch (platform) {
    case 'gitlab':
      return gitlabAdapter;
    case 'bitbucket':
      return bitbucketAdapter;
    case 'github':
    default:
      return githubAdapter;
  }
}
