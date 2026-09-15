/**
 * Strands Sentinel - Live Observer Sentry Card
 * Renders multi-condition monitoring status, sparklines, and audio tone triggers.
 * Follows NativeWind v4 strict zero-dynamic-className guidelines.
 */

import React, { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import type { Rule, SubSentinel, SubSentry } from '@sentinel/shared';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from './ui/card';
import { Badge } from './ui/badge';
import { TelemetryChart } from './telemetry_chart';
import { playAlertTone } from '../services/soundService';
import { useSentinelStore } from '../store/useSentinelStore';
import { Bell, MessageSquare, ShieldAlert } from 'lucide-react-native';
import { sentinelClient } from '../api/sentinel_client';
import * as Haptics from 'expo-haptics';
import Toast from 'react-native-toast-message';

interface SentinelCardProps {
  rule: Rule;
  subSentinels?: SubSentinel[];
  subSentries?: SubSentry[]; // Backward compatibility
  onOpenConversation?: (conversationId: string, title?: string) => void;
  onViewAlerts?: (ruleId: string) => void;
  onViewInterrupts?: (ruleId: string) => void;
  alertCount?: number;
  interruptCount?: number;
}

export const SentinelCard: React.FC<SentinelCardProps> = ({
  rule,
  subSentinels,
  subSentries = [],
  onOpenConversation,
  onViewAlerts,
  onViewInterrupts,
  alertCount = 0,
  interruptCount = 0,
}) => {
  const activeSubSentinels = subSentinels || subSentries;
  const telemetryPoints = useSentinelStore((s) => s.telemetry[rule.id] || []);
  const updateRuleStatus = useSentinelStore((s) => s.updateRuleStatus);
  const [isStatusUpdating, setIsStatusUpdating] = useState(false);

  const handleTestAudio = () => {
    Haptics.selectionAsync();
    playAlertTone(rule.audio_tone);
  };

  const handleTogglePause = async () => {
    if (isStatusUpdating || (rule.status !== 'ACTIVE' && rule.status !== 'PAUSED')) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const newStatus = rule.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED';
    setIsStatusUpdating(true);
    updateRuleStatus(rule.id, newStatus);
    try {
      await sentinelClient.updateRuleStatus(rule.id, newStatus);
    } catch (err) {
      console.warn('[SentinelCard] Failed to toggle status:', err);
      updateRuleStatus(rule.id, rule.status); // rollback
      Toast.show({
        type: 'error',
        text1: 'Status update failed',
        text2: 'The Sentinel status was restored. Pull down and try again.',
      });
    } finally {
      setIsStatusUpdating(false);
    }
  };

  const isTriggered = rule.status === 'TRIGGERED';
  const isPaused = rule.status === 'PAUSED';
  // A PAUSED rule with an outstanding confirmation is a staged proposal, not
  // a deployed watcher. It may only become ACTIVE through the interrupt
  // approval transaction, never through the dashboard status toggle.
  const canTogglePause = interruptCount === 0 && (rule.status === 'ACTIVE' || rule.status === 'PAUSED');

  return (
    <Card
      style={{
        borderColor: isTriggered ? '#0DF272' : isPaused ? '#3F3F46' : '#27272A',
        borderWidth: isTriggered ? 2 : 1,
      }}
      className="my-2 bg-surface rounded-2xl"
    >
      <CardHeader>
        <View className="flex-row items-center justify-between pb-1">
          <View className="flex-row items-center gap-1.5">
            <Badge variant={rule.combinator === 'AND' ? 'default' : 'secondary'}>
              <Text className="font-bold text-[10px]">[{rule.combinator}]</Text>
            </Badge>
            <Pressable
              hitSlop={canTogglePause ? 6 : 0}
              onPress={handleTogglePause}
              disabled={!canTogglePause || isStatusUpdating}
            >
              <Badge
                variant={isTriggered ? 'default' : 'outline'}
                style={{
                  borderColor: isPaused ? '#71717A' : '#0DF272',
                }}
              >
                <Text
                  style={{ color: isPaused ? '#A1A1AA' : '#0DF272' }}
                  className="font-semibold text-[10px]"
                >
                  {interruptCount > 0 && rule.status === 'PAUSED'
                    ? 'PENDING APPROVAL'
                    : isStatusUpdating
                      ? 'UPDATING'
                      : rule.status}
                </Text>
              </Badge>
            </Pressable>
          </View>
          <Pressable
            hitSlop={8}
            onPress={handleTestAudio}
            className="flex-row items-center gap-1 rounded-md bg-[#161208] px-2 py-1 border border-[#3A2A10]"
          >
            <Text className="text-[10px] text-cyber-amber font-mono font-bold">
              🔔 {rule.audio_tone}.wav
            </Text>
          </Pressable>
        </View>

        <CardTitle className="text-base font-bold text-white mt-1">
          {rule.natural_language_intent}
        </CardTitle>
      </CardHeader>

      <CardContent>
        {/* Telemetry Chart */}
        <TelemetryChart dataPoints={telemetryPoints} metricName="Sentinel Telemetry" />

        {/* Sub-sentinels conditions */}
        <View className="flex-row flex-wrap gap-1.5 mt-2">
          {activeSubSentinels.map((sentinel) => {
            const isSatisfied = sentinel.is_satisfied === 1;
            return (
              <Badge
                key={sentinel.id}
                variant={isSatisfied ? 'default' : 'secondary'}
                className="py-1 px-2.5"
              >
                <Text
                  className={`text-[11px] font-mono font-semibold ${
                    isSatisfied ? 'text-primary-foreground font-bold' : 'text-muted-foreground'
                  }`}
                >
                  {sentinel.target_source}: {sentinel.operator}{' '}
                  {isSatisfied ? '[TRIGGERED]' : '[WAITING]'}
                </Text>
              </Badge>
            );
          })}
        </View>
      </CardContent>

      <CardFooter className="pt-2">
        <View className="w-full gap-2">
          <Text className="text-[10px] text-[#6E7681]">
            Mode: {rule.trigger_mode} • Cooldown: {rule.cooldown_minutes}m • Updated{' '}
            {new Date(rule.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
          <View className="flex-row items-center justify-end gap-2">
          {onViewAlerts && (
            <Pressable
              hitSlop={6}
              onPress={() => onViewAlerts(rule.id)}
              className="flex-row items-center gap-1 rounded-md bg-zinc-800/80 px-2 py-1 border border-zinc-700 active:bg-zinc-700"
            >
              <Bell size={11} color="#C4C7C5" />
              <Text className="text-[10px] text-zinc-300 font-semibold">Alerts {alertCount}</Text>
            </Pressable>
          )}
          {onViewInterrupts && (
            <Pressable
              hitSlop={6}
              onPress={() => onViewInterrupts(rule.id)}
              className="flex-row items-center gap-1 rounded-md bg-zinc-800/80 px-2 py-1 border border-zinc-700 active:bg-zinc-700"
            >
              <ShieldAlert size={11} color={interruptCount > 0 ? '#FF9900' : '#C4C7C5'} />
              <Text className="text-[10px] text-zinc-300 font-semibold">Interrupts {interruptCount}</Text>
            </Pressable>
          )}
          {rule.conversation_id && onOpenConversation && (
            <Pressable
              hitSlop={6}
              onPress={() => {
                Haptics.selectionAsync();
                onOpenConversation(rule.conversation_id!, rule.title);
              }}
              className="flex-row items-center gap-1 rounded-md bg-zinc-800/80 px-2 py-1 border border-zinc-700 active:bg-zinc-700"
            >
              <MessageSquare size={11} color="#0DF272" />
              <Text className="text-[10px] text-[#0DF272] font-semibold">Open Chat</Text>
            </Pressable>
          )}
          </View>
        </View>
      </CardFooter>
    </Card>
  );
};

export default SentinelCard;
