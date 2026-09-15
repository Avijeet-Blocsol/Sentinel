import 'dotenv/config';

import { ensureConfiguredScheduler } from './scheduler_registration.js';
import { usesAwsInfrastructure } from '../config/infrastructure_mode.js';

if (!usesAwsInfrastructure()) {
  throw new Error('EventBridge registration is disabled in local infrastructure mode');
}

await ensureConfiguredScheduler();

console.log('Sentinel EventBridge schedule ensured');
