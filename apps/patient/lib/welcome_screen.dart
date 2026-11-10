import 'package:flutter/material.dart';

/// 利用開始前にサービスの目的とデモの制限を伝える画面（P-001）。
class WelcomeScreen extends StatelessWidget {
  const WelcomeScreen({super.key, this.onStart});

  /// 「利用開始」が押されたときに呼ばれる。null の場合は開始できない表示のまま。
  final VoidCallback? onStart;

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
                  Text(
                    onStart == null
                        ? 'デモ版では認証・同意・利用開始後の画面が未実装のため、'
                            '利用を開始できません。患者情報の入力もできません。'
                        : 'ローカル確認用の画面です。実患者情報は入力しないでください。',
                    style: const TextStyle(fontSize: 20),
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: onStart,
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
