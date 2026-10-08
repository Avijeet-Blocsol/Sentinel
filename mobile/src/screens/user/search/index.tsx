import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import {
  View,
  TextInput,
  Pressable,
  StatusBar,
  BackHandler,
  ActivityIndicator,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Search, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { Screen, useSafeAreaInsets, Text } from '@/components/ui';
import { useSentinel } from '@/hooks/use_sentinel';
import { isCancellation } from '@/api/http_adapter';
import type { AgentConversation } from '@sentinel/shared';

export interface SentinelTaskItem {
  id: string;
  title: string;
  date: string;
  phase?: string;
}

interface SearchSentinelTasksScreenProps {
  onBack?: () => void;
  onSelectTask?: (conversationId: string, taskTitle?: string) => void;
}

export function SearchSentinelTasksScreen({ onBack, onSelectTask }: SearchSentinelTasksScreenProps) {
  const insets = useSafeAreaInsets();
  const { http } = useSentinel();

  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<SentinelTaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Search server conversations with debouncing
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(async () => {
      setLoading(true);
      setErrorMessage(null);
      try {
        const queryParams = searchQuery.trim().length > 0 ? { q: searchQuery.trim(), limit: 30 } : { limit: 20 };
        const res = await http.listConversations(queryParams, { signal: controller.signal });
        if (!disposed && res.conversations) {
          setResults(
            res.conversations.map((c: AgentConversation) => ({
              id: c.id,
              title: c.title,
              phase: c.phase,
              date: new Date(c.created_at).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              }),
            }))
          );
        }
      } catch (err) {
        if (!isCancellation(err) && !disposed) {
          console.warn('[SearchSentinelTasks] Search failed:', err);
          setErrorMessage(err instanceof Error ? err.message : 'Search could not be completed');
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    }, 250);

    return () => {
      disposed = true;
      controller.abort();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [searchQuery, http]);

  // Handle Android hardware back press -> returns to navigation pane
  useEffect(() => {
    const handleBack = () => {
      if (onBack) {
        onBack();
        return true;
      }
      return false;
    };

    const backHandler = BackHandler.addEventListener('hardwareBackPress', handleBack);
    return () => backHandler.remove();
  }, [onBack]);

  const handleClearOrBack = useCallback(() => {
    Haptics.selectionAsync();
    if (searchQuery.trim().length > 0) {
      setSearchQuery('');
    } else if (onBack) {
      onBack();
    }
  }, [searchQuery, onBack]);

  const handleItemPress = (item: SentinelTaskItem) => {
    Haptics.selectionAsync();
    onSelectTask?.(item.id, item.title);
  };

  const contentContainerStyle = useMemo(
    () => ({
      flexGrow: 1,
      paddingBottom: Math.max(insets.bottom, 16) + 20,
    }),
    [insets.bottom],
  );

  return (
    <Screen edges={['top', 'left', 'right', 'bottom']} className="flex-1 bg-[#050505]">
      <StatusBar barStyle="light-content" backgroundColor="#050505" />

      {/* Top Search Bar */}
      <View className="flex-row items-center px-4 pt-2 pb-3 border-b border-zinc-900">
        <View className="mr-3">
          <Search size={22} color="#C4C7C5" />
        </View>

        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search for Sentinel Tasks"
          placeholderTextColor="#71717A"
          className="flex-1 text-white text-base py-2"
          autoFocus
          autoCorrect={false}
          returnKeyType="search"
        />

        {loading ? (
          <View className="w-10 h-10 items-center justify-center">
            <ActivityIndicator size="small" color="#0DF272" />
          </View>
        ) : (
          <Pressable
            hitSlop={12}
            onPress={handleClearOrBack}
            className="w-10 h-10 items-center justify-center rounded-full active:bg-zinc-800"
          >
            <X size={22} color="#C4C7C5" />
          </Pressable>
        )}
      </View>

      {/* Section Header */}
      <View className="px-5 pt-4 pb-2">
        <Text variant="muted" className="text-zinc-400 font-normal text-sm">
          {searchQuery.trim().length > 0 ? 'Results' : 'Recent Sentinel Tasks'}
        </Text>
      </View>

      {errorMessage && (
        <View className="mx-5 mb-2 px-3 py-2 rounded-xl bg-red-950/40 border border-red-500/30">
          <Text className="text-xs text-red-300" numberOfLines={2}>{errorMessage}</Text>
        </View>
      )}

      {/* Keyboard Aware Results List — Zero scrollbars visible per project guidelines */}
      <KeyboardAwareScrollView
        bottomOffset={24}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={contentContainerStyle}
      >
        <View className="px-5">
          {results.length > 0 ? (
            results.map((task) => (
              <Pressable
                key={task.id}
                onPress={() => handleItemPress(task)}
                className="flex-row items-center justify-between py-3.5 border-b border-zinc-900/50 active:bg-zinc-900/40 rounded-lg px-1"
              >
                <View className="flex-1 pr-4">
                  <Text
                    numberOfLines={1}
                    className="text-white text-base font-normal"
                  >
                    {task.title}
                  </Text>
                  {task.phase && (
                    <Text variant="muted" className="text-[10px] font-mono text-neon uppercase mt-0.5">
                      {task.phase}
                    </Text>
                  )}
                </View>
                <Text variant="muted" className="text-zinc-500 text-xs font-normal whitespace-nowrap">
                  {task.date}
                </Text>
              </Pressable>
            ))
          ) : (
            <View className="py-12 items-center justify-center">
              <Text variant="muted" className="text-sm text-zinc-500 text-center">
                {searchQuery.trim().length > 0
                  ? `No Sentinel Tasks found matching "${searchQuery}"`
                  : 'No recent tasks recorded.'}
              </Text>
            </View>
          )}
        </View>
      </KeyboardAwareScrollView>
    </Screen>
  );
}

export const SearchChatsScreen = SearchSentinelTasksScreen;
export default SearchSentinelTasksScreen;
