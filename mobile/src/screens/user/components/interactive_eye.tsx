import React, {
  useEffect,
  useRef,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { View, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withSequence,
  withDelay,
} from 'react-native-reanimated';
import Svg, {
  Path,
  Circle,
  Defs,
  RadialGradient,
  Stop,
  G,
} from 'react-native-svg';
import * as Haptics from 'expo-haptics';

export interface InteractiveEyeRef {
  lookAt: (pageX: number, pageY: number) => void;
  blink: () => void;
}

export interface InteractiveEyeProps {
  size?: number;
  onPress?: () => void;
}

export const InteractiveEye = forwardRef<InteractiveEyeRef, InteractiveEyeProps>(
  ({ size = 72, onPress }, ref) => {
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    const containerRef = useRef<View>(null);

    // Default to approximate screen position so gaze works immediately before layout
    const eyeCenterRef = useRef<{ x: number; y: number }>({
      x: windowWidth / 2,
      y: windowHeight * 0.42,
    });

    // Animated values for pupil position and blinking
    const pupilX = useSharedValue(0);
    const pupilY = useSharedValue(0);
    const pupilScale = useSharedValue(1);
    const eyelidScaleY = useSharedValue(1);
    const eyeGlowOpacity = useSharedValue(0.7);

    // Measure eye center coordinates on screen reliably across Android/iOS
    const updateCenterCoords = useCallback(() => {
      if (!containerRef.current) return;
      containerRef.current.measureInWindow((x, y, width, height) => {
        if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
          eyeCenterRef.current = {
            x: x + width / 2,
            y: y + height / 2,
          };
        } else {
          containerRef.current?.measure((_ox, _oy, w, h, px, py) => {
            if (px !== undefined && py !== undefined) {
              eyeCenterRef.current = {
                x: px + w / 2,
                y: py + h / 2,
              };
            }
          });
        }
      });
    }, []);

    // Look towards specific screen coordinates
    const lookAt = useCallback(
      (targetX: number, targetY: number) => {
        updateCenterCoords();

        const cx = eyeCenterRef.current.x;
        const cy = eyeCenterRef.current.y;

        const dx = targetX - cx;
        const dy = targetY - cy;
        const distance = Math.hypot(dx, dy);

        if (distance === 0) return;

        // Angle towards click
        const angle = Math.atan2(dy, dx);

        // Human/stylized eye travel: wider range horizontally than vertically
        const maxRadiusX = (size / 72) * 14;
        const maxRadiusY = (size / 72) * 9.5;

        // Responsive gaze pull
        const pull = Math.min(1.0, Math.pow(distance / 130, 0.75));
        const targetOffsetX = Math.cos(angle) * maxRadiusX * pull;
        const targetOffsetY = Math.sin(angle) * maxRadiusY * pull;

        pupilX.value = withSpring(targetOffsetX, {
          damping: 15,
          stiffness: 160,
        });
        pupilY.value = withSpring(targetOffsetY, {
          damping: 15,
          stiffness: 160,
        });

        // Quick pupil dilation on focus
        pupilScale.value = withSequence(
          withTiming(1.15, { duration: 90 }),
          withSpring(1.0, { damping: 12 }),
        );

        eyeGlowOpacity.value = withSequence(
          withTiming(1.0, { duration: 100 }),
          withTiming(0.7, { duration: 500 }),
        );
      },
      [pupilX, pupilY, pupilScale, eyeGlowOpacity, updateCenterCoords],
    );

    // Blink animation
    const blink = useCallback(() => {
      eyelidScaleY.value = withSequence(
        withTiming(0.05, { duration: 80 }),
        withTiming(1.0, { duration: 130 }),
      );
    }, [eyelidScaleY]);

    // Expose lookAt and blink imperatively
    useImperativeHandle(
      ref,
      () => ({
        lookAt,
        blink,
      }),
      [lookAt, blink],
    );

    // Periodic natural blinking
    useEffect(() => {
      let isMounted = true;
      let timer: ReturnType<typeof setTimeout>;

      const scheduleNextBlink = () => {
        // Random blink interval between 3.5s and 6.5s
        const delay = 3500 + Math.random() * 3000;
        timer = setTimeout(() => {
          if (!isMounted) return;
          blink();
          scheduleNextBlink();
        }, delay);
      };

      scheduleNextBlink();

      return () => {
        isMounted = false;
        clearTimeout(timer);
      };
    }, [blink]);

    // Animated styles
    const animatedPupilStyle = useAnimatedStyle(() => ({
      transform: [
        { translateX: pupilX.value },
        { translateY: pupilY.value },
        { scale: pupilScale.value },
      ],
    }));

    const animatedEyelidStyle = useAnimatedStyle(() => ({
      transform: [{ scaleY: eyelidScaleY.value }],
    }));

    const animatedGlowStyle = useAnimatedStyle(() => ({
      opacity: eyeGlowOpacity.value,
    }));

    const handlePress = () => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      blink();
      // Center the gaze on direct eye tap
      pupilX.value = withSpring(0, { damping: 12 });
      pupilY.value = withSpring(0, { damping: 12 });
      onPress?.();
    };

    const halfSize = size / 2;

    return (
      <View
        ref={containerRef}
        onLayout={updateCenterCoords}
        style={{
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Ambient background glow */}
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: halfSize,
              backgroundColor: 'rgba(13, 242, 114, 0.12)',
              shadowColor: '#0DF272',
              shadowOffset: { width: 0, height: 0 },
              shadowOpacity: 0.8,
              shadowRadius: 18,
              elevation: 8,
            },
            animatedGlowStyle,
          ]}
        />

        <Pressable
          onPress={handlePress}
          hitSlop={8}
          style={{
            width: size,
            height: size,
            borderRadius: halfSize,
            backgroundColor: '#0D1117',
            borderWidth: 1.5,
            borderColor: 'rgba(13, 242, 114, 0.45)',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          <Animated.View
            style={[
              {
                width: size,
                height: size,
                alignItems: 'center',
                justifyContent: 'center',
              },
              animatedEyelidStyle,
            ]}
          >
            {/* Base Eye Socket & Contour */}
            <Svg width={size} height={size} viewBox="0 0 72 72">
              <Defs>
                {/* Sclera ambient gradient */}
                <RadialGradient id="scleraGrad" cx="50%" cy="50%" r="50%">
                  <Stop offset="0%" stopColor="#0a1a12" stopOpacity="1" />
                  <Stop offset="80%" stopColor="#060e0a" stopOpacity="1" />
                  <Stop offset="100%" stopColor="#050505" stopOpacity="1" />
                </RadialGradient>
              </Defs>

              {/* Almond Sclera Background */}
              <Path
                d="M 6 36 Q 36 12, 66 36 Q 36 60, 6 36 Z"
                fill="url(#scleraGrad)"
                stroke="#0DF272"
                strokeWidth="1.5"
                strokeOpacity="0.8"
              />

              {/* Decorative Cyber Top Arc */}
              <Path
                d="M 16 26 Q 36 16, 56 26"
                fill="none"
                stroke="#00F0FF"
                strokeWidth="1"
                strokeOpacity="0.5"
                strokeDasharray="3, 3"
              />

              {/* Decorative Cyber Bottom Arc */}
              <Path
                d="M 22 47 Q 36 53, 50 47"
                fill="none"
                stroke="#0DF272"
                strokeWidth="0.8"
                strokeOpacity="0.4"
                strokeDasharray="2, 2"
              />
            </Svg>

            {/* Interactive Pupil Layer */}
            <Animated.View
              style={[
                StyleSheet.absoluteFill,
                { alignItems: 'center', justifyContent: 'center' },
                animatedPupilStyle,
              ]}
              pointerEvents="none"
            >
              <Svg width={size} height={size} viewBox="0 0 72 72">
                <Defs>
                  {/* Iris Neon Gradient */}
                  <RadialGradient id="irisGrad" cx="50%" cy="50%" r="50%">
                    <Stop offset="0%" stopColor="#00F0FF" stopOpacity="1" />
                    <Stop offset="65%" stopColor="#0DF272" stopOpacity="1" />
                    <Stop offset="100%" stopColor="#05632d" stopOpacity="1" />
                  </RadialGradient>
                </Defs>

                {/* Outer Iris Ring */}
                <Circle
                  cx="36"
                  cy="36"
                  r="13.5"
                  fill="url(#irisGrad)"
                  stroke="#00F0FF"
                  strokeWidth="1"
                  strokeOpacity="0.9"
                />

                {/* Cyber Reticle Lines */}
                <Circle
                  cx="36"
                  cy="36"
                  r="9.5"
                  fill="none"
                  stroke="#050505"
                  strokeWidth="1"
                  strokeOpacity="0.6"
                />

                {/* Center Pupil Core */}
                <Circle cx="36" cy="36" r="6" fill="#050505" />

                {/* Inner Cyan Glowing Core */}
                <Circle cx="36" cy="36" r="2.5" fill="#00F0FF" opacity="0.9" />

                {/* Specular Catchlight reflection */}
                <Circle cx="32" cy="32" r="2" fill="#FFFFFF" opacity="0.9" />
                <Circle cx="39" cy="39" r="1" fill="#FFFFFF" opacity="0.5" />
              </Svg>
            </Animated.View>
          </Animated.View>
        </Pressable>
      </View>
    );
  },
);

InteractiveEye.displayName = 'InteractiveEye';
export default InteractiveEye;
