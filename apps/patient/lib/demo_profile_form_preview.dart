import 'package:flutter/material.dart';

import 'patient_theme.dart';
import 'profile_form_screen.dart';

/// `flutter run -t lib/demo_profile_form_preview.dart` で独立起動する。
void main() => runApp(const ProfileFormPreview());

class ProfileFormPreview extends StatelessWidget {
  const ProfileFormPreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'プロフィール登録デモ',
      theme: buildPatientTheme(),
      home: const ProfileFormScreen(),
    );
  }
}
