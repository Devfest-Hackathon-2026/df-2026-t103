import 'package:flutter/material.dart';

import 'offline_draft_screen.dart';
import 'patient_theme.dart';

/// `flutter run -t lib/demo_offline_draft_preview.dart` で独立起動する。
void main() => runApp(const OfflineDraftPreview());

class OfflineDraftPreview extends StatelessWidget {
  const OfflineDraftPreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'オフライン・下書きデモ',
      theme: buildPatientTheme(),
      home: const OfflineDraftScreen(),
    );
  }
}
