import 'package:flutter/material.dart';

/// 受信通知 1 件。本文は一般文言のみで、症状・薬などの個人情報を含まない
/// （FR-O01/O05）。すべて架空の表示用データ。
@immutable
class PatientNotification {
  const PatientNotification({
    required this.title,
    required this.body,
    required this.receivedAgo,
  });

  final String title;
  final String body;
  final String receivedAgo;
}

/// FCM / devices API に接続しない通知受信表示（PHI 非含有）のプレビュー。
///
/// 通知の受け取り許可の説明と拒否時の動作を示し、受信した通知は一般文言のみで
/// 表示する（FR-O01/O05）。通知タップ遷移・FCM 登録（/me/devices）は未接続。
class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  bool _enabled = true;

  // 架空のサンプル。いずれも一般文言のみで PHI を含まない。
  static const _notifications = [
    PatientNotification(
      title: '送信を受け付けました',
      body: '問診の送信を受け付けました。アプリで状況を確認できます。',
      receivedAgo: '10分前',
    ),
    PatientNotification(
      title: '医療機関が確認しました',
      body: '送信した問診を医療機関が確認しました。',
      receivedAgo: '1時間前',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('通知デモ')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('架空のデモです。通知の送受信は行いません。'),
              const SizedBox(height: 16),
              Semantics(
                header: true,
                child: Text('通知の受け取り', style: textTheme.titleMedium),
              ),
              const SizedBox(height: 8),
              const Text('送信の受付や医療機関での確認などをお知らせします。'),
              const Text('通知には、症状やお薬などの個人情報は含めません。'),
              SwitchListTile(
                title: const Text('通知を受け取る'),
                value: _enabled,
                onChanged: (value) => setState(() => _enabled = value),
              ),
              Text(
                _enabled
                    ? '通知を受け取ります。'
                    : '通知を受け取りません。許可しない場合も、状況はアプリの中で確認できます。',
              ),
              const SizedBox(height: 24),
              Semantics(
                header: true,
                child: Text('受け取った通知（表示例）', style: textTheme.titleMedium),
              ),
              const SizedBox(height: 8),
              for (final notification in _notifications)
                _NotificationCard(
                  notification: notification,
                  onTap: () => _open(notification),
                ),
              const SizedBox(height: 8),
              const Text('通知をタップしたときの画面遷移は、このデモでは未接続です。'),
            ],
          ),
        ),
      ),
    );
  }

  void _open(PatientNotification notification) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('（デモ）「${notification.title}」を開く遷移は未接続です。')),
    );
  }
}

class _NotificationCard extends StatelessWidget {
  const _NotificationCard({required this.notification, required this.onTap});

  final PatientNotification notification;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Flexible(
                    child: Text(notification.title, style: textTheme.titleMedium),
                  ),
                  Text(notification.receivedAgo),
                ],
              ),
              const SizedBox(height: 8),
              Text(notification.body),
            ],
          ),
        ),
      ),
    );
  }
}
