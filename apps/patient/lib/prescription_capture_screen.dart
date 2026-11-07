import 'package:flutter/material.dart';

/// カメラ/ギャラリー/PDF の取込に接続しない処方箋撮影・選択（P-021）の
/// プレビュー。
///
/// 処方箋には個人情報が含まれる旨を明示してから取込方法（カメラ・ギャラリー・
/// PDF）を選ばせる（docs/03 §2 P-021 備考）。対応形式・枚数・容量の制限を案内する
/// （FR-M01）。image_picker / file_picker と uploads（init→upload→complete）は
/// 未接続。
class PrescriptionCaptureScreen extends StatelessWidget {
  const PrescriptionCaptureScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('処方箋の取り込みデモ')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('架空のデモです。実際の処方箋は取り込みません。'),
              const Text('画像はこのデモでは保存も送信もされません。'),
              const SizedBox(height: 16),
              Semantics(
                header: true,
                child: Text('処方箋を取り込む', style: textTheme.titleLarge),
              ),
              const SizedBox(height: 16),
              // 個人情報撮影の説明（docs/03 P-021 備考）。
              Card(
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                child: const Padding(
                  padding: EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('撮影・選択する前にご確認ください'),
                      SizedBox(height: 8),
                      Text('処方箋には、お名前や生年月日などの個人情報が含まれます。'),
                      Text('写っている情報をご確認のうえ、取り込んでください。'),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text('取り込み方法を選ぶ', style: textTheme.titleMedium),
              const SizedBox(height: 8),
              _MethodButton(
                icon: Icons.camera_alt,
                label: 'カメラで撮影する',
                onPressed: () => _demo(context, 'カメラ'),
              ),
              _MethodButton(
                icon: Icons.photo_library,
                label: '写真から選ぶ',
                onPressed: () => _demo(context, '写真（ギャラリー）'),
              ),
              _MethodButton(
                icon: Icons.picture_as_pdf,
                label: 'PDFを選ぶ',
                onPressed: () => _demo(context, 'PDF'),
              ),
              const SizedBox(height: 16),
              const Divider(),
              Text('取り込みの条件', style: textTheme.titleMedium),
              const SizedBox(height: 8),
              const Text('・写真は JPEG・PNG、処方箋は PDF も使えます。'),
              const Text('・1 回に取り込める枚数とファイルの大きさには上限があります。'),
              const Text('・上限は取り込み時にご案内します（このデモでは未接続）。'),
              const SizedBox(height: 16),
              const Text('読み取り（P-022 OCR）はこのデモでは未接続です。'),
              const ElevatedButton(
                onPressed: null,
                child: Text('読み取りに進む'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _demo(BuildContext context, String method) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('（デモ）$method からの取り込みは未接続です。')),
    );
  }
}

class _MethodButton extends StatelessWidget {
  const _MethodButton({
    required this.icon,
    required this.label,
    required this.onPressed,
  });

  final IconData icon;
  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: OutlinedButton.icon(
        onPressed: onPressed,
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(48, 56),
          textStyle: const TextStyle(fontSize: 20),
        ),
        icon: Icon(icon),
        label: Text(label),
      ),
    );
  }
}
