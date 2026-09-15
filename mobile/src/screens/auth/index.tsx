import { useMemo } from "react";
import { View, Image, StyleSheet } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Screen, useSafeAreaInsets, Text, Card } from "@/components/ui";
import NeonGrid from "./components/neon_grid";
import { SSOAuth } from "./components/sso_auth";
import { EmailAuth } from "./components/email_auth";

export function AuthScreen() {
  const insets = useSafeAreaInsets();

  const memoizedNeonGrid = useMemo(
    () => (
      <View
        style={[StyleSheet.absoluteFill, { zIndex: -1 }]}
        pointerEvents="none"
      >
        <NeonGrid />
      </View>
    ),
    [],
  );

  const contentContainerStyle = useMemo(
    () => ({
      flexGrow: 1,
      justifyContent: "center" as const,
      paddingHorizontal: 4,
      paddingTop: Math.max(insets.top, 16),
      paddingBottom: Math.max(insets.bottom, 24),
    }),
    [insets.top, insets.bottom],
  );

  return (
    <Screen
      edges={["top", "left", "right", "bottom"]}
      className="flex-1 bg-obsidian"
    >
      {memoizedNeonGrid}

      <KeyboardAwareScrollView
        bottomOffset={80}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={contentContainerStyle}
      >
        <View className="-mt-10 w-full">
          {/* Top Brand Identity */}
          <View className="items-center mb-4">
            <View className="w-20 h-20 rounded-3xl bg-surface border border-neon-border items-center justify-center shadow-lg shadow-neon/20 overflow-hidden mb-2">
              <Image
                source={require("../../../assets/images/icon.png")}
                className="w-full h-full"
                resizeMode="cover"
              />
            </View>

            <Text
              variant="h1"
              className="text-2xl font-black tracking-widest text-center text-white"
            >
              SENTINEL
            </Text>
            <Text
              variant="muted"
              className="text-xs uppercase font-mono tracking-widest mt-0.5 text-center"
            >
              Autonomous Observer Network
            </Text>
          </View>

          {/* Main Auth Form Card */}
          <Card className="w-full p-4.5 py-5 gap-3.5 mb-4 rounded-2xl bg-[#090b10]/10 border-0 shadow-lg shadow-neon/20 px-6">
            <SSOAuth />
            <EmailAuth />
          </Card>
        </View>
      </KeyboardAwareScrollView>
    </Screen>
  );
}
