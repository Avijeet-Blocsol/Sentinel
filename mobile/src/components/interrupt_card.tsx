/**
 * Strands Sentinel - 1-Tap Interactive Action Card (HITL)
 * Renders when an interrupt action requires human authorization.
 * Sends RESOLVE_INTERRUPT over WebSocket connection for a typed workflow
 * decision, including deployment, clarification, or a confirmed task edit.
 */

import React from 'react';
import { TextInput, View, useWindowDimensions } from 'react-native';
import {
  ChoiceInterruptPayloadSchema,
  isChoiceInterruptActionType,
  type EnrichedInterruptAction,
} from '@sentinel/shared';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Text } from './ui/text';
import * as Haptics from 'expo-haptics';
import Toast from 'react-native-toast-message';
import { sentinelClient } from '../api/sentinel_client';
import { useSentinelStore } from '../store/useSentinelStore';

interface InterruptCardProps {
  action: EnrichedInterruptAction;
  onOpenConversation?: (conversationId: string) => void;
}

export const InterruptCard: React.FC<InterruptCardProps> = ({ action, onOpenConversation }) => {
  const activeConversationId = useSentinelStore((state) => state.activeConversationId);
  const isResolving = useSentinelStore((state) => Boolean(state.resolvingInterruptIds[action.id]));
  const statusRequestInFlight = useSentinelStore((state) => state.statusRequestInFlight);
  const isCurrentConversation = action.conversation_id === activeConversationId;
  const [manualResponse, setManualResponse] = React.useState('');
  const { width: windowWidth } = useWindowDimensions();
  let parsedPayload: any = {};
  try {
    parsedPayload = JSON.parse(action.action_payload);
  } catch {
    parsedPayload = { target: action.action_type };
  }
  const choiceRequest = isChoiceInterruptActionType(action.action_type)
    ? ChoiceInterruptPayloadSchema.safeParse(parsedPayload).success
      ? ChoiceInterruptPayloadSchema.parse(parsedPayload)
      : null
    : null;

  const handleApprove = () => {
    if (!isCurrentConversation) {
      if (action.conversation_id) onOpenConversation?.(action.conversation_id);
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    reportResolutionResult(sentinelClient.resolveInterrupt(action.id, 'APPROVED', 'approve'));
  };

  const handleChoice = (choiceId: string) => {
    if (!isCurrentConversation) {
      if (action.conversation_id) onOpenConversation?.(action.conversation_id);
      return;
    }
    Haptics.selectionAsync();
    reportResolutionResult(sentinelClient.resolveInterrupt(action.id, 'APPROVED', choiceId));
  };

  const handleManualResponse = (choiceId: string) => {
    if (!isCurrentConversation) {
      if (action.conversation_id) onOpenConversation?.(action.conversation_id);
      return;
    }
    const trimmed = manualResponse.trim();
    if (!trimmed) {
      Toast.show({
        type: 'info',
        text1: 'Response required',
        text2: 'Enter the exact response before submitting this interrupt.',
      });
      return;
    }
    Haptics.selectionAsync();
    reportResolutionResult(sentinelClient.resolveInterrupt(action.id, 'APPROVED', choiceId, trimmed));
  };

  const handleDismiss = () => {
    if (!isCurrentConversation) {
      if (action.conversation_id) onOpenConversation?.(action.conversation_id);
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    reportResolutionResult(sentinelClient.resolveInterrupt(action.id, 'REJECTED', 'reject'));
  };

  const reportResolutionResult = (accepted: boolean) => {
    if (accepted) return;
    Toast.show({
      type: 'error',
      text1: 'Reconnecting to Sentinel',
      text2: 'The action was not sent. Keep this card open and try again when the LIVE stream is restored.',
    });
  };

  const handleViewStatus = () => {
    const accepted = sentinelClient.requestTaskStatus();
    if (accepted) return;

    Toast.show({
      type: 'info',
      text1: statusRequestInFlight ? 'Status request already pending' : 'Status is not available yet',
      text2: statusRequestInFlight
        ? 'Sentinel is preparing the current task status.'
        : 'Reconnect to the Sentinel stream and try again.',
    });
  };

  const title = action.action_type === 'TASK_EDIT_CONFIRMATION_REQUIRED'
    ? 'Review task changes'
    : action.action_type === 'QUERY_CONFIRMATION_REQUIRED'
    ? 'Review proposed monitor'
    : action.action_type === 'MONITORING_MODE_REQUIRED'
      ? 'Choose monitoring mode'
      : choiceRequest
        ? 'Clarification required'
        : action.rule_title || parsedPayload.title || action.action_type.replace(/_/g, ' ');
  const actionTarget = typeof parsedPayload.target === 'string' ? parsedPayload.target : null;
  const summary =
    choiceRequest?.question || parsedPayload.summary ||
    (action.rule_title
      ? `The Sentinel task "${action.rule_title}" requires your approval before its action can run.`
      : 'A monitored Sentinel rule requires your approval before its action can run.') +
      (actionTarget ? ` Target: ${actionTarget}.` : '');
  const taskEdit = choiceRequest?.task_edit;
  const scheduleSeconds = taskEdit?.changes.schedule_seconds;
  const scheduleLabel = scheduleSeconds === undefined
    ? null
    : scheduleSeconds >= 3600 && scheduleSeconds % 3600 === 0
      ? `${scheduleSeconds / 3600} hour${scheduleSeconds / 3600 === 1 ? '' : 's'}`
      : scheduleSeconds >= 60 && scheduleSeconds % 60 === 0
        ? `${scheduleSeconds / 60} minute${scheduleSeconds / 60 === 1 ? '' : 's'}`
        : `${scheduleSeconds} seconds`;

  return (
    <Card className="my-3 w-full max-w-full overflow-hidden border-2 border-neon bg-[#0E131A]/90 shadow-2xl">
      <CardHeader>
        <View className="flex-row flex-wrap items-center justify-between gap-2">
          <Badge variant="default">
            <Text className="font-bold text-[10px]">HITL REQUIRED</Text>
          </Badge>
          <Badge variant="secondary">
            <Text className="text-cyber-amber text-[10px] font-bold">
              {action.action_type === 'MONITORING_MODE_REQUIRED' ? 'SETUP COMPLETE' : 'USER ACTION'}
            </Text>
          </Badge>
        </View>
        <CardTitle className="mt-1 flex-shrink text-base font-extrabold text-white">
          {title}
        </CardTitle>
      <CardDescription className="text-xs text-[#8B949E]">
        {summary}
      </CardDescription>
      {choiceRequest?.retry_message && (
        <View className="mt-2 rounded-lg border border-amber-500/50 bg-amber-950/30 px-3 py-2">
          <Text className="text-xs leading-5 text-amber-200">{choiceRequest.retry_message}</Text>
        </View>
      )}
      </CardHeader>

      <CardContent>
        {!choiceRequest && <View className="rounded-xl bg-[#06080B] p-3 border border-[#161B22]">
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
          </View>}
        {choiceRequest && (
          <View className="mt-3 w-full gap-2">
            {taskEdit && (
              <View className="mb-1 w-full rounded-xl border border-[#283440] bg-[#0B1117] p-3">
                <Text className="text-[10px] font-mono uppercase tracking-widest text-[#0DF272]">
                  Proposed task change
                </Text>
                <Text className="mt-2 text-sm font-semibold leading-5 text-white">
                  {taskEdit.summary}
                </Text>
                {taskEdit.target_label && (
                  <Text className="mt-1 text-xs text-[#8B949E]">Condition: {taskEdit.target_label}</Text>
                )}
                {scheduleLabel && (
                  <Text className="mt-1 text-xs text-[#8B949E]">New check interval: {scheduleLabel}</Text>
                )}
                {taskEdit.changes.operator && (
                  <Text className="mt-1 text-xs text-[#8B949E]">New trigger operator: {taskEdit.changes.operator}</Text>
                )}
                {taskEdit.changes.trigger_mode && (
                  <Text className="mt-1 text-xs text-[#8B949E]">
                    New mode: {taskEdit.changes.trigger_mode === 'PERSISTENT' ? 'Continuous monitoring' : 'One-time alert'}
                  </Text>
                )}
              </View>
            )}
            {choiceRequest.choices.map((choice) => {
              if (choice.input?.kind === 'TEXT') {
                return (
                  <View
                    key={choice.id}
                    className="w-full rounded-xl border border-neon bg-[#111A22] p-3"
                    style={{ maxWidth: Math.max(0, windowWidth - 56) }}
                  >
                    <Text className="font-bold text-white">{choice.label}</Text>
                    {choice.description && (
                      <Text className="mt-1 text-left text-xs leading-5 text-[#8B949E]">{choice.description}</Text>
                    )}
                    <TextInput
                      value={manualResponse}
                      onChangeText={setManualResponse}
                      placeholder={choice.input.placeholder || 'Type your exact response…'}
                      placeholderTextColor="#7C8793"
                      multiline
                      maxLength={choice.input.max_length || 4000}
                      editable={!isResolving && isCurrentConversation}
                      className="mt-3 min-h-[88px] w-full rounded-lg border border-[#283440] bg-[#0B1117] px-3 py-2 text-sm text-white"
                      textAlignVertical="top"
                      accessibilityLabel="Manual interrupt response"
                    />
                    <Button
                      variant="default"
                      className="mt-3 w-full"
                      onPress={() => handleManualResponse(choice.id)}
                      disabled={isResolving || !isCurrentConversation}
                    >
                      <Text className="font-bold text-primary-foreground">
                        {isResolving ? 'VALIDATING...' : choice.input.submit_label || 'SUBMIT RESPONSE'}
                      </Text>
                    </Button>
                  </View>
                );
              }

              return (
                <Button
                  key={choice.id}
                  variant="outline"
                  className="min-h-[56px] w-full max-w-full items-start border-neon bg-[#111A22] px-3 py-3"
                  onPress={() => handleChoice(choice.id)}
                  disabled={isResolving}
                >
                  <View className="min-w-0 flex-1">
                    <Text className="font-bold text-white">{choice.label}</Text>
                    {choice.description && (
                      <Text className="mt-1 text-left text-xs text-[#8B949E]">{choice.description}</Text>
                    )}
                  </View>
                </Button>
              );
            })}
          </View>
        )}
        {isCurrentConversation && (
          <Button
            variant="ghost"
            className="mt-2"
            onPress={handleViewStatus}
            disabled={isResolving || statusRequestInFlight}
          >
            <Text className="text-xs text-muted-foreground font-semibold">
              {statusRequestInFlight ? 'STATUS REQUESTED' : 'VIEW CURRENT TASK STATUS'}
            </Text>
          </Button>
        )}
      </CardContent>

      <CardFooter className="flex-row flex-wrap gap-2 border-0 pt-2">
        <Button
          variant="outline"
          className="flex-1 border-border"
          onPress={handleDismiss}
          disabled={isResolving}
        >
          <Text className="text-muted-foreground font-semibold">
            {!isCurrentConversation ? 'OPEN TASK' : isResolving ? 'WAITING...' : choiceRequest ? 'CANCEL' : 'DISMISS'}
          </Text>
        </Button>
        {!choiceRequest && <Button
          variant="default"
          className="flex-1"
          onPress={handleApprove}
          disabled={isResolving}
        >
          <Text className="font-bold text-primary-foreground">
            {!isCurrentConversation ? 'OPEN TASK' : isResolving ? 'WAITING...' : 'CONFIRM & DEPLOY'}
          </Text>
        </Button>}
      </CardFooter>
    </Card>
  );
};

export default InterruptCard;
