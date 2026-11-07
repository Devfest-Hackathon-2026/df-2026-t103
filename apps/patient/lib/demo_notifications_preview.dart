import 'package:flutter/material.dart';

import 'notifications_screen.dart';
import 'patient_theme.dart';

/// `flutter run -t lib/demo_notifications_preview.dart` で独立起動する。
void main() => runApp(const NotificationsPreview());

class NotificationsPreview extends StatelessWidget {
  const NotificationsPreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '通知デモ',
      theme: buildPatientTheme(),
      home: const NotificationsScreen(),
    );
  }
}
