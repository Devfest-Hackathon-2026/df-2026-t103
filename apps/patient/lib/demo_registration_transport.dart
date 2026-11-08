import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'email_auth_client.dart';
import 'firebase_bootstrap.dart' show allowsAndroidHostAlias;

/// Whether [baseUrl] may be used as the local demo API origin.
///
/// Every registration sends credentials to this origin, so only the explicit
/// local origins are accepted and matching is exact and case-sensitive:
/// scheme, port, path, query, fragment, userinfo and lookalike hosts fail
/// closed. `http://10.0.2.2:8080` is the Android emulator's alias for the
/// host machine and is only accepted when [androidHostAliasAllowed] is true,
/// which is the same rule as the Firebase host guard in
/// `firebase_bootstrap.dart`. The flag is supplied by the caller so the
/// platform rule stays injectable and testable without a device.
@visibleForTesting
bool allowsDemoApiOrigin(
  String baseUrl, {
  required bool androidHostAliasAllowed,
}) {
  const loopbackOrigins = {'http://localhost:8080', 'http://127.0.0.1:8080'};
  if (loopbackOrigins.contains(baseUrl)) return true;
  return androidHostAliasAllowed && baseUrl == 'http://10.0.2.2:8080';
}

/// Shared fail-closed origin validation for local API clients.
void requireDemoApiOrigin(String origin) {
  if (!allowsDemoApiOrigin(
    origin,
    androidHostAliasAllowed: allowsAndroidHostAlias,
  )) {
    throw ArgumentError('Only explicit local demo API origins are allowed');
  }
}

/// Local demo only. The caller owns and closes [client].
class DemoRegistrationTransport implements RegistrationTransport {
  DemoRegistrationTransport({
    required String baseUrl,
    required this.client,
    this.timeout = const Duration(seconds: 10),
  }) : _url = _registrationUrl(baseUrl) {
    if (timeout <= Duration.zero) throw ArgumentError('Invalid timeout');
  }

  final http.Client client;
  final Uri _url;
  final Duration timeout;
  static const int _maxResponseBytes = 64 * 1024;

  static Uri _registrationUrl(String baseUrl) {
    // The platform flag comes from the same getter the Firebase host guard
    // uses, so both guards accept 10.0.2.2 only on a non-web Android build.
    if (!allowsDemoApiOrigin(
      baseUrl,
      androidHostAliasAllowed: allowsAndroidHostAlias,
    )) {
      throw ArgumentError('Only explicit local demo API origins are allowed');
    }
    return Uri.parse('$baseUrl/v1/auth/register');
  }

  @override
  Future<int> postRegistration({
    required Map<String, String> headers,
    required Map<String, Object> body,
  }) async {
    // Do not allow callers to override routing or content headers.
    if (headers.keys.any(
      (key) => key != 'Idempotency-Key' && key != 'X-Firebase-AppCheck',
    )) {
      throw ArgumentError('Unsupported registration header');
    }
    final abort = Completer<void>();
    final request =
        http.AbortableRequest('POST', _url, abortTrigger: abort.future)
          ..followRedirects = false
          ..headers.addAll(headers)
          ..headers['content-type'] = 'application/json; charset=utf-8'
          ..body = jsonEncode(body);

    Future<int> send() async {
      final response = await client.send(request);
      if (response.statusCode < 100 ||
          response.statusCode > 599 ||
          (response.statusCode >= 300 && response.statusCode < 400) ||
          (response.contentLength != null &&
              response.contentLength! > _maxResponseBytes)) {
        throw const FormatException('Invalid registration response');
      }
      var size = 0;
      await for (final chunk in response.stream) {
        size += chunk.length;
        if (size > _maxResponseBytes) {
          throw const FormatException('Invalid registration response');
        }
      }
      return response.statusCode;
    }

    try {
      return await send().timeout(timeout);
    } catch (_) {
      // Network exceptions can contain request details; never expose them.
      throw StateError('Registration transport failed');
    } finally {
      abort.complete();
    }
  }
}
