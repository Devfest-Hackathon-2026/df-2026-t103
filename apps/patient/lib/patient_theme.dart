import 'package:flutter/material.dart';

/// 患者向けの文字サイズと配色。
ThemeData buildPatientTheme() {
  final base = ThemeData(
    colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
  );
  return base.copyWith(
    textTheme: base.textTheme.copyWith(
      bodySmall: base.textTheme.bodySmall?.copyWith(fontSize: 20),
      bodyMedium: base.textTheme.bodyMedium?.copyWith(fontSize: 20),
      bodyLarge: base.textTheme.bodyLarge?.copyWith(fontSize: 20),
      titleSmall: base.textTheme.titleSmall?.copyWith(fontSize: 22),
      titleMedium: base.textTheme.titleMedium?.copyWith(fontSize: 24),
      titleLarge: base.textTheme.titleLarge?.copyWith(fontSize: 28),
      headlineSmall: base.textTheme.headlineSmall?.copyWith(fontSize: 28),
      headlineMedium: base.textTheme.headlineMedium?.copyWith(fontSize: 30),
      headlineLarge: base.textTheme.headlineLarge?.copyWith(fontSize: 32),
    ),
  );
}
