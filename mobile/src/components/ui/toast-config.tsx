import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ToastConfig } from 'react-native-toast-message';
import { CheckCircle2, AlertTriangle, XCircle, Info } from 'lucide-react-native';

/**
 * Cyber Obsidian custom styled toast notifications for Sentinel
 */
export const toastConfig: ToastConfig = {
  success: ({ text1, text2 }) => (
    <View style={[styles.baseToast, styles.successToast]}>
      <View style={styles.iconContainer}>
        <CheckCircle2 size={20} color="#0DF272" />
      </View>
      <View style={styles.textContainer}>
        {text1 ? <Text style={styles.titleText}>{text1}</Text> : null}
        {text2 ? <Text style={styles.messageText}>{text2}</Text> : null}
      </View>
    </View>
  ),

  error: ({ text1, text2 }) => (
    <View style={[styles.baseToast, styles.errorToast]}>
      <View style={styles.iconContainer}>
        <XCircle size={20} color="#FF5555" />
      </View>
      <View style={styles.textContainer}>
        {text1 ? <Text style={[styles.titleText, { color: '#FF5555' }]}>{text1}</Text> : null}
        {text2 ? <Text style={styles.messageText}>{text2}</Text> : null}
      </View>
    </View>
  ),

  info: ({ text1, text2 }) => (
    <View style={[styles.baseToast, styles.infoToast]}>
      <View style={styles.iconContainer}>
        <Info size={20} color="#58A6FF" />
      </View>
      <View style={styles.textContainer}>
        {text1 ? <Text style={styles.titleText}>{text1}</Text> : null}
        {text2 ? <Text style={styles.messageText}>{text2}</Text> : null}
      </View>
    </View>
  ),

  warning: ({ text1, text2 }) => (
    <View style={[styles.baseToast, styles.warningToast]}>
      <View style={styles.iconContainer}>
        <AlertTriangle size={20} color="#E3B341" />
      </View>
      <View style={styles.textContainer}>
        {text1 ? <Text style={[styles.titleText, { color: '#E3B341' }]}>{text1}</Text> : null}
        {text2 ? <Text style={styles.messageText}>{text2}</Text> : null}
      </View>
    </View>
  ),
};

const styles = StyleSheet.create({
  baseToast: {
    width: '92%',
    maxWidth: 420,
    backgroundColor: '#0D1117',
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 20,
  },
  successToast: {
    borderColor: '#0DF272',
  },
  errorToast: {
    borderColor: '#FF5555',
  },
  infoToast: {
    borderColor: '#58A6FF',
  },
  warningToast: {
    borderColor: '#E3B341',
  },
  iconContainer: {
    marginRight: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textContainer: {
    flex: 1,
    gap: 3,
  },
  titleText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  messageText: {
    color: '#8B949E',
    fontSize: 12,
    lineHeight: 16,
  },
});
