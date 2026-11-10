import 'package:flutter/material.dart';

/// 実際の OCR ジョブには接続しない画面プレビュー。
class OcrProcessingScreen extends StatelessWidget {
  const OcrProcessingScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('OCR処理中のデモ')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('画面のデモ', style: theme.textTheme.titleLarge),
                  const SizedBox(height: 16),
                  const Text('これは架空の表示です。実際の写真の読み取りは行っていません。'),
                  const SizedBox(height: 32),
                  const Center(
                    child: ExcludeSemantics(child: CircularProgressIndicator()),
                  ),
                  const SizedBox(height: 24),
                  Semantics(
                    header: true,
                    child: Text(
                      '写真を読み取っています（表示例）',
                      style: theme.textTheme.titleLarge,
                    ),
                  ),
                  const SizedBox(height: 16),
                  const Text('進捗は表示例です。処理状態の保存や通知は行いません。'),
                  const SizedBox(height: 32),
                  const FilledButton(
                    onPressed: null,
                    child: Text('あとで確認（未接続）'),
                  ),
                  const SizedBox(height: 8),
                  const Text('「あとで確認」はこのデモでは使えません。'),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
