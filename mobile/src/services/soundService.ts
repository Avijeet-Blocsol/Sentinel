/**
 * Strands Sentinel - Ambient Audio & Haptics Service (Expo SDK 57 / expo-audio)
 * Triggers instant audio ringtones and tactile patterns when Sentry rules fire.
 */

import type { AudioTone } from '@sentinel/shared';

let createAudioPlayer: any = null;
let setAudioModeAsync: any = null;
try {
  const expoAudio = require('expo-audio');
  createAudioPlayer = expoAudio.createAudioPlayer;
  setAudioModeAsync = expoAudio.setAudioModeAsync;
} catch {}

let Haptics: any = null;
try {
  Haptics = require('expo-haptics');
} catch {}

let soundMap: Record<string, any> = {};
try {
  soundMap = {
    cash_register: require('../../assets/sounds/cash_register.wav'),
    siren: require('../../assets/sounds/siren.wav'),
    chime: require('../../assets/sounds/chime.wav'),
  };
} catch {
  // In Node test environments, wav assets may not be resolvable
}

let isAudioConfigured = false;

async function configureAudio() {
  if (isAudioConfigured || !setAudioModeAsync) return;
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'duckOthers',
    });
    isAudioConfigured = true;
  } catch (err) {
    console.warn('[SoundService] Audio mode configuration warning:', err);
  }
}

export async function playAlertTone(tone: AudioTone = 'chime') {
  await configureAudio();

  // 1. Trigger synchronized tactical haptic feedback
  if (Haptics?.notificationAsync) {
    switch (tone) {
      case 'cash_register':
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        break;
      case 'siren':
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        break;
      case 'chime':
      default:
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        break;
    }
  }

  // 2. Play ambient audio waveform using Expo SDK 57 expo-audio
  if (createAudioPlayer) {
    try {
      const source = soundMap[tone] || soundMap.chime;
      if (source) {
        const player = createAudioPlayer(source);
        player.play();
      }
    } catch (error) {
      console.error(`[SoundService] Failed to play alert tone '${tone}':`, error);
    }
  }
}
