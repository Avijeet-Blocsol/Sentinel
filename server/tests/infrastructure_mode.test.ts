import assert from 'node:assert/strict';
import {
  getInfrastructureMode,
  shouldRunEmbeddedEvaluator,
  usesAwsInfrastructure,
} from '../src/config/infrastructure_mode.js';

assert.equal(getInfrastructureMode({}), 'local');
assert.equal(getInfrastructureMode({ NODE_ENV: 'production' }), 'aws');
assert.equal(getInfrastructureMode({ SENTINEL_INFRASTRUCTURE_MODE: 'LOCAL' }), 'local');
assert.equal(getInfrastructureMode({ SENTINEL_INFRASTRUCTURE_MODE: 'aws' }), 'aws');
assert.equal(usesAwsInfrastructure({ SENTINEL_INFRASTRUCTURE_MODE: 'local' }), false);
assert.equal(usesAwsInfrastructure({ SENTINEL_INFRASTRUCTURE_MODE: 'aws' }), true);
assert.equal(shouldRunEmbeddedEvaluator({ NODE_ENV: 'production' }), false);
assert.throws(
  () => shouldRunEmbeddedEvaluator({ NODE_ENV: 'production', SENTINEL_INFRASTRUCTURE_MODE: 'local' }),
  /embedded evaluation is development-only/,
);
assert.throws(
  () => shouldRunEmbeddedEvaluator({ NODE_ENV: 'production', RUN_EMBEDDED_EVALUATOR: 'true' }),
  /must not run the embedded evaluator/,
);
assert.equal(shouldRunEmbeddedEvaluator({ SENTINEL_INFRASTRUCTURE_MODE: 'aws' }), false);
assert.equal(shouldRunEmbeddedEvaluator({
  SENTINEL_INFRASTRUCTURE_MODE: 'aws',
  RUN_EMBEDDED_EVALUATOR: 'true',
}), true);
assert.equal(shouldRunEmbeddedEvaluator({ RUN_EMBEDDED_EVALUATOR: 'false' }), false);
assert.throws(
  () => getInfrastructureMode({ SENTINEL_INFRASTRUCTURE_MODE: 'invalid' }),
  /must be either local or aws/,
);

console.log('PASS development defaults local while production defaults to AWS scheduling');
