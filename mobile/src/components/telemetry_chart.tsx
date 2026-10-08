/**
 * Strands Sentinel - Telemetry Sparkline & Chart
 * Powered by react-native-gifted-charts with Neon Green + Obsidian gradient styling.
 */

import React from 'react';
import { View, Text, Dimensions } from 'react-native';
import { LineChart } from 'react-native-gifted-charts';
import type { TelemetryPoint } from '@sentinel/shared';

export type TelemetryPresentation = 'time_series' | 'event';

interface TelemetryChartProps {
  dataPoints: TelemetryPoint[];
  metricName?: string;
  height?: number;
  presentation?: TelemetryPresentation;
  ruleStatus?: 'ACTIVE' | 'PAUSED' | 'TRIGGERED' | 'DISMISSED' | 'ARCHIVED';
}

export const TelemetryChart: React.FC<TelemetryChartProps> = ({
  dataPoints,
  metricName = 'metric',
  height = 110,
  presentation = 'time_series',
  ruleStatus = 'ACTIVE',
}) => {
  const screenWidth = Dimensions.get('window').width - 64; // Accounting for card padding
  const isEventPresentation = presentation === 'event';
  const sectionLabel = isEventPresentation ? `${metricName} Activity` : `${metricName} Telemetry`;

  if (dataPoints.length === 0) {
    const emptyMessage = isEventPresentation
      ? 'Telemetry is not applicable; matching events appear in Alerts.'
      : ruleStatus === 'PAUSED'
        ? 'Telemetry will resume when this Sentinel is active.'
        : ruleStatus === 'TRIGGERED' || ruleStatus === 'DISMISSED' || ruleStatus === 'ARCHIVED'
          ? 'No telemetry snapshot was recorded for this event.'
          : 'Waiting for the first evaluation...';

    return (
      <View className="my-2 overflow-hidden rounded-xl bg-[#080B10] p-3 border border-[#161B22] items-center justify-center">
        <View className="flex-row items-center justify-between w-full px-1 pb-1">
          <Text className="text-[11px] font-bold uppercase tracking-wider text-[#8B949E]">
            {sectionLabel}
          </Text>
          <Text className="font-mono text-[11px] font-bold text-zinc-500">
            --
          </Text>
        </View>
        <Text className="text-[11px] font-mono text-zinc-500 py-3 text-center">
          {emptyMessage}
        </Text>
      </View>
    );
  }

  // Format data points for gifted-charts
  const chartData = dataPoints.map((p) => ({
    value: p.value,
    label: new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  }));

  return (
    <View className="my-2 overflow-hidden rounded-xl bg-[#080B10] p-2 border border-[#161B22]">
      <View className="flex-row items-center justify-between px-2 pb-1">
        <Text className="text-[11px] font-bold uppercase tracking-wider text-[#8B949E]">
          {sectionLabel} (Live)
        </Text>
        <Text className="font-mono text-[11px] font-bold text-neon">
          {chartData[chartData.length - 1]?.value?.toFixed(1) ?? '--'}
        </Text>
      </View>

      <LineChart
        data={chartData}
        height={height}
        width={screenWidth}
        color="#0DF272"
        thickness={2.5}
        startFillColor="rgba(13, 242, 114, 0.35)"
        endFillColor="rgba(5, 5, 5, 0.0)"
        startOpacity={0.9}
        endOpacity={0.1}
        areaChart
        curved
        hideDataPoints={false}
        dataPointsColor="#00FF66"
        dataPointsRadius={4}
        hideRules
        hideYAxisText
        hideAxesAndRules
        initialSpacing={10}
        spacing={screenWidth / (chartData.length + 1)}
      />
    </View>
  );
};
