import 'package:flutter/material.dart';

/// サーバ同期や実ネットワークに接続しないオフライン・下書き・中断再開 UX の
/// プレビュー。
///
/// 通信状態の切り替えを模擬し、入力は端末内の下書きとして保持する。オフライン時の
/// 送信は再送キューに積み、接続回復時にまとめて送る想定を示す（E2E-002、NFR-03、
/// 問診中断 FR-I06）。実際の保存・送信・再送は未接続。
class OfflineDraftScreen extends StatefulWidget {
  const OfflineDraftScreen({super.key});

  @override
  State<OfflineDraftScreen> createState() => _OfflineDraftScreenState();
}

class _OfflineDraftScreenState extends State<OfflineDraftScreen> {
  final _draft = TextEditingController();
  bool _online = true;
  int _queued = 0;

  @override
  void dispose() {
    _draft.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('オフライン・下書きデモ')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('架空のデモです。実際の保存・送信は行いません。'),
              const SizedBox(height: 16),
              // 接続状態のバナー。
              Container(
                padding: const EdgeInsets.all(12),
                color: _online
                    ? Theme.of(context).colorScheme.secondaryContainer
                    : Theme.of(context).colorScheme.errorContainer,
                child: Text(
                  _online ? 'オンラインです。' : 'オフラインです（機内モードなど）。',
                  style: textTheme.titleMedium,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                _online
                    ? '入力はすぐに保存・送信できます。'
                    : '入力は端末に下書きとして保存され、接続が戻ると続きから再開できます。失われません。',
              ),
              SwitchListTile(
                title: const Text('通信を使えるようにする'),
                subtitle: const Text('オフにすると機内モードを模擬します。'),
                value: _online,
                onChanged: (value) => _setOnline(value),
              ),
              const SizedBox(height: 8),
              Text('回答の下書き', style: textTheme.titleMedium),
              const SizedBox(height: 8),
              TextField(
                controller: _draft,
                minLines: 3,
                maxLines: 6,
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(
                  labelText: '回答（架空の内容のみ）',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                _draft.text.trim().isEmpty
                    ? '下書きはまだありません。'
                    : '下書きを端末に保存しました。',
              ),
              const SizedBox(height: 16),
              if (_queued > 0) Text('送信待ち: $_queued件'),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _draft.text.trim().isEmpty ? null : _send,
                  style: FilledButton.styleFrom(
                    minimumSize: const Size(48, 48),
                    textStyle: const TextStyle(fontSize: 20),
                  ),
                  child: const Text('回答を送信する'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _setOnline(bool value) {
    setState(() => _online = value);
    if (value && _queued > 0) {
      final flushed = _queued;
      setState(() => _queued = 0);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('接続が戻ったので、送信待ちの$flushed件を送信しました（デモ）。')),
      );
    }
  }

  void _send() {
    if (_online) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('送信しました（デモ）。')),
      );
    } else {
      setState(() => _queued++);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('オフラインのため、送信待ちに入れました（デモ）。')),
      );
    }
  }
}
