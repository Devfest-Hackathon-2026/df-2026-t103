import 'package:flutter/material.dart';

import 'delivery_status_screen.dart';
import 'patient_theme.dart';

/// 通常アプリには接続しない、架空データのみの独立プレビュー。
void main() => runApp(const DeliveryStatusPreview());

class DeliveryStatusPreview extends StatefulWidget {
  const DeliveryStatusPreview({super.key});

  @override
  State<DeliveryStatusPreview> createState() => _DeliveryStatusPreviewState();
}

class _DeliveryStatusPreviewState extends State<DeliveryStatusPreview> {
  DemoDeliveryStatus status = DemoDeliveryStatus.created;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '送信結果デモ',
      theme: buildPatientTheme(),
      home: DeliveryStatusScreen(
        status: status,
        onStatusChanged: (value) => setState(() => status = value),
      ),
    );
  }
}
