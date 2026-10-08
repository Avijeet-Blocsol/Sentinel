/**
 * Strands Sentinel - Conversation Screen
 * Dedicated modular screen for Sentinel task conversations:
 */

import { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  StatusBar,
  Pressable,
  TextInput,
  StyleSheet,
  Keyboard,
  BackHandler,
  ActivityIndicator,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import {
  Menu,
  Plus,
  Mic,
  ArrowUp,
  ArrowDown,
  ChevronDown,
  ChevronLeft,
  SquarePen,
  MoreVertical,
} from "lucide-react-native";
import * as Haptics from "expo-haptics";
import Toast from "react-native-toast-message";
import { Screen, useSafeAreaInsets, Text } from "@/components/ui";
import { LoadingOrb } from "../components/loading_orb";
import { SideRays } from "../components/side_rays";
import { InterruptCard } from "@/components/interrupt_card";
import { FormattedAgentMessage } from "../components/formatted_agent_message";
import { UserChatBubble } from "../components/user_chat_bubble";
import { useSentinel } from "@/hooks/use_sentinel";
import { isCancellation } from "@/api/http_adapter";
import type { TelemetryPoint } from "@sentinel/shared";

function describeAgentActivity(point: TelemetryPoint): string {
  try {
    const metadata = point.metadata
      ? (JSON.parse(point.metadata) as { message?: string })
      : null;
    if (metadata?.message) return metadata.message;
  } catch {
    // Activity metadata is best-effort display data.
  }
  return `Running ${point.metric_name.toLowerCase().replaceAll("_", " ")}`;
}

export interface ConversationScreenProps {
  onOpenNavigation: () => void;
  onOpenDashboard: () => void;
  onNewTask: () => void;
  onBack?: () => void;
  isLoadingConversation?: boolean;
}

export function ConversationScreen({
  onOpenNavigation,
  onOpenDashboard,
  onNewTask,
  onBack,
  isLoadingConversation = false,
}: ConversationScreenProps) {
  const insets = useSafeAreaInsets();

  const {
    isLiveConnected,
    activeConversationId,
    activeConversationTitle,
    streamingMessage,
    isGenerating,
    chatMessages,
    pendingActions,
    telemetry,
    dispatchPrompt,
  } = useSentinel();

  const [chatQuery, setChatQuery] = useState("");
  const [interruptClock, setInterruptClock] = useState(() => Date.now());

  const inputLockedByInterrupt = pendingActions.some(
    (action) =>
      action.conversation_id === activeConversationId &&
      (!action.expires_at || action.expires_at > interruptClock),
  );

  const scrollViewRef = useRef<any>(null);

  const scrollToBottom = useCallback(() => {
    void Haptics.selectionAsync();
    scrollViewRef.current?.scrollToEnd?.({ animated: true });
  }, []);

  // Handle interrupt TTL timer expiration
  useEffect(() => {
    if (
      !pendingActions.some(
        (action) =>
          action.conversation_id === activeConversationId && action.expires_at,
      )
    ) {
      return undefined;
    }
    const timer = setInterval(() => setInterruptClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pendingActions, activeConversationId]);

  // Hardware Android back press handling
  useEffect(() => {
    const handleBack = () => {
      if (onBack) {
        onBack();
        return true;
      }
      return false;
    };

    const backHandler = BackHandler.addEventListener(
      "hardwareBackPress",
      handleBack,
    );
    return () => backHandler.remove();
  }, [onBack]);

  const handleSendPrompt = async () => {
    const content = chatQuery.trim();
    if (!content || isGenerating) return;
    if (inputLockedByInterrupt) {
      Toast.show({
        type: "info",
        text1: "Confirmation required",
        text2:
          "Resolve the pending Sentinel card before sending another instruction.",
      });
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Keyboard.dismiss();
    setChatQuery("");

    try {
      await dispatchPrompt(content);
    } catch (err: any) {
      if (isCancellation(err)) return;
      console.error("[ConversationScreen] Failed to send message:", err);
      Toast.show({
        type: "error",
        text1: "Connection Error",
        text2: err.message || "Failed to dispatch message to Sentinel server",
      });
    }
  };

  // Active pending interrupts for this conversation
  const relevantInterrupts = pendingActions.filter(
    (a) =>
      a.conversation_id === activeConversationId &&
      (!a.expires_at || a.expires_at > interruptClock),
  );
  const recentAgentActivity = activeConversationId
    ? (telemetry[activeConversationId] ?? []).slice(-8)
    : [];

  // Keep the ambient work indicator stable for the full turn.
  const isAgentWorking = isGenerating || Boolean(streamingMessage);

  return (
    <Screen
      edges={["top", "left", "right", "bottom"]}
      className="flex-1 bg-[#050505]"
    >
      <StatusBar barStyle="light-content" backgroundColor="#050505" />

      {/* Ambient Neon Green Loading Orb at bottom-left corner of the conversation pane */}
      <LoadingOrb
        preset="Neon"
        size={160}
        style={{
          position: "absolute",
          bottom: Math.max(insets.bottom, 12),
          left: 8,
          zIndex: 0,
          pointerEvents: "none",
        }}
      />

      {/* SideRays Agent Thinking Animation in Top Right Corner */}
      <SideRays
        active={isAgentWorking}
        speed={2.5}
        rayColor1="#EAB308"
        rayColor2="#96c8ff"
        intensity={2}
        spread={2}
        origin="top-right"
        tilt={0}
        saturation={1.5}
        blend={0.75}
        falloff={1.6}
        opacity={1}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 520,
          zIndex: 5,
          pointerEvents: "none",
        }}
      />

      {/* 1. Top Bar */}
      <View className="flex-row items-center justify-between px-5 pt-2 pb-3 z-10">
        <View className="flex-row items-center gap-2">
          {onBack && (
            <Pressable
              hitSlop={12}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onBack();
              }}
              className="w-9 h-9 items-center justify-center rounded-full active:bg-zinc-800"
              accessibilityRole="button"
              accessibilityLabel="Back to home"
            >
              <ChevronLeft size={22} color="#E3E3E3" />
            </Pressable>
          )}

          <Pressable
            hitSlop={12}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onOpenNavigation();
            }}
            className="w-9 h-9 items-center justify-center rounded-full active:bg-zinc-800"
          >
            <Menu size={22} color="#E3E3E3" />
          </Pressable>

          <Pressable
            hitSlop={8}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onOpenNavigation();
            }}
            className="flex-row items-center gap-1.5 py-1 px-2 rounded-full active:bg-zinc-900"
          >
            <View className="w-2 h-2 rounded-full bg-[#4099FF]" />
            <Text
              numberOfLines={1}
              className="text-white font-medium text-base max-w-[200px]"
            >
              {activeConversationTitle || "Sentinel"}
            </Text>
            <ChevronDown size={16} color="#8E9196" />
          </Pressable>

          {isLiveConnected && (
            <View className="flex-row items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-500/30">
              <View className="w-1.5 h-1.5 rounded-full bg-[#0DF272]" />
              <Text className="text-[9px] font-mono text-[#0DF272] font-semibold">
                LIVE
              </Text>
            </View>
          )}
        </View>

        <View className="flex-row items-center gap-1">
          <Pressable
            hitSlop={10}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onNewTask();
            }}
            className="w-9 h-9 items-center justify-center rounded-full active:bg-zinc-800"
          >
            <SquarePen size={20} color="#E3E3E3" />
          </Pressable>

          <Pressable
            hitSlop={10}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onOpenDashboard();
            }}
            className="w-9 h-9 items-center justify-center rounded-full active:bg-zinc-800"
          >
            <MoreVertical size={20} color="#E3E3E3" />
          </Pressable>
        </View>
      </View>

      {/* 2. Conversation Messages Scroll Container */}
      <KeyboardAwareScrollView
        ref={scrollViewRef}
        bottomOffset={24}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.scrollContent}
      >
        <View className="flex-1 px-5 py-2">
          {/* Loading History State */}
          {isLoadingConversation && chatMessages.length === 0 ? (
            <View className="flex-1 items-center justify-center py-20 gap-3">
              <ActivityIndicator size="large" color="#0DF272" />
              <Text className="text-xs font-mono text-zinc-400">
                Connecting to Sentinel node & loading history...
              </Text>
            </View>
          ) : chatMessages.length === 0 &&
            !isGenerating &&
            relevantInterrupts.length === 0 ? (
            <View className="flex-1 items-center justify-center py-16 px-6">
              <Text className="text-zinc-400 text-sm text-center">
                No messages recorded for this task. Dispatch an instruction
                below to begin.
              </Text>
            </View>
          ) : (
            <View className="gap-4 pb-4">
              {/* Historical Chat Turns */}
              {chatMessages.map((msg, index) => {
                if (msg.role === "user") {
                  return (
                    <UserChatBubble
                      key={msg.id || index}
                      content={msg.content}
                    />
                  );
                }

                return (
                  <View key={msg.id || index} className="w-full my-2 pl-1 pr-2">
                    <FormattedAgentMessage content={msg.content} />
                  </View>
                );
              })}

              {/* Active Streaming Assistant Turn */}
              {isGenerating && (
                <View className="w-full my-2 pl-1 pr-2">
                  {streamingMessage ? (
                    <FormattedAgentMessage content={streamingMessage} />
                  ) : (
                    <View className="flex-row items-center gap-2.5 py-3">
                      <ActivityIndicator size="small" color="#0DF272" />
                      <Text className="text-sm text-zinc-400 font-mono">
                        Agent reasoning & scouting...
                      </Text>
                    </View>
                  )}
                </View>
              )}

              {/* Realtime agent/tool activity is displayed in the conversation
                  instead of being kept only in the server log/store. */}
              {recentAgentActivity.length > 0 && (
                <View className="my-1 rounded-xl border border-[#17231D] bg-[#09110D] px-3 py-2">
                  <Text className="mb-1 text-[10px] font-mono uppercase tracking-widest text-[#0DF272]">
                    Agent activity
                  </Text>
                  {recentAgentActivity.map((point) => (
                    <View
                      key={point.id}
                      className="flex-row items-center gap-2 py-1"
                    >
                      <View className="h-1.5 w-1.5 rounded-full bg-[#0DF272]" />
                      <Text className="flex-1 text-xs text-zinc-300">
                        {describeAgentActivity(point)}
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              {/* HITL Interrupt Card in Flow */}
              {relevantInterrupts.map((action) => (
                <View key={action.id} className="my-2">
                  <InterruptCard action={action} />
                </View>
              ))}
            </View>
          )}
        </View>

        {/* 3. Bottom Pill Input Bar - Hidden when user must handle an interrupt */}
        {!inputLockedByInterrupt && (
          <View
            style={{ paddingBottom: Math.max(insets.bottom, 12) + 20 }}
            className="items-center px-4"
            pointerEvents="box-none"
          >
            {/* Scroll-to-bottom action button centered above input pill */}
            {chatMessages.length > 1 && (
              <Pressable
                hitSlop={8}
                onPress={scrollToBottom}
                className="w-10 h-10 rounded-full bg-[#1E1F22] border border-zinc-700/80 items-center justify-center shadow-2xl mb-2.5 active:bg-zinc-800"
              >
                <ArrowDown size={18} color="#FFFFFF" strokeWidth={2.5} />
              </Pressable>
            )}

            <View style={styles.composer}>
              <Pressable
                hitSlop={10}
                onPress={() => {
                  Haptics.selectionAsync();
                  Toast.show({
                    type: "info",
                    text1: "Attachments",
                    text2: "Live feed attachment upload coming soon.",
                  });
                }}
                className="w-9 h-9 items-center justify-center rounded-full active:bg-zinc-800"
                style={styles.composerAction}
                accessibilityRole="button"
                accessibilityLabel="Add attachment"
              >
                <Plus size={22} color="#C4C7C5" strokeWidth={2} />
              </Pressable>

              <TextInput
                value={chatQuery}
                onChangeText={setChatQuery}
                onSubmitEditing={handleSendPrompt}
                placeholder="Ask Sentinel"
                placeholderTextColor="#8E9196"
                className="flex-1 text-white text-base px-3 py-2"
                style={styles.composerInput}
                autoCorrect={false}
                returnKeyType="send"
                editable={!isGenerating}
                accessibilityLabel="Message Sentinel"
              />

              {chatQuery.trim().length > 0 ? (
                <Pressable
                  hitSlop={8}
                  onPress={handleSendPrompt}
                  disabled={isGenerating}
                  className="w-9 h-9 items-center justify-center rounded-full bg-[#0DF272] active:opacity-80"
                  style={styles.composerAction}
                  accessibilityRole="button"
                  accessibilityLabel="Send message"
                >
                  <ArrowUp size={18} color="#050505" strokeWidth={2.5} />
                </Pressable>
              ) : (
                <Pressable
                  hitSlop={8}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    Toast.show({
                      type: "info",
                      text1: "Voice Input",
                      text2:
                        "Voice transcription is not enabled in this build yet.",
                    });
                  }}
                  className="w-9 h-9 items-center justify-center rounded-full active:bg-zinc-800"
                  style={styles.composerAction}
                  accessibilityRole="button"
                  accessibilityLabel="Start voice input"
                >
                  <Mic size={22} color="#C4C7C5" />
                </Pressable>
              )}
            </View>
          </View>
        )}
      </KeyboardAwareScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    flexGrow: 1,
    justifyContent: "space-between",
  },
  composer: {
    alignSelf: "center",
    alignItems: "center",
    backgroundColor: "#1E1F22",
    borderColor: "rgba(63, 63, 70, 0.8)",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    maxWidth: 760,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 52,
    width: "92%",
  },
  composerAction: {
    alignItems: "center",
    flexShrink: 0,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  composerInput: {
    color: "#FFFFFF",
    flex: 1,
    fontSize: 16,
    minWidth: 0,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
});

export default ConversationScreen;
