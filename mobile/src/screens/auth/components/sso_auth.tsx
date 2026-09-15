import { useState, useEffect } from "react";
import { View, Pressable, ActivityIndicator, Platform } from "react-native";
import { Text } from "@/components/ui";
import Svg, { G, Path } from "react-native-svg";
import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import * as Haptics from "expo-haptics";
import Toast from "react-native-toast-message";
import { useClerk } from "@clerk/expo";
import { useSSO } from "@clerk/expo/experimental";

type OAuthStrategy = "oauth_google" | "oauth_apple" | "oauth_github";

export function SSOAuth() {
  const { startSSOFlow } = useSSO();
  const { setActive } = useClerk();
  const [loadingAction, setLoadingAction] = useState<OAuthStrategy | null>(null);

  useEffect(() => {
    // Custom Tabs prewarming exists only on native platforms.
    if (Platform.OS === 'web') return undefined;
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);

  // 1. Social SSO (Google, Apple, GitHub)
  const handleSSOLogin = async (strategy: OAuthStrategy) => {
    const providerName =
      strategy === "oauth_google"
        ? "Google"
        : strategy === "oauth_apple"
          ? "Apple"
          : "GitHub";
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setLoadingAction(strategy);
      Toast.show({
        type: "info",
        text1: `Connecting with ${providerName}...`,
        text2: "Opening secure browser session",
      });

      const redirectUrl = AuthSession.makeRedirectUri({
        scheme: "sentinel",
        path: "sso-callback",
      });

      const { createdSessionId, authSessionResult, signIn: ssoSignIn, signUp: ssoSignUp } = await startSSOFlow({
        strategy,
        redirectUrl,
      });

      if (createdSessionId) {
        if (setActive) {
          await setActive({ session: createdSessionId });
        }
        Toast.show({
          type: "success",
          text1: "Access Granted",
          text2: `Successfully authenticated via ${providerName}`,
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else if (authSessionResult?.type === "cancel" || authSessionResult?.type === "dismiss") {
        Toast.show({
          type: "info",
          text1: "Login Dismissed",
          text2: "Authentication session was closed.",
        });
      } else {
        const errorDetail =
          (ssoSignIn as any)?.errors?.[0]?.message ||
          (ssoSignUp as any)?.errors?.[0]?.message ||
          "Session could not be established. Ensure sentinel://sso-callback is whitelisted in Clerk.";
        Toast.show({
          type: "error",
          text1: "Authentication Incomplete",
          text2: errorDetail,
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      }
    } catch (err: any) {
      console.error(`SSO Error (${strategy}):`, err);
      const message =
        err?.errors?.[0]?.longMessage ||
        err?.errors?.[0]?.message ||
        err?.message ||
        "Authentication failed. Please check credentials and try again.";
      Toast.show({
        type: "error",
        text1: `${providerName} Login Failed`,
        text2: message,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoadingAction(null);
    }
  };

  return (
    <>
      <Pressable
        onPress={() => handleSSOLogin("oauth_google")}
        disabled={loadingAction !== null}
        hitSlop={6}
        className="flex-row items-center justify-center gap-3 w-full h-12 rounded-xl bg-white active:bg-zinc-200 border border-zinc-300 py-3 px-4 active:scale-[0.98]"
      >
        {loadingAction === "oauth_google" ? (
          <ActivityIndicator size="small" color="#050505" />
        ) : (
          <Svg width={20} height={20} viewBox="0 0 24 24">
            <G>
              <Path
                fill="#EA4335"
                d="M12 5c1.56 0 2.97.55 4.09 1.45l3.07-3.07C17.3 1.61 14.82 1 12 1 7.55 1 3.73 3.56 1.86 7.29l3.75 2.91C6.5 7.42 9.01 5 12 5z"
              />
              <Path
                fill="#4285F4"
                d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58l3.72 2.89c2.18-2.01 3.7-4.99 3.7-8.71z"
              />
              <Path
                fill="#FBBC05"
                d="M5.61 14.79c-.23-.69-.36-1.43-.36-2.2s.13-1.51.36-2.2L1.86 7.48C1.08 9.03.64 10.77.64 12.59s.44 3.56 1.22 5.11l3.75-2.91z"
              />
              <Path
                fill="#34A853"
                d="M12 23.64c3.24 0 5.95-1.08 7.93-2.93l-3.72-2.89c-1.08.72-2.45 1.16-4.21 1.16-2.99 0-5.5-2.42-6.39-5.2L1.86 16.69C3.73 20.43 7.55 23.64 12 23.64z"
              />
            </G>
          </Svg>
        )}
        <Text className="text-zinc-900 font-bold text-sm tracking-wide">
          {loadingAction === "oauth_google"
            ? "Connecting with Google..."
            : "Continue with Google"}
        </Text>
      </Pressable>

      {/* 2. Secondary Social Providers (Apple & GitHub) */}
      <View className="flex-row gap-2">
        <Pressable
          onPress={() => handleSSOLogin("oauth_apple")}
          disabled={loadingAction !== null}
          className="flex-1 flex-row items-center justify-center gap-2 h-12 rounded-xl bg-surface active:bg-surface-hover border border-border py-2.5 px-3 active:scale-[0.98]"
        >
          {loadingAction === "oauth_apple" ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Svg width={18} height={18} viewBox="0 0 24 24">
              <Path
                fill="#FFFFFF"
                d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.84c.62-.75 1.04-1.8.92-2.84-.9.04-1.99.6-2.64 1.36-.58.67-1.09 1.74-.95 2.77.99.08 2.05-.54 2.67-1.29z"
              />
            </Svg>
          )}
          <Text className="text-white font-semibold text-xs">
            Apple
          </Text>
        </Pressable>

        <Pressable
          onPress={() => handleSSOLogin("oauth_github")}
          disabled={loadingAction !== null}
          className="flex-1 flex-row items-center justify-center gap-2 h-12 rounded-xl bg-surface active:bg-surface-hover border border-border py-2.5 px-3 active:scale-[0.98]"
        >
          {loadingAction === "oauth_github" ? (
            <ActivityIndicator size="small" color="#0DF272" />
          ) : (
            <Svg width={18} height={18} viewBox="0 0 24 24">
              <Path
                fill="#FFFFFF"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
              />
            </Svg>
          )}
          <Text className="text-white font-semibold text-xs">
            GitHub
          </Text>
        </Pressable>
      </View>
    </>
  );
}
