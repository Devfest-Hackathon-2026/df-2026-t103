import 'package:flutter/material.dart';

import 'firebase_bootstrap.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initializeDemoFirebase(EmulatorConfig.fromEnvironment());
  runApp(const PatientApp());
}

/// アプリのルート Widget。
class PatientApp extends StatelessWidget {
  const PatientApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'もしもし問診 患者アプリ',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
      ),
      home: const DemoPlaceholderScreen(),
    );
  }
}

/// 未実装であることを明示するための、最小限のデモ準備画面。
///
/// 機能はまだ無く、患者データの入力も行わない。実装が進むまでの仮表示であり、
/// 医療判断や安全に関する文言は含めない。
class DemoPlaceholderScreen extends StatelessWidget {
  const DemoPlaceholderScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('もしもし問診 患者アプリ')),
      body: SafeArea(
        // 文字拡大（OS の text scale）で overflowing しないよう、
        // 内容はスクロール可能にしておく。
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(minWidth: double.infinity),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('雛形デモ', style: Theme.of(context).textTheme.titleLarge),
                  const SizedBox(height: 16),
                  const Text('この患者アプリの機能は未実装です。'),
                  const SizedBox(height: 8),
                  const Text(
                    '本画面は実装までの仮表示であり、患者情報の入力や'
                    '医療サービスは提供されません。',
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
