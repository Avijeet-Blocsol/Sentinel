/**
 * Strands Sentinel - 1-Tap Interactive Action Card (HITL)
 * Renders when an interrupt action requires human authorization.
 * Sends RESOLVE_INTERRUPT over WebSocket connection to deploy rule.
 */

import React from 'react';
import { View } from 'react-native';
import type { EnrichedInterruptAction } from '@sentinel/shared';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Text } from './ui/text';
import * as Haptics from 'expo-haptics';
import { sentinelClient } from '../api/sentinel_client';
import { useSentinelStore } from '../store/useSentinelStore';

interface InterruptCardProps {
  action: EnrichedInterruptAction;
  onOpenConversation?: (conversationId: string) => void;
}

export const InterruptCard: React.FC<InterruptCardProps> = ({ action, onOpenConversation }) => {
  const activeConversationId = useSentinelStore((state) => state.activeConversationId);
  const isResolving = useSentinelStore((state) => Boolean(state.resolvingInterruptIds[action.id]));
  const isCurrentConversation = action.conversation_id === activeConversationId;
  let parsedPayload: any = {};
  try {
    parsedPayload = JSON.parse(action.action_payload);
  } catch {
    parsedPayload = { target: action.action_type };
  }

  const handleApprove = () => {
    if (!isCurrentConversation) {
      if (action.conversation_id) onOpenConversation?.(action.conversation_id);
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    sentinelClient.resolveInterrupt(action.id, 'APPROVED');
  };

  const handleDismiss = () => {
    if (!isCurrentConversation) {
      if (action.conversation_id) onOpenConversation?.(action.conversation_id);
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    sentinelClient.resolveInterrupt(action.id, 'REJECTED');
  };

  const title = parsedPayload.title || action.action_type.replace(/_/g, ' ');
  const summary =
    parsedPayload.summary ||
    'A monitored Sentinel rule was proposed or satisfied. Authorize deployment?';

  return (
    <Card className="my-3 border-2 border-neon bg-[#0E131A] shadow-2xl">
      <CardHeader>
        <View className="flex-row items-center justify-between">
          <Badge variant="default">
            <Text className="font-bold text-[10px]">HITL REQUIRED</Text>
          </Badge>
          <Badge variant="secondary">
            <Text className="text-cyber-amber text-[10px] font-bold">LIVE PRE-FLIGHT</Text>
          </Badge>
        </View>
        <CardTitle className="text-base font-extrabold text-white mt-1">
          {title}
        </CardTitle>
        <CardDescription className="text-xs text-[#8B949E]">
          {summary}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <View className="rounded-xl bg-[#06080B] p-3 border border-[#161B22]">
          {parsedPayload.cadence && (
            <View className="flex-row justify-between py-1 border-b border-[#12161E]">
              <Text className="text-xs text-[#8B949E]">Cadence:</Text>
              <Text className="font-mono text-xs font-bold text-neon">{parsedPayload.cadence}</Text>
            </View>
          )}
          {parsedPayload.baselineValue && (
            <View className="flex-row justify-between py-1 border-b border-[#12161E]">
              <Text className="text-xs text-[#8B949E]">Baseline:</Text>
              <Text className="font-mono text-xs font-bold text-white">{parsedPayload.baselineValue}</Text>
            </View>
          )}
          {parsedPayload.rule?.trigger_mode && (
            <View className="flex-row justify-between py-1">
              <Text className="text-xs text-[#8B949E]">Trigger Mode:</Text>
              <Text className="font-mono text-xs font-bold text-neon">{parsedPayload.rule.trigger_mode}</Text>
            </View>
          )}
        </View>
        {isCurrentConversation && (
          <Button
            variant="ghost"
            className="mt-2"
            onPress={() => sentinelClient.requestTaskStatus()}
            disabled={isResolving}
          >
            <Text className="text-xs text-muted-foreground font-semibold">
              VIEW CURRENT TASK STATUS
            </Text>
          </Button>
        )}
      </CardContent>

      <CardFooter className="flex-row gap-2 pt-2 border-0">
        <Button
          variant="outline"
          className="flex-1 border-border"
          onPress={handleDismiss}
          disabled={isResolving}
        >
          <Text className="text-muted-foreground font-semibold">
            {!isCurrentConversation ? 'OPEN TASK' : isResolving ? 'WAITING...' : 'DISMISS'}
          </Text>
        </Button>
        <Button
          variant="default"
          className="flex-1"
          onPress={handleApprove}
          disabled={isResolving}
        >
          <Text className="font-bold text-primary-foreground">
            {!isCurrentConversation ? 'OPEN TASK' : isResolving ? 'WAITING...' : 'CONFIRM & DEPLOY'}
          </Text>
        </Button>
      </CardFooter>
    </Card>
  );
};

export default InterruptCard;
