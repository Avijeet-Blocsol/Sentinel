import assert from 'node:assert/strict';
import { DEFAULT_ALERT_TONE, resolveAlertTone } from '../alert_tone';

assert.equal(DEFAULT_ALERT_TONE, 'chime');
assert.equal(resolveAlertTone(undefined), 'chime');
assert.equal(resolveAlertTone(null), 'chime');
assert.equal(resolveAlertTone(''), 'chime');
assert.equal(resolveAlertTone('missing_sound'), 'chime');
assert.equal(resolveAlertTone('cash_register'), 'cash_register');
assert.equal(resolveAlertTone('siren'), 'siren');
assert.equal(resolveAlertTone('chime'), 'chime');

console.log('PASS alert tones always resolve to a bundled sound');
