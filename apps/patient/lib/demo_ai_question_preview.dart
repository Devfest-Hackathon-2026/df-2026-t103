import 'package:flutter/material.dart';

import 'ai_question_screen.dart';
import 'patient_theme.dart';

/// `flutter run -t lib/demo_ai_question_preview.dart` で独立起動する。
void main() => runApp(const AiQuestionPreview());

class AiQuestionPreview extends StatelessWidget {
  const AiQuestionPreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '問診Q&Aデモ',
      theme: buildPatientTheme(),
      home: const AiQuestionScreen(),
    );
  }
}
