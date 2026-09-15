import * as React from 'react';
import {
  ScrollView as RNScrollView,
  type ScrollViewProps as RNScrollViewProps,
} from 'react-native';
import { cn } from '../../lib/utils';

export interface ScrollViewProps extends RNScrollViewProps {
  className?: string;
}

/**
 * ScrollView primitive that suppresses visible scrollbars, indicator tracks,
 * and overscroll glow containers by default while preserving full, smooth scroll behavior.
 */
const ScrollView = React.forwardRef<RNScrollView, ScrollViewProps>(
  (
    {
      className,
      showsVerticalScrollIndicator = false,
      showsHorizontalScrollIndicator = false,
      overScrollMode = 'never',
      ...props
    },
    ref
  ) => {
    return (
      <RNScrollView
        ref={ref}
        showsVerticalScrollIndicator={showsVerticalScrollIndicator}
        showsHorizontalScrollIndicator={showsHorizontalScrollIndicator}
        overScrollMode={overScrollMode}
        className={cn('flex-1', className)}
        {...props}
      />
    );
  }
);

ScrollView.displayName = 'ScrollView';

export { ScrollView };
