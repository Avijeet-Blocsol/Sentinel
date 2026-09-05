import './global.css';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sentinel</Text>
      <Text style={styles.subtitle}>Barebones mobile setup ready (Expo SDK 54).</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#09090b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: 'bold',
  },
  subtitle: {
    color: '#a1a1aa',
    fontSize: 14,
    marginTop: 8,
  },
});
