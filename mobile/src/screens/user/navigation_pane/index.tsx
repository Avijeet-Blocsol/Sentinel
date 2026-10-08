import React, { useEffect, useRef, useCallback } from 'react';
import {
  View,
  StatusBar,
  Pressable,
  ScrollView,
  BackHandler,
  ActivityIndicator,
  Animated,
  Easing,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import {
  X,
  LayoutDashboard,
  MessageSquarePlus,
  Search,
  LogOut,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Toast from 'react-native-toast-message';
import { useUser, useClerk } from '@clerk/expo';
import {
  Screen,
  useSafeAreaInsets,
  Text,
  Avatar,
  AvatarImage,
  AvatarFallback,
} from '@/components/ui';
import { useSentinel } from '@/hooks/use_sentinel';
import { isCancellation } from '@/api/http_adapter';
import type { AgentConversation } from '@sentinel/shared';
import { DotField } from '../components/dot_field';

interface NavigationPaneScreenProps {
  onClose?: () => void;
  onNewTask?: () => void;
  onSearchTasks?: () => void;
  onOpenDashboard?: () => void;
  onSelectTask?: (conversationId: string, taskTitle?: string) => void;
}

export function NavigationPaneScreen({
  onClose,
  onNewTask,
  onSearchTasks,
  onOpenDashboard,
  onSelectTask,
}: NavigationPaneScreenProps) {
  const insets = useSafeAreaInsets();
  const { width: SCREEN_WIDTH } = useWindowDimensions();
  const { user } = useUser();
  const { signOut } = useClerk();
  const { client, conversations, syncDashboard, dashboardStatus } = useSentinel();
  const loading = conversations.length === 0 && (dashboardStatus === 'IDLE' || dashboardStatus === 'REFRESHING');

  const slideAnim = useRef(new Animated.Value(-SCREEN_WIDTH)).current;
  const isClosingRef = useRef(false);

  // Smooth sliding to the right animation on mount
  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: 0,
      tension: 65,
      friction: 11,
      useNativeDriver: true,
    }).start();
  }, [slideAnim]);

  // Smooth slide out animation on close
  const animateClose = useCallback(
    (callback?: () => void) => {
      if (isClosingRef.current) return;
      isClosingRef.current = true;
      Animated.timing(slideAnim, {
        toValue: -SCREEN_WIDTH,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        callback?.();
      });
    },
    [SCREEN_WIDTH, slideAnim]
  );

  const userFirstName = user?.firstName || user?.fullName?.split(' ')[0] || 'User';
  const userAvatar = user?.imageUrl;
  const userInitials = (userFirstName?.[0] || 'U').toUpperCase();

  // Revalidate the shared conversation cache whenever the pane opens. This
  // keeps history, dashboard, and search anchored to one server-backed state.
  useEffect(() => {
    void syncDashboard().catch((err) => {
      if (isCancellation(err)) return;
      console.warn('[NavigationPane] Failed to refresh conversations:', err);
    });
  }, [syncDashboard]);

  // Android hardware back press returns to previous screen with smooth slide out
  useEffect(() => {
    const handleBack = () => {
      if (onClose) {
        animateClose(onClose);
        return true;
      }
      return false;
    };

    const backHandler = BackHandler.addEventListener('hardwareBackPress', handleBack);
    return () => backHandler.remove();
  }, [onClose, animateClose]);

  const handleStartNewTask = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    animateClose(onNewTask);
  };

  const handleSelectConversation = (conv: AgentConversation) => {
    Haptics.selectionAsync();
    animateClose(() => onSelectTask?.(conv.id, conv.title));
  };

  const handleSearchTasks = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    animateClose(onSearchTasks);
  };

  const handleOpenDashboard = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    animateClose(onOpenDashboard);
  };

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        {
          transform: [{ translateX: slideAnim }],
          backgroundColor: '#050505',
          zIndex: 50,
        },
      ]}
    >
      <Screen edges={['top', 'left', 'right']} className="flex-1 bg-[#050505]">
        <StatusBar barStyle="light-content" backgroundColor="#050505" />

        {/* Subtle Neon Dot Matrix Background Backdrop */}
        <DotField
          dotSize={3.0}
          dotSpacing={20}
          opacity={0.22}
          waveAmplitude={0.018}
          colorFrom="#0DF272"
          colorTo="#063D1F"
        />

        <View
          style={{
            flex: 1,
            paddingTop: Math.max(insets.top, 10),
            paddingBottom: Math.max(insets.bottom, 6),
          }}
          className="px-5 justify-between"
        >
          {/* Top Header & Navigation Actions */}
          <View>
            <View className="flex-row items-center justify-between py-2 mb-4">
              <Text variant="h3" className="text-white text-xl font-semibold tracking-tight">
                Sentinel
              </Text>
              <Pressable
                hitSlop={12}
                onPress={() => {
                  Haptics.selectionAsync();
                  animateClose(onClose);
                }}
                className="w-10 h-10 items-center justify-center rounded-full active:bg-zinc-800"
              >
                <X size={24} color="#E3E3E3" />
              </Pressable>
            </View>

            {/* Navigation Options */}
            <View className="gap-2 mb-4">
              {/* Option 1: New Sentinel Tasks */}
              <Pressable
                onPress={handleStartNewTask}
                className="flex-row items-center gap-3 bg-[#1E1F22] rounded-2xl px-4 py-3.5 active:bg-zinc-800"
              >
                <MessageSquarePlus size={20} color="#FFFFFF" />
                <Text className="text-white font-medium text-sm">New Sentinel Tasks</Text>
              </Pressable>

              {/* Option 2: Search Sentinel Tasks */}
              <Pressable
                onPress={handleSearchTasks}
                className="flex-row items-center gap-3 px-4 py-3 rounded-xl active:bg-zinc-900"
              >
                <Search size={20} color="#C4C7C5" />
                <Text className="text-zinc-200 font-medium text-sm">Search Sentinel Tasks</Text>
              </Pressable>

              {/* Option 3: Dashboard */}
              <Pressable
                onPress={handleOpenDashboard}
                className="flex-row items-center gap-3 px-4 py-3 rounded-xl active:bg-zinc-900"
              >
                <LayoutDashboard size={20} color="#0DF272" />
                <Text className="text-zinc-200 font-medium text-sm">Dashboard</Text>
              </Pressable>
            </View>

            {/* Recent Sentinel Tasks Section Header */}
            <Text variant="muted" className="text-zinc-400 font-medium text-xs px-2 pt-2 pb-1">
              Recent Sentinel Tasks
            </Text>
          </View>

        {/* Scrollable Tasks List — Zero scrollbars visible per project guidelines */}
        <ScrollView
          className="flex-1 my-1"
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 24 }}
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          nestedScrollEnabled={true}
          keyboardShouldPersistTaps="handled"
        >
          {loading ? (
            <View className="py-6 items-center justify-center">
              <ActivityIndicator size="small" color="#0DF272" />
            </View>
          ) : (
            <View className="gap-1 py-1">
              {conversations.length > 0 ? (
                conversations.map((conv) => (
                  <Pressable
                    key={conv.id}
                    onPress={() => handleSelectConversation(conv)}
                    className="py-2.5 px-3 rounded-xl active:bg-zinc-900"
                  >
                    <Text
                      numberOfLines={1}
                      className="text-zinc-300 text-sm font-normal tracking-wide"
                    >
                      {conv.title}
                    </Text>
                    <Text variant="muted" className="text-[10px] font-mono text-zinc-500">
                      {new Date(conv.created_at).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })} • {conv.phase}
                    </Text>
                  </Pressable>
                ))
              ) : (
                <View className="py-8 items-center justify-center">
                  <Text variant="muted" className="text-zinc-500 text-xs text-center">
                    No recent Sentinel tasks yet. Start a new task above.
                  </Text>
                </View>
              )}
            </View>
          )}
        </ScrollView>

        {/* Footer account controls and logout */}
        <View className="border-t border-zinc-800/80 pt-3 pb-2 flex-row items-center justify-between">
            <View className="flex-row items-center gap-3 flex-1">
              <Avatar alt="User profile" className="w-10 h-10 rounded-full border border-primary/50">
                {userAvatar ? (
                  <AvatarImage source={{ uri: userAvatar }} />
                ) : (
                  <AvatarFallback>
                    <Text className="text-sm font-bold text-white">{userInitials}</Text>
                  </AvatarFallback>
                )}
              </Avatar>
              <View className="flex-1">
                <Text numberOfLines={1} className="text-white font-semibold text-sm">
                  {user?.fullName || userFirstName}
                </Text>
                <Text numberOfLines={1} variant="muted" className="text-[11px] text-zinc-400">
                  {user?.primaryEmailAddress?.emailAddress || ''}
                </Text>
              </View>
            </View>

            <Pressable
              hitSlop={10}
              onPress={async () => {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                try {
                  await signOut();
                  client.resetSession(true);
                } catch (error) {
                  console.warn('[NavigationPane] Clerk sign out failed:', error);
                  Toast.show({
                    type: 'error',
                    text1: 'Sign out failed',
                    text2: 'Your session remains active. Please try again.',
                  });
                }
              }}
              className="flex-row items-center gap-1.5 p-2 rounded-xl bg-surface active:bg-zinc-800 border border-border"
            >
              <LogOut size={16} color="#EF4444" />
              <Text className="text-xs font-medium text-red-400">Sign Out</Text>
            </Pressable>
          </View>
      </View>
    </Screen>
    </Animated.View>
  );
}

export default NavigationPaneScreen;
