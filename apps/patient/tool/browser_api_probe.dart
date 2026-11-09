import 'dart:js_interop';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'package:patient/patient_analytics.dart';
import 'package:patient/public_patient_api.dart';

@JS('window.__browserApiProbeResult')
external set _browserApiProbeResult(JSString value);
@JS('window.__browserApiProbeAuthToken')
external set _browserApiProbeAuthToken(JSString value);

const projectId = String.fromEnvironment('FIREBASE_PROJECT_ID');
const authHost = String.fromEnvironment('FIREBASE_EMULATOR_HOST');
const authPort = int.fromEnvironment('AUTH_EMULATOR_PORT');
const apiOrigin = String.fromEnvironment('API_BASE_URL');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MaterialApp(home: ProbePage()));
}

class ProbePage extends StatefulWidget {
  const ProbePage({super.key});
  @override
  State<ProbePage> createState() => _ProbePageState();
}

class _ProbePageState extends State<ProbePage> {
  String result = 'PROBE_RUNNING';

  @override
  void initState() {
    super.initState();
    _run();
  }

  Future<void> _run() async {
    var phase = 'configuration';
    try {
      if (projectId != 'demo-mmr-dev' ||
          !apiOrigin.startsWith('http://127.0.0.1:')) {
        throw StateError('Unsafe test configuration');
      }
      phase = 'firebase-initialize';
      await Firebase.initializeApp(
        options: const FirebaseOptions(
          apiKey: 'demo-key',
          appId: '1:842827776169:web:synthetic',
          messagingSenderId: '842827776169',
          projectId: projectId,
        ),
      );
      phase = 'auth-emulator';
      await FirebaseAuth.instance.useAuthEmulator(authHost, authPort);
      phase = 'auth-sign-in';
      final identity = await FirebaseAuth.instance.createUserWithEmailAndPassword(
        email:
            'browser-api-${DateTime.now().microsecondsSinceEpoch}@example.test',
        password: 'local-only-Browser-123!',
      );
      phase = 'authenticated-api-request';
      final authToken = (await identity.user!.getIdToken())!;
      _browserApiProbeAuthToken = authToken.toJS;
      final owner = Object();
      final api = PublicPatientApi(
        origin: apiOrigin,
        client: httpClient(),
        session: () => owner,
        analytics: const PatientAnalytics.disabled(),
        tokens: () async => (
          auth: authToken,
          // The local API is intentionally APP_CHECK_MODE=permissive. App Check
          // minting/verification is not under test; authorization is real.
          appCheck: 'synthetic-permissive-emulator-token',
        ),
      );
      final response = await api.request('GET', '/me/facility-memberships');
      if (response['items'] is! List) {
        throw StateError('Unexpected authenticated API response');
      }
      await FirebaseAuth.instance.signOut();
      api.client.close();
      _browserApiProbeResult = 'API_RESULT:${response['items'].length}'.toJS;
      if (mounted) {
        setState(() => result = 'API_RESULT:${response['items'].length}');
      }
    } catch (error) {
      final safeCode = switch (error) {
        PatientRequestFailure(:final code, :final apiCode) =>
          ' api:$code${apiCode == null ? '' : '/$apiCode'}',
        FirebaseAuthException(:final code) => ' auth:$code',
        _ => ' ${error.runtimeType}',
      };
      final failure = 'PROBE_FAILED:$phase$safeCode';
      _browserApiProbeResult = failure.toJS;
      if (mounted) setState(() => result = failure);
    }
  }

  @override
  Widget build(BuildContext context) =>
      Scaffold(body: Center(child: Text(result)));
}

http.Client httpClient() => http.Client();
