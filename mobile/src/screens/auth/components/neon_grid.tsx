import React, { useEffect, useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, {
  Defs,
  LinearGradient,
  Rect,
  Line,
  Stop,
} from 'react-native-svg';
import Animated, {
  type SharedValue,
  cancelAnimation,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

const AnimatedLine = Animated.createAnimatedComponent(Line);

// Sentinel Theme Neon Green
const GRID_COLOR = '#0DF272';
const BRIGHT_PULSE = '#A8FFC7';

const COLUMNS = 14;
const ROWS = 14;

// Vanishing point ratio & bottom boundary
const HORIZON_RATIO = 0.70;
const BOTTOM_RATIO = 1;

// Perspective power (exponential spacing as lines approach viewer)
const PERSPECTIVE_POWER = 1.5;

function getPerspective(progress: number): number {
  'worklet';
  return Math.pow(Math.max(0, Math.min(1, progress)), PERSPECTIVE_POWER);
}

function getY(progress: number, horizonY: number, bottomY: number): number {
  'worklet';
  return horizonY + (bottomY - horizonY) * getPerspective(progress);
}

/**
 * Calculates the X coordinate of a column line at a given vertical progress.
 * Takes perspective fanning from the vanishing point into account.
 */
function getColumnX(
  columnFraction: number,
  progress: number,
  width: number
): number {
  'worklet';
  const p = getPerspective(progress);
  // Vanishing point at horizon is clustered around center
  const topX = width * 0.5 + (columnFraction - 0.5) * (width * 0.15);
  // Fan out wide across the bottom edge
  const bottomX = width * 0.5 + (columnFraction - 0.5) * (width * 2);
  return topX + (bottomX - topX) * p;
}

type HorizontalLineProps = {
  index: number;
  phase: SharedValue<number>;
  horizonY: number;
  bottomY: number;
  width: number;
};

const HorizontalLine = React.memo(function HorizontalLine({
  index,
  phase,
  horizonY,
  bottomY,
  width,
}: HorizontalLineProps) {
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    // Phase travels forward continuously [0 -> 1]
    const rawProgress = (index / ROWS + phase.value) % 1;
    const y = getY(rawProgress, horizonY, bottomY);

    // Span between outer edges of the perspective fan at this depth
    const x1 = Math.max(0, getColumnX(0, rawProgress, width));
    const x2 = Math.min(width, getColumnX(1, rawProgress, width));

    // Smooth fade at horizon (rawProgress -> 0) to avoid pop-in
    const lineOpacity = Math.min(1, rawProgress * 3.5) * 0.65;

    return {
      x1,
      y1: y,
      x2,
      y2: y,
      opacity: lineOpacity,
    };
  });

  return (
    <AnimatedLine
      animatedProps={animatedProps}
      stroke={GRID_COLOR}
      strokeWidth={2.4}
    />
  );
});

type PulseConnectionProps = {
  phase: SharedValue<number>;
  pulseOpacity: SharedValue<number>;
  activeRow: SharedValue<number>;
  activeColumn: SharedValue<number>;
  activeType: SharedValue<number>;
  horizonY: number;
  bottomY: number;
  width: number;
};

const PulseConnection = React.memo(function PulseConnection({
  phase,
  pulseOpacity,
  activeRow,
  activeColumn,
  activeType,
  horizonY,
  bottomY,
  width,
}: PulseConnectionProps) {
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    const row = activeRow.value;
    const col = activeColumn.value;

    const rowProgress1 = (row / ROWS + phase.value) % 1;
    const rowProgress2 = ((row + 1) / ROWS + phase.value) % 1;

    const y1 = getY(rowProgress1, horizonY, bottomY);
    const y2 = getY(rowProgress2, horizonY, bottomY);

    const colFrac1 = col / COLUMNS;
    const colFrac2 = (col + 1) / COLUMNS;

    if (activeType.value === 0) {
      // Horizontal pulse connecting adjacent columns on row
      const x1 = getColumnX(colFrac1, rowProgress1, width);
      const x2 = getColumnX(colFrac2, rowProgress1, width);
      return {
        x1,
        y1,
        x2,
        y2: y1,
        opacity: pulseOpacity.value,
      };
    }

    // Vertical pulse connecting row to row+1 along column
    const x1 = getColumnX(colFrac1, rowProgress1, width);
    const x2 = getColumnX(colFrac1, rowProgress2, width);
    return {
      x1,
      y1,
      x2,
      y2,
      opacity: pulseOpacity.value,
    };
  });

  return (
    <>
      {/* High intensity bloom glow */}
      <AnimatedLine
        animatedProps={animatedProps}
        stroke={GRID_COLOR}
        strokeWidth={11}
        strokeLinecap="round"
      />
      {/* Bright electric core */}
      <AnimatedLine
        animatedProps={animatedProps}
        stroke={BRIGHT_PULSE}
        strokeWidth={3.5}
        strokeLinecap="round"
      />
    </>
  );
});

function NeonGrid() {
  const { width, height } = useWindowDimensions();

  const horizonY = height * HORIZON_RATIO;
  const bottomY = height * BOTTOM_RATIO;

  const phase = useSharedValue(0);

  // Pulse Channel 1 (Frequent rapid blips)
  const pulseOpacity1 = useSharedValue(0);
  const activeRow1 = useSharedValue(4);
  const activeColumn1 = useSharedValue(3);
  const activeType1 = useSharedValue(0);

  // Pulse Channel 2 (Secondary staggered blips)
  const pulseOpacity2 = useSharedValue(0);
  const activeRow2 = useSharedValue(8);
  const activeColumn2 = useSharedValue(9);
  const activeType2 = useSharedValue(1);

  // Pulse Channel 3 (Tertiary fast blips)
  const pulseOpacity3 = useSharedValue(0);
  const activeRow3 = useSharedValue(12);
  const activeColumn3 = useSharedValue(6);
  const activeType3 = useSharedValue(0);

  useEffect(() => {
    phase.value = withRepeat(
      withTiming(1, { duration: 5500 }),
      -1,
      false
    );

    let t1: ReturnType<typeof setTimeout>;
    let t2: ReturnType<typeof setTimeout>;
    let t3: ReturnType<typeof setTimeout>;

    const flashSequence = () =>
      withSequence(
        withTiming(0, { duration: 0 }),
        withTiming(1, { duration: 70 }),
        withTiming(0.25, { duration: 180 }),
        withTiming(0, { duration: 250 })
      );

    // Channel 1: High frequency bursts (every 200-450ms)
    const triggerPulse1 = () => {
      activeRow1.value = 2 + Math.floor(Math.random() * (ROWS - 4));
      activeColumn1.value = Math.floor(Math.random() * COLUMNS);
      activeType1.value = Math.random() > 0.45 ? 0 : 1;
      pulseOpacity1.value = flashSequence();

      const delay = 200 + Math.random() * 250;
      t1 = setTimeout(triggerPulse1, delay);
    };

    // Channel 2: Staggered bursts (every 250-500ms)
    const triggerPulse2 = () => {
      activeRow2.value = 2 + Math.floor(Math.random() * (ROWS - 4));
      activeColumn2.value = Math.floor(Math.random() * COLUMNS);
      activeType2.value = Math.random() > 0.5 ? 0 : 1;
      pulseOpacity2.value = flashSequence();

      const delay = 250 + Math.random() * 300;
      t2 = setTimeout(triggerPulse2, delay);
    };

    // Channel 3: Rapid accent bursts (every 300-600ms)
    const triggerPulse3 = () => {
      activeRow3.value = 2 + Math.floor(Math.random() * (ROWS - 4));
      activeColumn3.value = Math.floor(Math.random() * COLUMNS);
      activeType3.value = Math.random() > 0.5 ? 0 : 1;
      pulseOpacity3.value = flashSequence();

      const delay = 300 + Math.random() * 350;
      t3 = setTimeout(triggerPulse3, delay);
    };

    t1 = setTimeout(triggerPulse1, 150);
    t2 = setTimeout(triggerPulse2, 350);
    t3 = setTimeout(triggerPulse3, 500);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      cancelAnimation(phase);
      cancelAnimation(pulseOpacity1);
      cancelAnimation(pulseOpacity2);
      cancelAnimation(pulseOpacity3);
    };
  }, []);

  const horizontalLines = useMemo(
    () => Array.from({ length: ROWS }, (_, i) => i),
    []
  );

  const verticalLines = useMemo(
    () => Array.from({ length: COLUMNS + 1 }, (_, i) => i),
    []
  );

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { zIndex: -1 }]}>
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="gridAtmosphere" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#050505" stopOpacity="1" />
            <Stop offset="0.35" stopColor="#050505" stopOpacity="0.85" />
            <Stop offset="0.6" stopColor={GRID_COLOR} stopOpacity="0.1" />
            <Stop offset="1" stopColor={GRID_COLOR} stopOpacity="0.25" />
          </LinearGradient>
        </Defs>

        {/* Ambient atmospheric glow fading into the obsidian background */}
        <Rect
          x="0"
          y={horizonY - 20}
          width={width}
          height={height - (horizonY - 20)}
          fill="url(#gridAtmosphere)"
        />

        {/* Perspective vertical lines fanning out across bottom */}
        {verticalLines.map((column) => {
          const frac = column / COLUMNS;
          const xTop = getColumnX(frac, 0, width);
          const xBottom = getColumnX(frac, 1, width);

          return (
            <Line
              key={`vert-${column}`}
              x1={xTop}
              y1={horizonY}
              x2={xBottom}
              y2={bottomY}
              stroke={GRID_COLOR}
              strokeWidth={2.4}
              opacity={0.55}
            />
          );
        })}

        {/* Moving horizontal lines */}
        {horizontalLines.map((index) => (
          <HorizontalLine
            key={`horiz-${index}`}
            index={index}
            phase={phase}
            horizonY={horizonY}
            bottomY={bottomY}
            width={width}
          />
        ))}

        {/* High-frequency multi-channel electric circuit pulses */}
        <PulseConnection
          phase={phase}
          pulseOpacity={pulseOpacity1}
          activeRow={activeRow1}
          activeColumn={activeColumn1}
          activeType={activeType1}
          horizonY={horizonY}
          bottomY={bottomY}
          width={width}
        />
        <PulseConnection
          phase={phase}
          pulseOpacity={pulseOpacity2}
          activeRow={activeRow2}
          activeColumn={activeColumn2}
          activeType={activeType2}
          horizonY={horizonY}
          bottomY={bottomY}
          width={width}
        />
        <PulseConnection
          phase={phase}
          pulseOpacity={pulseOpacity3}
          activeRow={activeRow3}
          activeColumn={activeColumn3}
          activeType={activeType3}
          horizonY={horizonY}
          bottomY={bottomY}
          width={width}
        />
      </Svg>
    </View>
  );
}

export default React.memo(NeonGrid);