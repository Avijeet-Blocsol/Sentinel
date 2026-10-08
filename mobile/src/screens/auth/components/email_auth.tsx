import { useState } from "react";
import {
  View,
  Pressable,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import {
  Text,
  Button,
  Input,
  Separator,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui";
import { KeyRound, ArrowLeft } from "lucide-react-native";
import Toast from "react-native-toast-message";
import * as Haptics from "expo-haptics";
import { useClerk, useSignIn, useSignUp } from "@clerk/expo";

export function EmailAuth() {
  const { signIn, fetchStatus: signInFetchStatus } = useSignIn();
  const { signUp, fetchStatus: signUpFetchStatus } = useSignUp();
  const { setActive } = useClerk();

  const [authMode, setAuthMode] = useState<"sign_in" | "sign_up">("sign_in");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);

  const isFetching =
    (authMode === "sign_in" ? signInFetchStatus : signUpFetchStatus) ===
    "fetching";

  // 1. Send Email Verification Code (Modern Clerk Signals API)
  const handleSendEmailCode = async () => {
    if (!email.trim() || !email.includes("@")) {
      const msg = "Please enter a valid email address.";
      Toast.show({
        type: "error",
        text1: "Invalid Email",
        text2: msg,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }

    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      if (authMode === "sign_in") {
        const { error: createError } = await signIn.create({
          identifier: email.trim(),
        });

        if (createError) {
          throw new Error(createError.message || "Failed to initiate sign-in.");
        }

        const { error: sendError } = await signIn.emailCode.sendCode();
        if (sendError) {
          throw new Error(sendError.message || "Failed to send verification code.");
        }

        setIsVerifying(true);
        Toast.show({
          type: "success",
          text1: "Verification Code Sent",
          text2: `One-time code dispatched to ${email.trim()}`,
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        const { error: createError } = await signUp.create({
          emailAddress: email.trim(),
        });

        if (createError) {
          throw new Error(createError.message || "Failed to initiate sign-up.");
        }

        const { error: sendError } = await signUp.verifications.sendEmailCode();
        if (sendError) {
          throw new Error(sendError.message || "Failed to send verification code.");
        }

        setIsVerifying(true);
        Toast.show({
          type: "success",
          text1: "Account Created",
          text2: `Verification code dispatched to ${email.trim()}`,
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (err: any) {
      const message =
        err?.errors?.[0]?.longMessage ||
        err?.errors?.[0]?.message ||
        err?.message ||
        "Failed to send verification code.";
      Toast.show({
        type: "error",
        text1: "Dispatch Error",
        text2: message,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  // 2. Verify Code & Finalize Session (Modern Clerk Signals API)
  const handleVerifyCode = async () => {
    if (!code.trim()) {
      const msg = "Please enter the 6-digit verification code.";
      Toast.show({
        type: "warning",
        text1: "Code Required",
        text2: msg,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }

    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

      if (authMode === "sign_in") {
        const { error: verifyError } = await signIn.emailCode.verifyCode({
          code: code.trim(),
        });

        if (verifyError) {
          throw new Error(verifyError.message || "Invalid verification code.");
        }

        if (signIn.status === "complete" && signIn.createdSessionId) {
          if (!setActive) throw new Error("Clerk session activation is unavailable.");
          await setActive({ session: signIn.createdSessionId });
          Toast.show({
            type: "success",
            text1: "Access Granted",
            text2: "Sentinel observer node activated.",
          });
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } else {
          throw new Error(
            "Sign-in could not be completed. Please check your code.",
          );
        }
      } else {
        const { error: verifyError } = await signUp.verifications.verifyEmailCode({
          code: code.trim(),
        });

        if (verifyError) {
          throw new Error(verifyError.message || "Invalid verification code.");
        }

        if (signUp.status === "complete" && signUp.createdSessionId) {
          if (!setActive) throw new Error("Clerk session activation is unavailable.");
          await setActive({ session: signUp.createdSessionId });
          Toast.show({
            type: "success",
            text1: "Account Verified",
            text2: "Observer registration complete.",
          });
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } else {
          throw new Error(
            "Account verification could not be completed. Please check your code.",
          );
        }
      }
    } catch (err: any) {
      const message =
        err?.errors?.[0]?.longMessage ||
        err?.errors?.[0]?.message ||
        err?.message ||
        "Verification failed. Please check the code.";
      Toast.show({
        type: "error",
        text1: "Verification Failed",
        text2: message,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const handleResetVerification = () => {
    setIsVerifying(false);
    setCode("");
  };

  return (
    <>
      {!isVerifying ? (
        <>
          <View className="relative my-2 justify-center">
            <Separator />
            <View className="absolute inset-x-0 items-center">
              <Text className="bg-[#090b10] px-2 text-[10px] font-bold text-muted-foreground uppercase font-mono">
                OR DIRECT EMAIL VERIFICATION
              </Text>
            </View>
          </View>

          {/* Mode Selector Tabs */}
          <View className="flex-row rounded-xl bg-surface p-1 border border-border h-12 items-center">
            <Pressable
              hitSlop={8}
              onPress={() => {
                Haptics.selectionAsync();
                setAuthMode("sign_in");
              }}
              style={[styles.tab, authMode === "sign_in" && styles.activeTab]}
            >
              <Text
                variant="small"
                style={{
                  color: authMode === "sign_in" ? "#050505" : "#9CA3AF",
                }}
                className="font-bold text-xs"
              >
                Sign In
              </Text>
            </Pressable>
            <Pressable
              hitSlop={8}
              onPress={() => {
                Haptics.selectionAsync();
                setAuthMode("sign_up");
              }}
              style={[styles.tab, authMode === "sign_up" && styles.activeTab]}
            >
              <Text
                variant="small"
                style={{
                  color: authMode === "sign_up" ? "#050505" : "#9CA3AF",
                }}
                className="font-bold text-xs"
              >
                Create Account
              </Text>
            </Pressable>
          </View>

          {/* Email Input Field */}
          <View className="gap-2">
            <View className="gap-1.5">
              <Text
                variant="small"
                className="font-bold uppercase tracking-wider text-muted-foreground text-[10px]"
              >
                Email
              </Text>
              <Input
                value={email}
                onChangeText={setEmail}
                placeholder="agent@sentinel.network"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                className="h-12 rounded-xl text-sm px-4 bg-surface/80 border-border text-foreground"
              />
              <Text variant="muted" className="text-[10px]">
                We will send a one-time verification code to this address.
              </Text>
            </View>

            <Button
              variant="default"
              onPress={handleSendEmailCode}
              disabled={isFetching}
              className="h-12 rounded-xl"
            >
              {isFetching ? (
                <ActivityIndicator size="small" color="#050505" />
              ) : (
                <Text className="font-bold tracking-wide">Send Code</Text>
              )}
            </Button>
          </View>
        </>
      ) : (
        <Card className="border-neon-border bg-surface shadow-lg shadow-neon/10">
          <CardHeader>
            <View className="flex-row items-center gap-2 mb-1">
              <KeyRound size={18} color="#0DF272" />
              <CardTitle className="text-base">
                Enter Verification Code
              </CardTitle>
            </View>
            <CardDescription className="text-xs">
              Security code sent to{" "}
              <Text className="font-mono text-neon font-bold">
                {email}
              </Text>
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-3">
            <Input
              value={code}
              onChangeText={setCode}
              placeholder="123456"
              keyboardType="numeric"
              maxLength={8}
              className="h-12 rounded-xl text-center font-mono text-xl tracking-[6px] text-neon bg-surface/80 border-border"
              autoFocus
            />

            <Button
              variant="default"
              onPress={handleVerifyCode}
              disabled={isFetching}
              className="h-12 rounded-xl"
            >
              {isFetching ? (
                <ActivityIndicator size="small" color="#050505" />
              ) : (
                <Text className="font-bold tracking-wide">
                  Verify & Authenticate
                </Text>
              )}
            </Button>

            <Pressable
              onPress={handleResetVerification}
              disabled={isFetching}
              className="flex-row items-center justify-center gap-1.5 py-1"
            >
              <ArrowLeft size={13} color="#8B949E" />
              <Text variant="muted" className="text-xs underline">
                Use a different email address
              </Text>
            </Pressable>
          </CardContent>
        </Card>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  tab: {
    flex: 1,
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  activeTab: {
    backgroundColor: "#0DF272",
  },
});
