import 'package:flutter/material.dart';

/// デザインシステムの共通状態と共通コンポーネント（P-011 §1.2）。
///
/// 画面をまたいで同じ見た目・文言・操作にするための基盤。状態は色だけでなく
/// アイコン＋テキストでも表し（[S07]）、本文は 20sp 以上・タップ領域 48pt 以上で
/// OS の文字拡大に耐える前提。医療行為でない旨の共通文言もここで提供する。

/// 共通の画面状態。
enum PatientStatus { loading, empty, error, offline }

/// loading / empty / error / offline を共通の見た目で表示する。
///
/// error・offline では [onRetry] があれば「もう一度試す」を出す。色のみに意味を
/// 持たせず、アイコン・見出し・説明の3点で状態を伝える。
class PatientStateView extends StatelessWidget {
  const PatientStateView({
    super.key,
    required this.status,
    this.message,
    this.onRetry,
  });

  final PatientStatus status;

  /// 補足説明。null のときは状態ごとの既定文を使う。
  final String? message;

  /// error / offline のときの再試行。null なら出さない。
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final (icon, title, defaultBody) = switch (status) {
      PatientStatus.loading => (
          Icons.hourglass_empty,
          '読み込んでいます',
          'そのままお待ちください。',
        ),
      PatientStatus.empty => (
          Icons.inbox_outlined,
          'まだ何もありません',
          '表示できるものがありません。',
        ),
      PatientStatus.error => (
          Icons.error_outline,
          'うまくいきませんでした',
          'まだ送信できていません。もう一度試せます。',
        ),
      PatientStatus.offline => (
          Icons.cloud_off_outlined,
          'オフラインです',
          '通信が戻ると続きから進められます。入力は端末に保持されます。',
        ),
    };
    final body = message ?? defaultBody;
    return Semantics(
      container: true,
      liveRegion: true,
      label: '$title。$body',
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (status == PatientStatus.loading)
              const ExcludeSemantics(child: CircularProgressIndicator())
            else
              ExcludeSemantics(child: Icon(icon, size: 48)),
            const SizedBox(height: 16),
            ExcludeSemantics(
              child: Text(title, style: textTheme.titleLarge),
            ),
            const SizedBox(height: 8),
            ExcludeSemantics(
              child: Text(body, textAlign: TextAlign.center),
            ),
            if (onRetry != null &&
                (status == PatientStatus.error ||
                    status == PatientStatus.offline)) ...[
              const SizedBox(height: 16),
              PatientPrimaryButton(label: 'もう一度試す', onPressed: onRetry),
            ],
          ],
        ),
      ),
    );
  }
}

/// 大きめの主要ボタン。本文20sp・最小タップ領域48pt を既定にする。
class PatientPrimaryButton extends StatelessWidget {
  const PatientPrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
  });

  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: FilledButton(
        onPressed: onPressed,
        style: FilledButton.styleFrom(
          minimumSize: const Size(48, 48),
          textStyle: const TextStyle(fontSize: 20),
        ),
        child: Text(label),
      ),
    );
  }
}

/// 「医療行為ではない」旨の共通文言。P-001 以降も継続表示が必要な箇所で使う。
class NotMedicalNotice extends StatelessWidget {
  const NotMedicalNotice({super.key});

  @override
  Widget build(BuildContext context) {
    return const Text(
      'このサービスは、診断・治療・受診予約を行いません。医療行為ではありません。',
    );
  }
}
