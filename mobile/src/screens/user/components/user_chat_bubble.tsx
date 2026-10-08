/**
 * Strands Sentinel - UserChatBubble
 * Renders user chat messages with:
 * - Max width capped at 50% of the screen
 * - Automatic detection if text exceeds 3 lines
 * - Truncation to 3 lines with ellipsis when collapsed
 * - Expandable via interactive down arrow button (only visible if > 3 lines)
 */

import React, { useState, useCallback, useEffect, memo } from 'react';
import {
  View,
  Pressable,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
} from 'react-native';
import { ChevronDown, ChevronUp } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/ui';

interface UserChatBubbleProps {
  content: string;
}

export const UserChatBubble = memo(function UserChatBubble({ content }: UserChatBubbleProps) {
  const { width: screenWidth } = useWindowDimensions();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isMoreThanThreeLines, setIsMoreThanThreeLines] = useState(false);

  // Reset line state if content changes
  useEffect(() => {
    setIsMoreThanThreeLines(false);
  }, [content]);

  // Measure text lines layout
  const handleTextLayout = useCallback((e: NativeSyntheticEvent<TextLayoutEventData>) => {
    if (e.nativeEvent.lines.length > 3) {
      setIsMoreThanThreeLines(true);
    }
  }, []);

  const toggleExpand = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsExpanded((prev) => !prev);
  }, []);

  // 50% screen width minus horizontal padding (px-5 = 20px on each side = 40px)
  const maxContentWidth = Math.max(screenWidth * 0.5 - 40, 100);

  return (
    <View
      style={{ maxWidth: screenWidth * 0.5 }}
      className="self-end rounded-[24px] px-5 py-4 bg-[#1E1F22] border border-zinc-800/40 my-2 shadow-lg"
    >
      {/* Off-screen measurement probe ensuring line count is determined accurately without layout shift */}
      {!isMoreThanThreeLines && (
        <View
          style={{
            position: 'absolute',
            left: -9999,
            top: -9999,
            width: maxContentWidth,
            opacity: 0,
          }}
          pointerEvents="none"
        >
          <Text
            onTextLayout={handleTextLayout}
            className="text-[15px] leading-6 font-normal"
          >
            {content}
          </Text>
        </View>
      )}

      {/* Visible Message Content */}
      <Text
        numberOfLines={isExpanded ? undefined : 3}
        ellipsizeMode="tail"
        onTextLayout={handleTextLayout}
        className="text-white text-[15px] leading-6 font-normal"
      >
        {content}
      </Text>

      {/* Down/Up Arrow Toggle Button (only rendered if text is more than 3 lines) */}
      {isMoreThanThreeLines && (
        <Pressable
          hitSlop={8}
          onPress={toggleExpand}
          className="w-6 h-6 rounded-full bg-zinc-800/80 items-center justify-center self-end mt-2 active:bg-zinc-700"
        >
          {isExpanded ? (
            <ChevronUp size={13} color="#C4C7C5" />
          ) : (
            <ChevronDown size={13} color="#C4C7C5" />
          )}
        </Pressable>
      )}
    </View>
  );
});
