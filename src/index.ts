import { PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';

import { EWeLinkPlatform } from './platform.js';

export { EWeLinkPlatform } from './platform.js';

/**
 * Entry point called by Matterbridge to create the plugin platform.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): EWeLinkPlatform {
  return new EWeLinkPlatform(matterbridge, log, config);
}
