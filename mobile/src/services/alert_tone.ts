import type { AudioTone } from '@sentinel/shared';

export const DEFAULT_ALERT_TONE: AudioTone = 'chime';

const VALID_ALERT_TONES = new Set<AudioTone>([
  'cash_register',
  'siren',
  DEFAULT_ALERT_TONE,
]);

/** Normalize untrusted or legacy alert data to a bundled sound asset. */
export function resolveAlertTone(tone: unknown): AudioTone {
  return typeof tone === 'string' && VALID_ALERT_TONES.has(tone as AudioTone)
    ? tone as AudioTone
    : DEFAULT_ALERT_TONE;
}
