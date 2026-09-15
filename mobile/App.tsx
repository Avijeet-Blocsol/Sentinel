import './global.css';

// Polyfill window.location for Clerk JS in native React Native runtimes
if (typeof globalThis !== 'undefined') {
  const fallbackLocation = {
    href: 'https://sentinel.network',
    origin: 'https://sentinel.network',
    protocol: 'https:',
    host: 'sentinel.network',
    hostname: 'sentinel.network',
    port: '',
    pathname: '/',
    search: '',
    hash: '',
    assign: () => {},
    replace: () => {},
    reload: () => {},
  };
  if (!(globalThis as any).location) {
    (globalThis as any).location = fallbackLocation;
  }
  if ((globalThis as any).window && !(globalThis as any).window.location) {
    (globalThis as any).window.location = fallbackLocation;
  }
}

import { configureReanimatedLogger, ReanimatedLogLevel } from 'react-native-reanimated';

configureReanimatedLogger({
  level: ReanimatedLogLevel.warn,
  strict: false,
});

import { ActivityIndicator, StatusBar } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import Toast from 'react-native-toast-message';
import { ClerkProvider, useAuth } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import {
  Screen,
  SafeAreaProvider,
  toastConfig,
  Text,
} from '@/components/ui';
import { AuthScreen } from '@/screens/auth';
import { MainScreen } from '@/screens/user';
import { useSentinelBootstrap } from '@/hooks/use_sentinel';

// Complete redirect sessions on deep-link return
WebBrowser.maybeCompleteAuthSession();

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

function MissingConfigurationScreen() {
  return (
    <SafeAreaProvider>
      <Screen
        edges={['top', 'bottom', 'left', 'right']}
        className="flex-1 bg-obsidian items-center justify-center px-6"
      >
        <StatusBar barStyle="light-content" backgroundColor="#050505" />
        <Text variant="muted" className="text-center text-xs font-mono tracking-widest">
          CONFIGURATION REQUIRED
        </Text>
        <Text variant="muted" className="mt-3 text-center text-sm">
          Add EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY to mobile/.env and restart the app.
        </Text>
      </Screen>
    </SafeAreaProvider>
  );
}

function RootNavigator() {
  const { isLoaded, isSignedIn } = useAuth();
  useSentinelBootstrap();

  if (!isLoaded) {
    return (
      <Screen
        edges={['top', 'bottom', 'left', 'right']}
        className="flex-1 bg-obsidian items-center justify-center"
      >
        <StatusBar barStyle="light-content" backgroundColor="#050505" />
        <ActivityIndicator size="large" color="#0DF272" />
        <Text variant="muted" className="mt-3 text-xs font-mono tracking-widest">
          AUTHENTICATING...
        </Text>
      </Screen>
    );
  }

  return isSignedIn ? <MainScreen /> : <AuthScreen />;
}

export default function App() {
  if (!publishableKey) return <MissingConfigurationScreen />;

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <SafeAreaProvider>
        <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
          <RootNavigator />
          <Toast config={toastConfig} topOffset={60} />
        </KeyboardProvider>
      </SafeAreaProvider>
    </ClerkProvider>
  );
}
