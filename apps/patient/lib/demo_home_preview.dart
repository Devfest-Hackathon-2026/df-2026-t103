import 'package:flutter/material.dart';

import 'home_screen.dart';
import 'patient_theme.dart';

// flutter run -t lib/demo_home_preview.dart で明示的に起動する。
void main() => runApp(const HomePreviewApp());

class HomePreviewApp extends StatelessWidget {
  const HomePreviewApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'もしもし問診 ホームプレビュー',
    theme: buildPatientTheme(),
    home: const HomeScreen(),
  );
}
