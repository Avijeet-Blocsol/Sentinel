import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View,
  StatusBar,
  Pressable,
  TextInput,
  StyleSheet,
  Keyboard,
  BackHandler,
  Animated,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import {
  Menu,
  Plus,
  Mic,
  ArrowUp,
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
import { ConversationScreen } from './conversation';
import { LightPillar } from './components/light_pillar';
import { InteractiveEye, type InteractiveEyeRef } from './components/interactive_eye';
import { useSentinel } from '@/hooks/use_sentinel';
import { HttpError, isCancellation } from '@/api/http_adapter';

export type ScreenView = 'home' | 'conversation' | 'navigation' | 'search' | 'dashboard';

export function MainScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useUser();
  const eyeRef = useRef<InteractiveEyeRef>(null);

  const {
    isLiveConnected,
    activeConversationId,
    isGenerating,
    telemetry,
    rules,
    connectConversation,
    disconnectConversation,
    dispatchPrompt,
  } = useSentinel();

  const [navStack, setNavStack] = useState<ScreenView[]>(['home']);
  const [chatQuery, setChatQuery] = useState('');
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);

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

  const currentView = navStack[navStack.length - 1];
  const isNavigationOpen = currentView === 'navigation';
  const displayedView = isNavigationOpen
    ? navStack.slice(0, -1).at(-1) ?? 'home'
    : currentView;

  const navigateTo = useCallback((view: ScreenView) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setNavStack((prev) => [...prev, view]);
  }, []);

  const goBack = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setNavStack((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.slice(0, -1);
      const targetView = next[next.length - 1];
      if (targetView === 'home') {
        disconnectConversation();
      }
      return next;
    });
  }, [disconnectConversation]);

  const startNewTask = useCallback(() => {
    Haptics.selectionAsync();
    setChatQuery('');
    setIsLoadingConversation(false);
    disconnectConversation();
    setNavStack(['home']);
  }, [disconnectConversation]);

  const openConversation = useCallback(
    (conversationId: string, taskTitle?: string) => {
      Haptics.selectionAsync();
      setChatQuery('');
      setIsLoadingConversation(true);
      connectConversation(conversationId, taskTitle)
        .catch((err) => {
          if (isCancellation(err)) return;
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
      setNavStack((prev) => [...prev.filter((v) => v !== 'conversation'), 'conversation']);
    },
    [connectConversation]
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

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Keyboard.dismiss();
    setChatQuery('');

    // Ensure any previous conversation is disconnected so this starts a fresh conversation
    disconnectConversation();

    // Immediately transition into the dedicated conversation screen
    setNavStack((prev) => [...prev.filter((v) => v !== 'conversation'), 'conversation']);

    try {
      await dispatchPrompt(content, { forceNew: true });
    } catch (err: any) {
      // Leaving the screen or replacing a request aborts the in-flight call.
      // That is normal lifecycle cleanup, not a connection failure to show.
      if (isCancellation(err)) return;
      setChatQuery(content);
      if (err instanceof HttpError && err.statusCode === 401) {
        Toast.show({
          type: 'error',
          text1: 'Session unavailable',
          text2: 'Your secure session could not be verified. Reopen the app or sign in again.',
        });
        return;
      }
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

  // Keep the current screen mounted beneath the sliding pane. Otherwise the
  // pane's translate animation exposes Android's default window background.
  const withNavigationPane = (screen: React.ReactNode) => (
    <View style={styles.screenStack}>
      {screen}
      {isNavigationOpen && (
        <NavigationPaneScreen
          onClose={goBack}
          onNewTask={startNewTask}
          onSearchTasks={() => navigateTo('search')}
          onOpenDashboard={() => navigateTo('dashboard')}
          onSelectTask={(convId, taskTitle) => openConversation(convId, taskTitle)}
        />
      )}
    </View>
  );

  // Screen 2: Search Sentinel Tasks Screen
  if (displayedView === 'search') {
    return withNavigationPane(
      <SearchSentinelTasksScreen
        onBack={goBack}
        onSelectTask={(convId, taskTitle) => openConversation(convId, taskTitle)}
      />
    );
  }

  // Screen 3: User Dashboard Screen
  if (displayedView === 'dashboard') {
    return withNavigationPane(
      <DashboardScreen
        onBack={goBack}
        onOpenConversation={(conversationId, taskTitle) => openConversation(conversationId, taskTitle)}
      />
    );
  }

  // Screen 4: Dedicated Sentinel Conversation Screen
  if (displayedView === 'conversation') {
    return withNavigationPane(
      <ConversationScreen
        onOpenNavigation={() => navigateTo('navigation')}
        onOpenDashboard={() => navigateTo('dashboard')}
        onNewTask={startNewTask}
        onBack={goBack}
        isLoadingConversation={isLoadingConversation}
      />
    );
  }

  // Screen 5: Primary Home / Entry Screen
  return withNavigationPane(
    <Screen
      edges={['top', 'left', 'right', 'bottom']}
      className="flex-1 bg-[#050505]"
      onTouchStart={(e) => {
        eyeRef.current?.lookAt(e.nativeEvent.pageX, e.nativeEvent.pageY);
      }}
    >
      <StatusBar barStyle="light-content" backgroundColor="#050505" />

      {/* 3D Animated Flow / Light Pillar Background - Scoped exclusively to Entry Screen */}
      {memoizedLightPillar}

      {/* Top Bar for Home Entry Screen */}
      <View className="flex-row items-center justify-between px-5 pt-2 pb-3 z-10">
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
      </View>

      <KeyboardAwareScrollView
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
        {/* Center Conversational Hero */}
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

        {/* Bottom Pill Input Bar */}
        <View
          style={{ paddingBottom: Math.max(insets.bottom, 12) + 20 }}
          className="items-center px-4"
          pointerEvents="box-none"
        >
          <Animated.View
            style={[styles.composer, { minHeight: animatedInputMinHeight }]}
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
      </KeyboardAwareScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screenStack: {
    backgroundColor: '#050505',
    flex: 1,
  },
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
