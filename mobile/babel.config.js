module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    // Reanimated 4 moved its transformer to react-native-worklets.
    // It must remain the final Babel plugin.
    plugins: ['react-native-worklets/plugin'],
  };
};
