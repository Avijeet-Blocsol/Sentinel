import React, { useEffect, useMemo, useState } from 'react';
import { View, StatusBar, Pressable, RefreshControl, StyleSheet } from 'react-native';
import { useUser } from '@clerk/expo';
import {
  Screen,
  ScrollView,
  Text,
  Badge,
  Avatar,
  AvatarImage,
  AvatarFallback,
  useSafeAreaInsets,
} from '@/components/ui';
import {
  ArrowLeft,
  RefreshCw,
  Bell,
  ShieldAlert,
  ShieldCheck,
  MessageSquare,
  X,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useSentinel } from '@/hooks/use_sentinel';
import { SentinelCard } from '@/components/sentinel_card';
import { InterruptCard } from '@/components/interrupt_card';
import { LightPillar } from '../components/light_pillar';
import { LoadingOrb } from '../components/loading_orb';

type DashboardTab = 'sentinels' | 'interrupts' | 'notifications';
type SentinelFilter = 'ALL' | 'ACTIVE' | 'PAUSED' | 'TRIGGERED';

export function DashboardScreen({
  onBack,
  onOpenConversation,
}: {
  onBack?: () => void;
  onOpenConversation?: (conversationId: string, title?: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const { user } = useUser();
  const {
    rules,
    subSentinels,
    pendingActions,
    alerts,
    isLiveConnected,
    dashboardStatus,
    syncDashboard,
  } = useSentinel();

  const [activeTab, setActiveTab] = useState<DashboardTab>('sentinels');
  const [sentinelFilter, setSentinelFilter] = useState<SentinelFilter>('ALL');
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);

  const refreshing = dashboardStatus === 'REFRESHING';

  // Refresh durable server state on mount. Authentication is owned once at the
  // app root by useSentinelBootstrap, not reconfigured by individual screens.
  useEffect(() => {
    void syncDashboard().catch((err) => {
      console.warn('[DashboardScreen] Failed to sync dashboard:', err);
    });
    // Alerts are produced by a separate SQS worker and a dashboard may be
    // opened without any conversation socket. Revalidate while this screen is
    // visible so the feed is still current in that legitimate state.
    const refreshTimer = setInterval(() => {
      void syncDashboard().catch((err) => {
        console.warn('[DashboardScreen] Background refresh failed:', err);
      });
    }, 15_000);
    return () => clearInterval(refreshTimer);
  }, [syncDashboard]);

  const handleRefresh = async () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await syncDashboard();
  };

  const userFirstName = user?.firstName || user?.fullName?.split(' ')[0] || 'User';
  const userAvatar = user?.imageUrl;
  const userInitials = (userFirstName?.[0] || 'U').toUpperCase();

  // Rejected proposals are discarded configurations, not saved Sentinels.
  // Keep them out of the operational dashboard after durable revalidation.
  const dashboardRules = useMemo(
    () => rules.filter((rule) => rule.status !== 'DISMISSED'),
    [rules],
  );

  // All saved sentinels for this user with sub-filter applied
  const filteredRules = useMemo(() => {
    if (sentinelFilter === 'ALL') return dashboardRules;
    return dashboardRules.filter((r) => r.status === sentinelFilter);
  }, [dashboardRules, sentinelFilter]);

  const activeCount = useMemo(() => dashboardRules.filter((r) => r.status === 'ACTIVE').length, [dashboardRules]);
  const pausedCount = useMemo(() => dashboardRules.filter((r) => r.status === 'PAUSED').length, [dashboardRules]);
  const triggeredCount = useMemo(() => dashboardRules.filter((r) => r.status === 'TRIGGERED').length, [dashboardRules]);
  const selectedRule = useMemo(
    () => dashboardRules.find((rule) => rule.id === selectedRuleId) ?? null,
    [dashboardRules, selectedRuleId],
  );
  const visibleInterrupts = useMemo(
    () => selectedRuleId ? pendingActions.filter((action) => action.rule_id === selectedRuleId) : pendingActions,
    [pendingActions, selectedRuleId],
  );
  const visibleAlerts = useMemo(
    () => selectedRuleId ? alerts.filter((alert) => alert.rule_id === selectedRuleId) : alerts,
    [alerts, selectedRuleId],
  );

  const openRuleEvents = (ruleId: string, tab: Extract<DashboardTab, 'interrupts' | 'notifications'>) => {
    void Haptics.selectionAsync();
    setSelectedRuleId(ruleId);
    setActiveTab(tab);
  };

  const memoizedLightPillar = useMemo(
    () => (
      <View style={[StyleSheet.absoluteFill, { zIndex: 0 }]} pointerEvents="none">
        <LightPillar
          topColor="#00F0FF"
          bottomColor="#0DF272"
          intensity={0.9}
          rotationSpeed={0.2}
          glowAmount={0.004}
          pillarWidth={2.2}
          pillarHeight={0.35}
          noiseIntensity={0.35}
          pillarRotation={25}
          interactive={false}
          quality="medium"
        />
      </View>
    ),
    [],
  );

  return (
    <Screen edges={['top', 'left', 'right', 'bottom']} className="flex-1 bg-[#050505]">
      <StatusBar barStyle="light-content" backgroundColor="#050505" />

      {/* Matching 3D Ambient Background */}
      {memoizedLightPillar}

      {/* Ambient WebGL Loading Orb at bottom-left corner of the screen */}
      <LoadingOrb
        preset="Neon"
        size={160}
        style={{
          position: 'absolute',
          bottom: Math.max(insets.bottom, 16),
          left: 10,
          zIndex: 0,
          pointerEvents: 'none',
        }}
      />

      {/* 1. Top Header Matching Home Screen */}
      <View className="flex-row items-center justify-between px-5 pt-2 pb-3 z-10">
        <View className="flex-row items-center gap-3">
          {onBack && (
            <Pressable
              hitSlop={12}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onBack();
              }}
              className="w-10 h-10 items-center justify-center rounded-full bg-zinc-900/80 border border-zinc-800 active:bg-zinc-800"
            >
              <ArrowLeft size={20} color="#E3E3E3" />
            </Pressable>
          )}
          <View>
            <Text variant="h3" className="text-white text-lg font-semibold tracking-tight">
              Sentinel Dashboard
            </Text>
            <Text variant="muted" className="text-[10px] font-mono text-zinc-400">
              Observer Node • {dashboardRules.length} Sentinel{dashboardRules.length === 1 ? '' : 's'} Saved
            </Text>
          </View>
        </View>

        <View className="flex-row items-center gap-2">
          {/* Live Node Stream Badge */}
          <View
            className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full ${
              isLiveConnected
                ? 'bg-emerald-950/60 border border-emerald-500/30'
                : 'bg-zinc-900/80 border border-zinc-800'
            }`}
          >
            <View
              className={`w-1.5 h-1.5 rounded-full ${
                isLiveConnected ? 'bg-[#0DF272]' : 'bg-zinc-500'
              }`}
            />
            <Text
              className={`text-[10px] font-mono font-semibold ${
                isLiveConnected ? 'text-[#0DF272]' : 'text-zinc-400'
              }`}
            >
              {isLiveConnected ? 'LIVE' : 'SYNCED'}
            </Text>
          </View>

          {/* Refresh Button */}
          <Pressable
            hitSlop={8}
            onPress={handleRefresh}
            disabled={refreshing}
            className="w-9 h-9 items-center justify-center rounded-full bg-zinc-900/80 border border-zinc-800 active:bg-zinc-800"
          >
            <RefreshCw size={16} color={refreshing ? '#A1A1AA' : '#0DF272'} />
          </Pressable>

          {/* User Avatar */}
          <Avatar alt="User profile" className="w-8 h-8 rounded-full border border-zinc-700">
            {userAvatar ? (
              <AvatarImage source={{ uri: userAvatar }} />
            ) : (
              <AvatarFallback>
                <Text className="text-xs font-bold text-white">{userInitials}</Text>
              </AvatarFallback>
            )}
          </Avatar>
        </View>
      </View>

      {/* 2. Top Segmented Filter Buttons: Sentinels, Interrupts, Notifications */}
      <View className="px-5 pt-1 pb-3 z-10">
        <View className="flex-row items-center bg-[#1E1F22] rounded-2xl p-1 border border-zinc-800">
          {/* Sentinels Button */}
          <Pressable
            onPress={() => {
              Haptics.selectionAsync();
              setSelectedRuleId(null);
              setActiveTab('sentinels');
            }}
            className={`flex-1 flex-row items-center justify-center gap-1.5 py-2.5 rounded-xl ${
              activeTab === 'sentinels' ? 'bg-zinc-800 border border-zinc-700' : 'active:bg-zinc-900'
            }`}
          >
            <ShieldCheck
              size={15}
              color={activeTab === 'sentinels' ? '#0DF272' : '#9CA3AF'}
            />
            <Text
              className={`text-xs font-semibold ${
                activeTab === 'sentinels' ? 'text-white' : 'text-zinc-400'
              }`}
            >
              Sentinels
            </Text>
            <Badge
              variant="outline"
              className={`py-0 px-1.5 border-0 ${
                activeTab === 'sentinels' ? 'bg-[#0DF272]/20' : 'bg-zinc-800'
              }`}
            >
              <Text
                className={`text-[10px] font-mono font-bold ${
                  activeTab === 'sentinels' ? 'text-[#0DF272]' : 'text-zinc-400'
                }`}
              >
                {dashboardRules.length}
              </Text>
            </Badge>
          </Pressable>

          {/* Interrupts Button */}
          <Pressable
            onPress={() => {
              Haptics.selectionAsync();
              setSelectedRuleId(null);
              setActiveTab('interrupts');
            }}
            className={`flex-1 flex-row items-center justify-center gap-1.5 py-2.5 rounded-xl ${
              activeTab === 'interrupts' ? 'bg-zinc-800 border border-zinc-700' : 'active:bg-zinc-900'
            }`}
          >
            <ShieldAlert
              size={15}
              color={pendingActions.length > 0 ? '#FF9900' : activeTab === 'interrupts' ? '#FFFFFF' : '#9CA3AF'}
            />
            <Text
              className={`text-xs font-semibold ${
                activeTab === 'interrupts' ? 'text-white' : 'text-zinc-400'
              }`}
            >
              Interrupts
            </Text>
            <Badge
              variant="outline"
              className={`py-0 px-1.5 border-0 ${
                pendingActions.length > 0
                  ? 'bg-amber-500/20'
                  : activeTab === 'interrupts'
                    ? 'bg-zinc-700'
                    : 'bg-zinc-800'
              }`}
            >
              <Text
                className={`text-[10px] font-mono font-bold ${
                  pendingActions.length > 0 ? 'text-amber-400' : 'text-zinc-400'
                }`}
              >
                {pendingActions.length}
              </Text>
            </Badge>
          </Pressable>

          {/* Notifications Button */}
          <Pressable
            onPress={() => {
              Haptics.selectionAsync();
              setSelectedRuleId(null);
              setActiveTab('notifications');
            }}
            className={`flex-1 flex-row items-center justify-center gap-1.5 py-2.5 rounded-xl ${
              activeTab === 'notifications' ? 'bg-zinc-800 border border-zinc-700' : 'active:bg-zinc-900'
            }`}
          >
            <Bell
              size={15}
              color={alerts.length > 0 ? '#0DF272' : activeTab === 'notifications' ? '#FFFFFF' : '#9CA3AF'}
            />
            <Text
              className={`text-xs font-semibold ${
                activeTab === 'notifications' ? 'text-white' : 'text-zinc-400'
              }`}
            >
              Notifications
            </Text>
            <Badge
              variant="outline"
              className={`py-0 px-1.5 border-0 ${
                alerts.length > 0
                  ? 'bg-emerald-500/20'
                  : activeTab === 'notifications'
                    ? 'bg-zinc-700'
                    : 'bg-zinc-800'
              }`}
            >
              <Text
                className={`text-[10px] font-mono font-bold ${
                  alerts.length > 0 ? 'text-[#0DF272]' : 'text-zinc-400'
                }`}
              >
                {alerts.length}
              </Text>
            </Badge>
          </Pressable>
        </View>

        {/* Sub-Filter Pills (When Sentinels Tab Active) */}
        {activeTab === 'sentinels' && dashboardRules.length > 0 && (
          <View className="flex-row items-center gap-2 mt-2.5 px-1">
            {(['ALL', 'ACTIVE', 'PAUSED', 'TRIGGERED'] as SentinelFilter[]).map((filter) => {
              const count =
                filter === 'ALL'
                  ? dashboardRules.length
                  : filter === 'ACTIVE'
                    ? activeCount
                    : filter === 'PAUSED'
                      ? pausedCount
                      : triggeredCount;
              const isActive = sentinelFilter === filter;

              return (
                <Pressable
                  key={filter}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setSentinelFilter(filter);
                  }}
                  className={`px-3 py-1 rounded-full border ${
                    isActive
                      ? 'bg-zinc-800 border-emerald-500/50'
                      : 'bg-zinc-900/60 border-zinc-800/80 active:bg-zinc-800'
                  }`}
                >
                  <Text
                    className={`text-[10px] font-mono font-medium ${
                      isActive ? 'text-[#0DF272]' : 'text-zinc-400'
                    }`}
                  >
                    {filter} ({count})
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
        {activeTab !== 'sentinels' && selectedRule && (
          <View className="mt-2.5 mx-1 px-3 py-2 rounded-xl bg-zinc-900/80 border border-zinc-800 flex-row items-center justify-between">
            <Text numberOfLines={1} className="flex-1 text-xs text-zinc-300 mr-2">
              Showing {activeTab === 'interrupts' ? 'interrupts' : 'alerts'} for {selectedRule.title}
            </Text>
            <Pressable
              hitSlop={8}
              onPress={() => setSelectedRuleId(null)}
              className="flex-row items-center gap-1 px-2 py-1 rounded-lg bg-zinc-800"
            >
              <X size={12} color="#C4C7C5" />
              <Text className="text-[10px] text-zinc-300">Show all</Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* 3. Main Scrollable Content */}
      <ScrollView
        className="flex-1 px-5"
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor="#0DF272"
            colors={['#0DF272']}
          />
        }
      >
        {/* VIEW 1: SENTINELS SHOWCASE */}
        {activeTab === 'sentinels' && (
          <View className="gap-3">
            {filteredRules.length > 0 ? (
              filteredRules.map((rule) => (
                <SentinelCard
                  key={rule.id}
                  rule={rule}
                  subSentinels={subSentinels[rule.id] || []}
                  onOpenConversation={(convId, title) => onOpenConversation?.(convId, title)}
                  onViewAlerts={(ruleId) => openRuleEvents(ruleId, 'notifications')}
                  onViewInterrupts={(ruleId) => openRuleEvents(ruleId, 'interrupts')}
                  alertCount={alerts.filter((alert) => alert.rule_id === rule.id).length}
                  interruptCount={pendingActions.filter((action) => action.rule_id === rule.id).length}
                />
              ))
            ) : (
              <View className="p-8 my-4 rounded-2xl bg-[#0E131A]/80 border border-zinc-800 items-center justify-center">
                <ShieldCheck size={36} color="#52525B" />
                <Text className="text-white font-semibold text-base mt-3 text-center">
                  {sentinelFilter === 'ALL'
                    ? 'No Sentinel Watchers Deployed'
                    : `No ${sentinelFilter} Sentinels`}
                </Text>
                <Text variant="muted" className="text-xs text-zinc-400 mt-1.5 text-center max-w-[280px]">
                  {sentinelFilter === 'ALL'
                    ? 'Submit a surveillance instruction on the home screen to synthesize a live watcher.'
                    : `You have no sentinels currently in ${sentinelFilter.toLowerCase()} state.`}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* VIEW 2: INTERRUPTS (HITL CONFIRMATIONS) */}
        {activeTab === 'interrupts' && (
          <View className="gap-3">
            {visibleInterrupts.length > 0 ? (
              visibleInterrupts.map((action) => (
                <InterruptCard
                  key={action.id}
                  action={action}
                  onOpenConversation={onOpenConversation}
                />
              ))
            ) : (
              <View className="p-8 my-4 rounded-2xl bg-[#0E131A]/80 border border-zinc-800 items-center justify-center">
                <ShieldAlert size={36} color="#52525B" />
                <Text className="text-white font-semibold text-base mt-3 text-center">
                  No Pending Interrupts
                </Text>
                <Text variant="muted" className="text-xs text-zinc-400 mt-1.5 text-center max-w-[280px]">
                  All deployed Sentinels are executing autonomously without requiring human intervention.
                </Text>
              </View>
            )}
          </View>
        )}

        {/* VIEW 3: NOTIFICATIONS / ALERTS */}
        {activeTab === 'notifications' && (
          <View className="gap-2.5">
            {visibleAlerts.length > 0 ? (
              visibleAlerts.map((alert) => (
                <View
                  key={alert.id}
                  className="p-3.5 rounded-2xl bg-[#0E131A]/90 border border-zinc-800 flex-row items-center justify-between"
                >
                  <View className="flex-1 pr-3">
                    <Text className="text-white font-semibold text-sm">{alert.title}</Text>
                    <Text variant="muted" className="text-xs text-zinc-400 mt-1" numberOfLines={2}>
                      {alert.summary}
                    </Text>
                  </View>
                  <View className="items-end gap-1">
                    <Badge variant="outline" className="border-emerald-500/40 py-0.5 px-2 bg-emerald-950/30">
                      <Text className="text-[10px] font-mono text-[#0DF272] uppercase font-bold">
                        🔔 {alert.audio_tone}
                      </Text>
                    </Badge>
                    <Text variant="muted" className="text-[10px] font-mono text-zinc-500">
                      {new Date(alert.created_at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </Text>
                    {(() => {
                      const rule = rules.find((item) => item.id === alert.rule_id);
                      return rule?.conversation_id && onOpenConversation ? (
                        <Pressable
                          hitSlop={6}
                          onPress={() => onOpenConversation(rule.conversation_id!, rule.title)}
                          className="mt-1 flex-row items-center gap-1 px-2 py-1 rounded-md bg-zinc-800"
                        >
                          <MessageSquare size={11} color="#0DF272" />
                          <Text className="text-[10px] text-[#0DF272]">Open Chat</Text>
                        </Pressable>
                      ) : null;
                    })()}
                  </View>
                </View>
              ))
            ) : (
              <View className="p-8 my-4 rounded-2xl bg-[#0E131A]/80 border border-zinc-800 items-center justify-center">
                <Bell size={36} color="#52525B" />
                <Text className="text-white font-semibold text-base mt-3 text-center">
                  No Alert History Recorded
                </Text>
                <Text variant="muted" className="text-xs text-zinc-400 mt-1.5 text-center max-w-[280px]">
                  When a Sentinel condition is triggered, audio alerts and notification events will appear here.
                </Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

export default DashboardScreen;
