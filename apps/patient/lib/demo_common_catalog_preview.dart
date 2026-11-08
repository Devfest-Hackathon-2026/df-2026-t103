import 'package:flutter/material.dart';

import 'patient_common.dart';
import 'patient_theme.dart';

/// 共通状態・共通コンポーネントのカタログ（storybook 相当）。
/// `flutter run -t lib/demo_common_catalog_preview.dart` で独立起動する。
void main() => runApp(const CommonCatalogPreview());

class CommonCatalogPreview extends StatelessWidget {
  const CommonCatalogPreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '共通コンポーネントのカタログ',
      theme: buildPatientTheme(),
      home: const _CatalogScreen(),
    );
  }
}

class _CatalogScreen extends StatelessWidget {
  const _CatalogScreen();

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    void retry() => ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('（デモ）もう一度試します。')),
        );
    Widget section(String title, Widget child) => Padding(
          padding: const EdgeInsets.only(bottom: 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Semantics(
                header: true,
                child: Text(title, style: textTheme.titleMedium),
              ),
              const SizedBox(height: 8),
              Card(child: child),
            ],
          ),
        );

    return Scaffold(
      appBar: AppBar(title: const Text('共通コンポーネントのカタログ')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Text('架空のデモです。共通の状態表示・部品の確認用カタログです。'),
            const SizedBox(height: 16),
            section('状態: 読み込み中',
                const PatientStateView(status: PatientStatus.loading)),
            section('状態: 空',
                const PatientStateView(status: PatientStatus.empty)),
            section(
              '状態: エラー（再試行あり）',
              PatientStateView(status: PatientStatus.error, onRetry: retry),
            ),
            section(
              '状態: オフライン（再試行あり）',
              PatientStateView(status: PatientStatus.offline, onRetry: retry),
            ),
            section(
              '部品: 主要ボタン（有効）',
              Padding(
                padding: const EdgeInsets.all(16),
                child: PatientPrimaryButton(label: '次へ', onPressed: () {}),
              ),
            ),
            section(
              '部品: 主要ボタン（無効）',
              const Padding(
                padding: EdgeInsets.all(16),
                child: PatientPrimaryButton(label: '次へ', onPressed: null),
              ),
            ),
            section(
              '共通文言: 医療行為でない',
              const Padding(
                padding: EdgeInsets.all(16),
                child: NotMedicalNotice(),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
