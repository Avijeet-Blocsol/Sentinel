import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export async function registerForPushNotificationsAsync(): Promise<{
  push_token: string;
  platform: 'ios' | 'android' | 'web';
} | null> {
  if (Platform.OS === 'web') return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Sentinel alerts',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      sound: 'default',
    });
  }

  const current = await Notifications.getPermissionsAsync();
  let status = current.status;
  if (status !== Notifications.PermissionStatus.GRANTED) {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }
  if (status !== Notifications.PermissionStatus.GRANTED) {
    console.info('[PushNotifications] Notification permission not granted');
    return null;
  }

  const projectId =
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID ||
    Constants.expoConfig?.extra?.eas?.projectId ||
    Constants.easConfig?.projectId;

  try {
    const tokenResponse = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    return {
      push_token: tokenResponse.data,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
    };
  } catch (error) {
    console.warn('[PushNotifications] Failed to obtain Expo push token:', error);
    return null;
  }
}

