import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'patient_analytics.dart';

String patientOperationKey() => List.generate(
  24,
  (_) => Random.secure().nextInt(256),
).map((n) => n.toRadixString(16).padLeft(2, '0')).join();

class PatientRequestFailure implements Exception {
  const PatientRequestFailure(
    this.code, {
    this.apiCode,
    this.retryable = false,
  });
  final String code;
  final String? apiCode;
  final bool retryable;
  String get message => switch (code) {
    'LEGAL_UNAVAILABLE' => '利用文書を確認できません。運営者による文書の準備が必要です。',
    '500' || '503' => 'サービスの準備状況を確認できません。時間をおいて再試行してください。',
    '401' => 'ログインの有効期限が切れました。ログインし直してください。',
    'SIGN_IN_AFTER_REGISTER' => '登録は完了しました。入力したメールアドレスとパスワードでログインしてください。',
    '403' => 'この操作を行う権限がありません。利用状態を確認してください。',
    '409' => '保存状態が更新されています。「保存状態を再確認」で最新状態を取得してください。',
    '412' => '現在の利用状態では操作できません。同意・問診・施設の状態を再確認してください。',
    '429' => '操作が集中しています。少し時間をおいて再試行してください。',
    '400' => '入力内容を確認してください。',
    'ANSWER_KEY_EXPIRED' => '回答の再送可能期間が終了しました。問診を続けず、サポートへお問い合わせください。',
    'ANSWER_EDIT_NOT_CONFIRMED' =>
      '保存操作の成否は確認できませんでした。現在の保存内容を確認し、入力を保ったまま再編集してください。',
    'ANSWER_EDIT_REJECTED' =>
      '保存操作は競合により拒否されました。現在の保存内容を確認し、入力を保ったまま再編集してください。',
    'ANSWER_EDIT_QUESTION_CHANGED' =>
      '質問または選択肢が更新されたため、古い内容は保存していません。最新の質問を確認して再編集してください。',
    _ => '通信結果を確認できません。入力を保持していますので、再試行してください。',
  };
}

/// No patient content is logged or written to browser storage. Requests carry
/// real Auth and App Check tokens; both are refreshed for each operation.
class PublicPatientApi {
  PublicPatientApi({
    required this.origin,
    required this.client,
    required this.tokens,
    required this.session,
    this.analytics = const PatientAnalytics.disabled(),
    DateTime Function()? clock,
  }) : now = clock ?? DateTime.now;
  final String origin;
  final http.Client client;
  final Future<({String? auth, String appCheck})> Function() tokens;
  final Object Function() session;
  final PatientAnalytics analytics;
  final DateTime Function() now;

  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, Object?>? body,
    String? key,
    bool authenticated = true,
  }) async {
    if (!RegExp(r'^/[A-Za-z0-9_/-]+$').hasMatch(path)) {
      throw const PatientRequestFailure('INVALID_PATH');
    }
    final owner = session();
    final credential = await tokens();
    if (authenticated && credential.auth == null) {
      throw const PatientRequestFailure('401');
    }
    if (!identical(owner, session())) throw const PatientRequestFailure('401');
    final abort = Completer<void>();
    final req =
        http.AbortableRequest(
            method,
            Uri.parse('$origin/v1$path'),
            abortTrigger: abort.future,
          )
          ..followRedirects = false
          ..headers.addAll({
            if (credential.auth != null)
              'Authorization': 'Bearer ${credential.auth}',
            'X-Firebase-AppCheck': credential.appCheck,
          });
    if (key != null) req.headers['Idempotency-Key'] = key;
    if (body != null) {
      req.headers['Content-Type'] = 'application/json';
      req.body = jsonEncode(body);
    }
    try {
      Future<Map<String, dynamic>> send() async {
        final response = await client.send(req);
        final bytes = <int>[];
        await for (final chunk in response.stream) {
          bytes.addAll(chunk);
          if (bytes.length > 512 * 1024) {
            throw const PatientRequestFailure('INVALID_RESPONSE');
          }
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          String? apiCode;
          var retryable = false;
          try {
            final errorBody = jsonDecode(utf8.decode(bytes));
            final error = errorBody is Map ? errorBody['error'] : null;
            if (error is Map) {
              apiCode = error['code'] is String
                  ? error['code'] as String
                  : null;
              retryable = error['retryable'] == true;
            }
          } catch (_) {
            // Keep status-only error handling for nonstandard error bodies.
          }
          throw PatientRequestFailure(
            '${response.statusCode}',
            apiCode: apiCode,
            retryable: retryable,
          );
        }
        if (!identical(owner, session())) {
          throw const PatientRequestFailure('401');
        }
        final value = jsonDecode(utf8.decode(bytes));
        if (value is! Map<String, dynamic>) {
          throw const PatientRequestFailure('INVALID_RESPONSE');
        }
        return value;
      }

      final result = await send().timeout(const Duration(seconds: 25));
      if (method == 'POST' &&
          RegExp(r'^/intakes/[^/]+/finalize$').hasMatch(path)) {
        analytics.record(PatientAnalyticsEvent.intakeCompleted);
      }
      return result;
    } on PatientRequestFailure {
      if (method == 'POST' && path == '/deliveries') {
        analytics.record(PatientAnalyticsEvent.deliveryFailed);
      }
      rethrow;
    } catch (_) {
      if (method == 'POST' && path == '/deliveries') {
        analytics.record(PatientAnalyticsEvent.deliveryFailed);
      }
      throw const PatientRequestFailure('UNAVAILABLE');
    } finally {
      abort.complete();
    }
  }
}
