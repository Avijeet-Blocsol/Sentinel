import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View,
  StatusBar,
  Pressable,
  TextInput,
  StyleSheet,
  Keyboard,
  BackHandler,
  ActivityIndicator,
  Animated,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import {
  Menu,
  Plus,
  Mic,
  ArrowUp,
  ArrowDown,
  ChevronDown,
  SquarePen,
  MoreVertical,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Toast from 'react-native-toast-message';
import { useUser } from '@clerk/expo';
import {
  Screen,
  useSafeAreaInsets,
  Text,
  Avatar,
  AvatarImage,
  AvatarFallback,
} from '@/components/ui';
import { DashboardScreen } from './dashboard';
import { SearchSentinelTasksScreen } from './search';
import { NavigationPaneScreen } from './navigation_pane';
import { LightPillar } from './components/light_pillar';
import { LoadingOrb } from './components/loading_orb';
import { SideRays } from './components/side_rays';
import { InteractiveEye, type InteractiveEyeRef } from './components/interactive_eye';
import { InterruptCard } from '@/components/interrupt_card';
import { FormattedAgentMessage } from './components/formatted_agent_message';
import { useSentinel } from '@/hooks/use_sentinel';
import { HttpError } from '@/api/http_adapter';

export type ScreenView = 'home' | 'navigation' | 'search' | 'dashboard';

export function MainScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useUser();
  const eyeRef = useRef<InteractiveEyeRef>(null);

  const {
    isLiveConnected,
    activeConversationId,
    activeConversationTitle,
    streamingMessage,
    isGenerating,
    chatMessages,
    pendingActions,
    telemetry,
    rules,
    connectConversation,
    disconnectConversation,
    dispatchPrompt,
    requestTaskStatus,
  } = useSentinel();

  const [navStack, setNavStack] = useState<ScreenView[]>(['home']);
  const [chatQuery, setChatQuery] = useState('');
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
  const [interruptClock, setInterruptClock] = useState(() => Date.now());

  // Input Box height animation (+10px when text is entered/speaking, smoothly returns to normal when cleared)
  const inputExtraHeight = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const hasText = chatQuery.length > 0;
    Animated.spring(inputExtraHeight, {
      toValue: hasText ? 10 : 0,
      friction: 9,
      tension: 80,
      useNativeDriver: false,
    }).start();
  }, [chatQuery, inputExtraHeight]);

  const animatedInputMinHeight = inputExtraHeight.interpolate({
    inputRange: [0, 10],
    outputRange: [52, 62],
  });
  const inputLockedByInterrupt = pendingActions.some(
    (action) => action.conversation_id === activeConversationId &&
      (!action.expires_at || action.expires_at > interruptClock)
  );

  const scrollViewRef = useRef<any>(null);

  const scrollToBottom = useCallback(() => {
    void Haptics.selectionAsync();
    scrollViewRef.current?.scrollToEnd?.({ animated: true });
  }, []);

  // Auto-scroll when new messages arrive or when streaming
  useEffect(() => {
    if (chatMessages.length > 0 || streamingMessage) {
      scrollViewRef.current?.scrollToEnd?.({ animated: true });
    }
  }, [chatMessages.length, streamingMessage]);


  // Expiration is enforced by the server, but the card must also unlock in
  // the UI when its local TTL elapses, even if no socket event arrives.
  useEffect(() => {
    if (!pendingActions.some((action) => action.conversation_id === activeConversationId && action.expires_at)) {
      return undefined;
    }
    const timer = setInterval(() => setInterruptClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pendingActions, activeConversationId]);

  const currentView = navStack[navStack.length - 1];

  const navigateTo = useCallback((view: ScreenView) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setNavStack((prev) => [...prev, view]);
  }, []);

  const goBack = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setNavStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  const navigateHome = useCallback(
    (conversationId?: string, taskTitle?: string) => {
      Haptics.selectionAsync();
      setChatQuery('');
      if (conversationId) {
        setIsLoadingConversation(true);
        connectConversation(conversationId, taskTitle)
          .catch((err) => {
            console.error('[MainScreen] Failed to connect conversation:', err);
            Toast.show({
              type: 'error',
              text1: 'Connection Failed',
              text2: 'Could not load conversation history.',
            });
          })
          .finally(() => {
            setIsLoadingConversation(false);
          });
      } else {
        setIsLoadingConversation(false);
        disconnectConversation();
      }
      setNavStack(['home']);
    },
    [connectConversation, disconnectConversation]
  );

  // Hardware Android back press handling
  useEffect(() => {
    const handleBack = () => {
      if (navStack.length > 1) {
        goBack();
        return true;
      }
      return false;
    };

    const backHandler = BackHandler.addEventListener('hardwareBackPress', handleBack);
    return () => backHandler.remove();
  }, [navStack, goBack]);

  // Animate Interactive Eye when real-time telemetry events arrive from server
  useEffect(() => {
    const activeRule = rules.find((rule) => rule.conversation_id === activeConversationId);
    if (activeRule && telemetry[activeRule.id]?.length) {
      const latest = telemetry[activeRule.id][telemetry[activeRule.id].length - 1];
      if (latest && eyeRef.current) {
        const fakeX = 150 + ((latest.value % 10) - 5) * 20;
        const fakeY = 250 + ((latest.timestamp % 10) - 5) * 15;
        eyeRef.current.lookAt(fakeX, fakeY);
      }
    }
  }, [telemetry, activeConversationId, rules]);

  const handleSendPrompt = async () => {
    const content = chatQuery.trim();
    if (!content || isGenerating) return;
    if (inputLockedByInterrupt) {
      Toast.show({
        type: 'info',
        text1: 'Confirmation required',
        text2: 'Resolve the pending Sentinel card before sending another instruction.',
      });
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Keyboard.dismiss();
    setChatQuery('');

    try {
      await dispatchPrompt(content);
    } catch (err: any) {
      // Preserve the user's instruction when transport/authentication fails so
      // retrying does not require retyping it.
      setChatQuery(content);
      // A Clerk refresh can briefly overlap a request. Do not expose raw token
      // failures in the conversation; the input remains available to retry.
      if (err instanceof HttpError && err.statusCode === 401) return;
      console.error('[MainScreen] Failed to send message:', err);
      Toast.show({
        type: 'error',
        text1: 'Connection Error',
        text2: err.message || 'Failed to dispatch message to Sentinel server',
      });
    }
  };

  const userFirstName = user?.firstName || user?.fullName?.split(' ')[0] || 'User';
  const userAvatar = user?.imageUrl;
  const userInitials = (userFirstName?.[0] || 'U').toUpperCase();

  const contentContainerStyle = useMemo(
    () => ({
      flexGrow: 1,
      justifyContent: 'space-between' as const,
    }),
    [],
  );

  const memoizedLightPillar = useMemo(
    () => (
      <View
        style={[StyleSheet.absoluteFill, { zIndex: 0 }]}
        pointerEvents="none"
      >
        <LightPillar
          topColor="#00F0FF"
          bottomColor="#0DF272"
          intensity={1.1}
          rotationSpeed={0.3}
          glowAmount={0.005}
          pillarWidth={2.4}
          pillarHeight={0.38}
          noiseIntensity={0.4}
          pillarRotation={25}
          interactive={false}
          quality="medium"
        />
      </View>
    ),
    [],
  );

  // Screen 1: Standalone Navigation Pane Screen
  if (currentView === 'navigation') {
    return (
      <NavigationPaneScreen
        onClose={goBack}
        onNewTask={() => navigateHome()}
        onSearchTasks={() => navigateTo('search')}
        onOpenDashboard={() => navigateTo('dashboard')}
        onSelectTask={(convId, taskTitle) => navigateHome(convId, taskTitle)}
      />
    );
  }

  // Screen 2: Search Sentinel Tasks Screen
  if (currentView === 'search') {
    return (
      <SearchSentinelTasksScreen
        onBack={goBack}
        onSelectTask={(convId, taskTitle) => navigateHome(convId, taskTitle)}
      />
    );
  }

  // Screen 3: User Dashboard Screen
  if (currentView === 'dashboard') {
    return (
      <DashboardScreen
        onBack={goBack}
        onOpenConversation={(conversationId, taskTitle) => navigateHome(conversationId, taskTitle)}
      />
    );
  }

  // Active pending interrupts for this conversation
  const relevantInterrupts = pendingActions.filter(
    (a) => a.conversation_id === activeConversationId &&
      (!a.expires_at || a.expires_at > interruptClock)
  );

  // Keep the rays visible throughout streamed reasoning, not only during the
  // short gap before the first chunk arrives.
  const isAgentThinking = isGenerating;

  const isHeroState =
    !activeConversationId &&
    chatMessages.length === 0 &&
    !streamingMessage &&
    !isGenerating;

  // Screen 4: Primary Conversational Home Screen
  return (
    <Screen
      edges={['top', 'left', 'right', 'bottom']}
      className="flex-1 bg-[#050505]"
      onTouchStart={(e) => {
        eyeRef.current?.lookAt(e.nativeEvent.pageX, e.nativeEvent.pageY);
      }}
    >
      <StatusBar barStyle="light-content" backgroundColor="#050505" />

      {/* 3D Animated Flow / Light Pillar Background - Only on entry screen */}
      {isHeroState && memoizedLightPillar}

      {/* Ambient Neon Green Loading Orb at bottom-left corner of the conversation pane */}
      {!isHeroState && (
        <LoadingOrb
          preset="Neon"
          size={160}
          style={{
            position: 'absolute',
            bottom: Math.max(insets.bottom, 12) + 20,
            left: 8,
            zIndex: 0,
            pointerEvents: 'none',
          }}
        />
      )}

      {/* SideRays Agent Thinking Animation in Top Right Corner */}
      {!isHeroState && (
        <SideRays
          active={isAgentThinking}
          speed={2.5}
          rayColor1="#EAB308"
          rayColor2="#96c8ff"
          intensity={2.0}
          spread={2.0}
          origin="top-right"
          tilt={0}
          saturation={1.5}
          blend={0.75}
          falloff={1.6}
          opacity={0.9}
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: 360,
            height: 360,
            zIndex: 15,
            elevation: 15,
          }}
        />
      )}

      {/* 1. Top Bar */}
      <View className="flex-row items-center justify-between px-5 pt-2 pb-3 z-10">
        {isHeroState ? (
          <>
            <Pressable
              hitSlop={12}
              onPress={() => navigateTo('navigation')}
              className="w-10 h-10 items-center justify-center rounded-full active:bg-zinc-800"
            >
              <Menu size={24} color="#E3E3E3" />
            </Pressable>

            <View className="flex-row items-center gap-2">
              {isLiveConnected && (
                <View className="flex-row items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-950/60 border border-emerald-500/30">
                  <View className="w-1.5 h-1.5 rounded-full bg-[#0DF272]" />
                  <Text className="text-[10px] font-mono text-[#0DF272] font-semibold">STREAMING</Text>
                </View>
              )}

              <Pressable
                hitSlop={8}
                onPress={() => navigateTo('navigation')}
              >
                <Avatar alt="User profile" className="w-8 h-8 rounded-full border border-zinc-700">
                  {userAvatar ? (
                    <AvatarImage source={{ uri: userAvatar }} />
                  ) : (
                    <AvatarFallback>
                      <Text className="text-xs font-bold text-white">{userInitials}</Text>
                    </AvatarFallback>
                  )}
                </Avatar>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <View className="flex-row items-center gap-2">
              <Pressable
                hitSlop={12}
                onPress={() => navigateTo('navigation')}
                className="w-9 h-9 items-center justify-center rounded-full active:bg-zinc-800"
              >
                <Menu size={22} color="#E3E3E3" />
              </Pressable>

              <Pressable
                hitSlop={8}
                onPress={() => navigateTo('navigation')}
                className="flex-row items-center gap-1.5 py-1 px-2 rounded-full active:bg-zinc-900"
              >
                <View className="w-2 h-2 rounded-full bg-[#4099FF]" />
                <Text numberOfLines={1} className="text-white font-medium text-base max-w-[200px]">
                  {activeConversationTitle || 'Sentinel'}
                </Text>
                <ChevronDown size={16} color="#8E9196" />
              </Pressable>
            </View>

            <View className="flex-row items-center gap-1">
              <Pressable
                hitSlop={10}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  navigateHome();
                }}
                className="w-9 h-9 items-center justify-center rounded-full active:bg-zinc-800"
              >
                <SquarePen size={20} color="#E3E3E3" />
              </Pressable>

              <Pressable
                hitSlop={10}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  navigateTo('dashboard');
                }}
                className="w-9 h-9 items-center justify-center rounded-full active:bg-zinc-800"
              >
                <MoreVertical size={20} color="#E3E3E3" />
              </Pressable>
            </View>
          </>
        )}
      </View>

      <KeyboardAwareScrollView
        ref={scrollViewRef}
        bottomOffset={24}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={contentContainerStyle}
        onTouchStart={(e) => {
          eyeRef.current?.lookAt(e.nativeEvent.pageX, e.nativeEvent.pageY);
        }}
      >
        {/* 2. Center Conversational Hero or Message Stream */}
        {isHeroState ? (
          <Pressable
            onPress={(e) => {
              Keyboard.dismiss();
              eyeRef.current?.lookAt(e.nativeEvent.pageX, e.nativeEvent.pageY);
            }}
            className="flex-1 items-center justify-center px-6 py-10"
          >
            <View className="mb-6 items-center justify-center">
              <InteractiveEye ref={eyeRef} size={76} />
            </View>

            <Text
              variant="h2"
              className="text-white text-2xl md:text-3xl font-normal text-center tracking-tight leading-9"
            >
              What can I help with, {userFirstName}?
            </Text>
          </Pressable>
        ) : (
          <View className="flex-1 px-5 py-2">
            {/* Loading Conversation History State */}
            {isLoadingConversation && chatMessages.length === 0 ? (
              <View className="flex-1 items-center justify-center py-20 gap-3">
                <ActivityIndicator size="large" color="#0DF272" />
                <Text className="text-xs font-mono text-zinc-400">
                  Connecting to Sentinel node & loading history...
                </Text>
              </View>
            ) : chatMessages.length === 0 && !isGenerating && relevantInterrupts.length === 0 ? (
              <View className="flex-1 items-center justify-center py-16 px-6">
                <Text className="text-zinc-400 text-sm text-center">
                  No messages recorded for this task. Dispatch an instruction below to begin.
                </Text>
              </View>
            ) : (
              <View className="gap-4 pb-4">
                {/* Historical Chat Turns */}
                {chatMessages.map((msg, index) => {
                  if (msg.role === 'user') {
                    return (
                      <View
                        key={msg.id || index}
                        className="self-end max-w-[88%] rounded-[24px] px-5 py-4 bg-[#1E1F22] border border-zinc-800/40 my-2 shadow-lg"
                      >
                        <Text className="text-white text-[15px] leading-6 font-normal">
                          {msg.content}
                        </Text>
                        <View className="w-6 h-6 rounded-full bg-zinc-800/80 items-center justify-center self-end mt-2">
                          <ChevronDown size={13} color="#C4C7C5" />
                        </View>
                      </View>
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
                      <>
                        <FormattedAgentMessage content={streamingMessage} />
                        <Pressable
                          hitSlop={8}
                          onPress={requestTaskStatus}
                          className="self-start mt-2 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800"
                        >
                          <Text className="text-[10px] text-[#0DF272] font-mono">VIEW STATUS</Text>
                        </Pressable>
                      </>
                    ) : (
                      <View className="flex-row items-center gap-2.5 py-3">
                        <ActivityIndicator size="small" color="#0DF272" />
                        <Text className="text-sm text-zinc-400 font-mono">Agent reasoning & scouting...</Text>
                        <Pressable
                          hitSlop={8}
                          onPress={requestTaskStatus}
                          className="ml-auto px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800"
                        >
                          <Text className="text-[10px] text-[#0DF272] font-mono">VIEW STATUS</Text>
                        </Pressable>
                      </View>
                    )}
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
        )}

        {/* 3. Bottom Pill Input Bar - Not visible when user must handle an interrupt */}
        {!inputLockedByInterrupt && (
          <View
            style={{ paddingBottom: Math.max(insets.bottom, 12) + 20 }}
            className="items-center px-4"
            pointerEvents="box-none"
          >
            {/* Scroll-to-bottom action button centered above input pill */}
            {!isHeroState && chatMessages.length > 1 && (
              <Pressable
                hitSlop={8}
                onPress={scrollToBottom}
                className="w-10 h-10 rounded-full bg-[#1E1F22] border border-zinc-700/80 items-center justify-center shadow-2xl mb-2.5 active:bg-zinc-800"
              >
                <ArrowDown size={18} color="#FFFFFF" strokeWidth={2.5} />
              </Pressable>
            )}

            <Animated.View
              style={[styles.composer, { minHeight: animatedInputMinHeight }]}
              className="w-[92%] flex-row items-center bg-[#1E1F22] rounded-full px-4 py-2 border border-zinc-800/80 shadow-2xl"
            >
              <Pressable
                hitSlop={10}
                onPress={() => {
                  Haptics.selectionAsync();
                  Toast.show({
                    type: 'info',
                    text1: 'Attachments',
                    text2: 'Live feed attachment upload coming soon.',
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
                      type: 'info',
                      text1: 'Voice Input',
                      text2: 'Voice transcription is not enabled in this build yet.',
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
            </Animated.View>
          </View>
        )}
      </KeyboardAwareScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  composer: {
    alignSelf: 'center',
    alignItems: 'center',
    backgroundColor: '#1E1F22',
    borderColor: 'rgba(63, 63, 70, 0.8)',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    maxWidth: 760,
    paddingHorizontal: 12,
    paddingVertical: 8,
    width: '92%',
  },
  composerAction: {
    alignItems: 'center',
    flexShrink: 0,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  composerInput: {
    color: '#FFFFFF',
    flex: 1,
    fontSize: 16,
    minWidth: 0,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
});

export default MainScreen;
