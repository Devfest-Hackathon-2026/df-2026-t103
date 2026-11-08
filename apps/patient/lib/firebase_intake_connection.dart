import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;

import 'firebase_bootstrap.dart';
import 'patient_intake_api.dart';

/// The app's existing, explicitly configured Auth Emulator is the only sign-in
/// authority for this first local slice. Never use a mock or a production token.
class FirebaseIntakeConnection {
  FirebaseIntakeConnection(EmulatorConfig config) {
    config.validate(androidHostAliasAllowed: allowsAndroidHostAlias);
    if (_auth.app.options.projectId != config.projectId) {
      throw StateError('Auth project mismatch');
    }
    _subscription = _auth.authStateChanges().listen((_) {
      _epoch = Object();
      _changes.add(null);
    });
    const configuredOrigin = String.fromEnvironment('API_BASE_URL');
    final origin = configuredOrigin.isEmpty
        ? 'http://${config.host}:8080'
        : configuredOrigin;
    if (Uri.parse(origin).host != config.host) {
      throw StateError('API and Auth emulator hosts must match');
    }
    api = PatientIntakeApi(
      origin: origin,
      client: _http,
      identity: () async {
        final user = _auth.currentUser;
        final epoch = _epoch;
        if (user == null) throw const IntakeApiException('SIGNED_OUT');
        final token = await user.getIdToken();
        if (token == null || token.isEmpty) {
          throw const IntakeApiException('SIGNED_OUT');
        }
        return IntakeIdentity(user.uid, epoch, token);
      },
      isCurrent: (identity) =>
          _auth.currentUser?.uid == identity.uid &&
          identical(_epoch, identity.epoch),
    );
  }
  final _auth = FirebaseAuth.instance;
  final _http = http.Client();
  final _changes = StreamController<void>.broadcast(sync: true);
  late final StreamSubscription<User?> _subscription;
  Object _epoch = Object();
  late final PatientIntakeApi api;
  Stream<void> get changes => _changes.stream;

  Future<void> signIn(String email, String password) async {
    await _auth.signInWithEmailAndPassword(email: email, password: password);
  }

  Future<void> signOut() => _auth.signOut();

  Future<void> dispose() async {
    await _subscription.cancel();
    await _changes.close();
    _http.close();
  }
}
