# Sentinel Project — Development Guidelines & Memory

## 🚨 MANDATORY ARCHITECTURAL RULES

### 1. File Naming Convention: `snake_case` ONLY
- **ALL new files must strictly use `snake_case` naming conventions** (e.g., `auth_screen.tsx`, `neo_grid.tsx`, `sound_service.ts`, `device_token.ts`).
- Avoid `camelCase` or `PascalCase` for filenames across both `mobile/`, `server/`, and `shared/`.

---

### 2. Styling & NativeWind v4: ZERO Dynamic ClassNames
- **NEVER** use dynamic string interpolation or runtime conditional class names in NativeWind v4:
  - ❌ **DO NOT DO THIS**:
    ```tsx
    className={cn(
      "flex-1 h-12 items-center justify-center",
      isActive ? "bg-primary shadow-sm" : "bg-transparent"
    )}
    ```
- **WHY**: In NativeWind v4 (`react-native-css-interop`) on React 19 / Hermes, dynamic class string changes invalidate the CSS variable / interop context across the entire `@rn-primitives` tree (`Card`, `TextClassContext`, `Text`). This causes synchronous cascade style recalculations on the single-threaded JS runtime (`mqt_v_js`), dropping touch events and completely freezing the UI.
- **ALWAYS use direct inline `style` props (or `StyleSheet.create`) for any dynamic, conditional, or interactive styling**:
  - ✅ **DO THIS**:
    ```tsx
    <Pressable
      hitSlop={8}
      style={{
        backgroundColor: isActive ? "#0DF272" : "transparent",
      }}
      className="flex-1 h-12 rounded-lg items-center justify-center"
    >
      <Text
        style={{
          color: isActive ? "#050505" : "#9CA3AF",
        }}
        className="font-bold text-xs"
      >
        Toggle
      </Text>
    </Pressable>
    ```
- **Static ClassNames Only**: Use `className` purely for static, build-time compilable layout properties (flex, layout flow, dimensions, spacing).

---

### 3. Keyboard Management
- Always use the official **`react-native-keyboard-controller`** package.
- Root provider in `App.tsx`: `<KeyboardProvider statusBarTranslucent navigationBarTranslucent>`.
- Forms/Screens: Use `<KeyboardAwareScrollView bottomOffset={...}>`. Do NOT implement custom layout-offset animations for keyboard handling.

---

### 4. Reanimated v4 & UI Performance
- Reanimated logger strict mode must be set to `strict: false` in `App.tsx` (`configureReanimatedLogger({ level: ReanimatedLogLevel.warn, strict: false })`) to prevent WebSocket warning floods on Hermes.
- In animations, always add `'worklet';` inside `useAnimatedProps` hooks so calculations execute entirely on the native UI thread.
- Heavy animated background components (e.g. `neo_grid`) must be isolated with `useMemo` and wrapped in `React.memo` to prevent re-renders on screen state changes.

---

### 5. Zero Scrollbars
- **NEVER show scrollbars in the application.**
- While the user can scroll, always specify `showsVerticalScrollIndicator={false}` and `showsHorizontalScrollIndicator={false}` on all `ScrollView`, `FlatList`, and `KeyboardAwareScrollView` components.
- Never use `persistentScrollbar={true}`.

---

## Project Structure
- **`mobile/`**: React Native (Expo SDK 57, React 19.2, NativeWind v4, Clerk Auth, React Native Reusables).
- **`server/`**: Fastify backend, SQLite (`node:sqlite`), AWS Bedrock / Strands Agents SDK.
- **`shared/`**: Monorepo shared TypeScript schemas, contracts, and type definitions.