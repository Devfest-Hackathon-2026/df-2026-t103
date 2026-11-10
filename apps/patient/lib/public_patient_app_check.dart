import 'public_patient_api.dart';

/// Translate only attestation failures; Auth errors keep their own handling.
Future<String> patientAppCheckToken(Future<String?> Function() getToken) async {
  try {
    final token = await getToken();
    if (token != null && token.isNotEmpty) return token;
  } catch (_) {
    // SDK messages may contain request details and must not reach the UI.
  }
  throw const PatientRequestFailure('APP_CHECK_UNAVAILABLE');
}
