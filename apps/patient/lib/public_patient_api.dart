import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

String patientOperationKey() => List.generate(
  24,
  (_) => Random.secure().nextInt(256),
).map((n) => n.toRadixString(16).padLeft(2, '0')).join();

class PatientRequestFailure implements Exception {
  const PatientRequestFailure(this.code);
  final String code;
  String get message => switch (code) {
    'LEGAL_UNAVAILABLE' => '利用文書を確認できません。運営者による文書の準備が必要です。',
    '500' || '503' => 'サービスの準備状況を確認できません。時間をおいて再試行してください。',
    '401' => 'ログインの有効期限が切れました。ログインし直してください。',
    '403' => 'この操作を行う権限がありません。利用状態を確認してください。',
    '409' => '保存状態が更新されています。「保存状態を再確認」で最新状態を取得してください。',
    '412' => '現在の利用状態では操作できません。同意・問診・施設の状態を再確認してください。',
    '429' => '操作が集中しています。少し時間をおいて再試行してください。',
    '400' => '入力内容を確認してください。',
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
  });
  final String origin;
  final http.Client client;
  final Future<({String auth, String appCheck})> Function() tokens;
  final Object Function() session;

  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, Object?>? body,
    String? key,
  }) async {
    if (!RegExp(r'^/[A-Za-z0-9_/-]+$').hasMatch(path)) {
      throw const PatientRequestFailure('INVALID_PATH');
    }
    final owner = session();
    final credential = await tokens();
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
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw PatientRequestFailure('${response.statusCode}');
        }
        final bytes = <int>[];
        await for (final chunk in response.stream) {
          bytes.addAll(chunk);
          if (bytes.length > 512 * 1024) {
            throw const PatientRequestFailure('INVALID_RESPONSE');
          }
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

      return await send().timeout(const Duration(seconds: 25));
    } on PatientRequestFailure {
      rethrow;
    } catch (_) {
      throw const PatientRequestFailure('UNAVAILABLE');
    } finally {
      abort.complete();
    }
  }
}
