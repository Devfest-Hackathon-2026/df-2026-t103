import 'package:flutter/material.dart';

import 'firebase_bootstrap.dart';
import 'patient_theme.dart';

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
      theme: buildPatientTheme(),
      home: const WelcomeScreen(),
    );
  }
}

/// 利用開始前にサービスの目的とデモの制限を伝える画面。
class WelcomeScreen extends StatelessWidget {
  const WelcomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 600),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Semantics(
                    header: true,
                    child: Text(
                      'もしもし問診へようこそ',
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                  ),
                  const SizedBox(height: 24),
                  const Text(
                    '医療機関に伝える患者情報の整理を支援するサービスです。',
                    style: TextStyle(fontSize: 20),
                  ),
                  const SizedBox(height: 16),
                  const Text(
                    '診断・治療・受診予約は行いません。',
                    style: TextStyle(fontSize: 20),
                  ),
                  const SizedBox(height: 24),
                  const Text(
                    'デモ版では認証・同意・利用開始後の画面が未実装のため、'
                    '利用を開始できません。患者情報の入力もできません。',
                    style: TextStyle(fontSize: 20),
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: null,
                      style: FilledButton.styleFrom(
                        minimumSize: const Size(48, 48),
                        textStyle: const TextStyle(fontSize: 20),
                      ),
                      child: const Text('利用開始'),
                    ),
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
