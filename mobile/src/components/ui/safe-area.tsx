import * as React from 'react';
import {
  SafeAreaView as RNSafeAreaView,
  SafeAreaProvider,
  useSafeAreaInsets,
  type NativeSafeAreaViewProps,
  type Edge,
} from 'react-native-safe-area-context';
import { cn } from '../../lib/utils';

export interface ScreenProps extends NativeSafeAreaViewProps {
  children?: React.ReactNode;
  className?: string;
  edges?: readonly Edge[];
}

/**
 * Screen container that automatically respects device notches, dynamic islands,
 * and bottom home indicators on both iOS and Android.
 */
const Screen = React.forwardRef<any, ScreenProps>(
  ({ className, edges = ['top', 'bottom', 'left', 'right'], children, ...props }, ref) => {
    return (
      <RNSafeAreaView
        ref={ref}
        edges={edges}
        className={cn('flex-1 bg-obsidian', className)}
        {...props}
      >
        {children}
      </RNSafeAreaView>
    );
  }
);

Screen.displayName = 'Screen';

export {
  Screen,
  RNSafeAreaView as SafeAreaView,
  SafeAreaProvider,
  useSafeAreaInsets,
};
