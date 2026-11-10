import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'demo_registration_transport.dart';
import 'patient_intake_api.dart' show IntakeIdentity;

enum DeletionFailure {
  // The token is no longer fresh; a re-authentication is required before this
  // sensitive operation (API-006/007 requireFreshAuth → 403). Pair with
  // SensitiveActionGate so the user re-authenticates and retries.
  reauthRequired,
  // Firebase/API throttled or temporarily locked the attempt (429).
  rateLimited,
  // The request conflicts with current state, e.g. deletion already pending (409).
  conflict,
  // Nothing to cancel (404).
  notFound,
  invalidResponse,
  // The auth session changed while the request was in flight.
  sessionChanged,
  unavailable,
}

class DeletionException implements Exception {
  const DeletionException(this.reason);
  final DeletionFailure reason;
}

/// Account deletion request state (docs/03 P-040/P-041, FR-A11).
class DeletionStatus {
  const DeletionStatus({required this.status, required this.canCancel});
  final String status;
  final bool canCancel;
}

/// Client for the account deletion lifecycle: request (30-day hold), cancel
/// within the window, and read status. Mutating calls require a fresh
/// re-authentication server-side; this client surfaces that as [reauthRequired]
/// so the UI can re-authenticate (e.g. via SensitiveActionGate) and retry with
/// the same idempotency key. No credentials, bodies, or responses are logged.
class PatientDeletionClient {
  PatientDeletionClient({
    required this.origin,
    required this.client,
    required this.identity,
    required this.isCurrent,
  }) {
    requireDemoApiOrigin(origin);
  }
  final String origin;
  final http.Client client;
  final Future<IntakeIdentity> Function() identity;
  final bool Function(IntakeIdentity) isCurrent;

  void _check(IntakeIdentity owner) {
    if (!isCurrent(owner)) throw const DeletionException(DeletionFailure.sessionChanged);
  }

  Future<DeletionStatus> requestDeletion(String idempotencyKey) =>
      _mutate('/v1/me/deletion-request', idempotencyKey, 202);

  Future<DeletionStatus> cancelDeletion(String idempotencyKey) =>
      _mutate('/v1/me/deletion-request/cancel', idempotencyKey, 200);

  Future<DeletionStatus> status() async {
    final owner = await identity();
    return _parse(await _request(owner, 'GET', '/v1/me/deletion-request'));
  }

  Future<DeletionStatus> _mutate(String path, String key, int expected) async {
    if (key.isEmpty || key.length > 200 || RegExp(r'\s').hasMatch(key)) {
      throw const DeletionException(DeletionFailure.invalidResponse);
    }
    final owner = await identity();
    return _parse(
      await _request(owner, 'POST', path, key: key, expectedStatus: expected),
    );
  }

  DeletionStatus _parse(Map<String, dynamic> body) {
    final status = body['status'];
    final canCancel = body['canCancel'];
    if (status is! String || canCancel is! bool) {
      throw const DeletionException(DeletionFailure.invalidResponse);
    }
    return DeletionStatus(status: status, canCancel: canCancel);
  }

  Future<Map<String, dynamic>> _request(
    IntakeIdentity owner,
    String method,
    String path, {
    String? key,
    int expectedStatus = 200,
  }) async {
    _check(owner);
    final abort = Completer<void>();
    final request =
        http.AbortableRequest(method, Uri.parse('$origin$path'), abortTrigger: abort.future)
          ..followRedirects = false
          ..headers['Authorization'] = 'Bearer ${owner.token}';
    if (key != null) request.headers['Idempotency-Key'] = key;
    try {
      Future<Map<String, dynamic>> send() async {
        final response = await client.send(request);
        if (response.statusCode != expectedStatus) {
          // Do not expose server bodies (which may contain private detail).
          throw DeletionException(_classify(response.statusCode));
        }
        final bytes = <int>[];
        await for (final chunk in response.stream) {
          bytes.addAll(chunk);
          if (bytes.length > 256 * 1024) {
            throw const DeletionException(DeletionFailure.invalidResponse);
          }
        }
        _check(owner);
        final Object? decoded;
        try {
          decoded = jsonDecode(utf8.decode(bytes));
        } catch (_) {
          throw const DeletionException(DeletionFailure.invalidResponse);
        }
        if (decoded is! Map<String, dynamic>) {
          throw const DeletionException(DeletionFailure.invalidResponse);
        }
        return decoded;
      }

      return await send().timeout(const Duration(seconds: 15));
    } on DeletionException {
      rethrow;
    } catch (_) {
      throw const DeletionException(DeletionFailure.unavailable);
    } finally {
      abort.complete();
    }
  }

  DeletionFailure _classify(int statusCode) {
    switch (statusCode) {
      case 403:
        return DeletionFailure.reauthRequired;
      case 429:
        return DeletionFailure.rateLimited;
      case 409:
        return DeletionFailure.conflict;
      case 404:
        return DeletionFailure.notFound;
      default:
        return DeletionFailure.unavailable;
    }
  }
}
