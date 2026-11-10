import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'public_patient_config.dart';
import 'public_patient_api.dart';
import 'public_patient_app_check.dart';
import 'patient_analytics.dart';

class PublicPatientConnection {
  PublicPatientConnection._(this.config);
  final PublicPatientConfig config;
  final _client = http.Client();
  final _changes = StreamController<void>.broadcast(sync: true);
  Object _epoch = Object();
  String? _uid;
  late final StreamSubscription<User?> _subscription;
  late final PublicPatientApi api;
  Stream<void> get changes => _changes.stream;
  static Future<PublicPatientConnection> initialize(
    PublicPatientConfig config,
  ) async {
    if (!kIsWeb && defaultTargetPlatform != TargetPlatform.iOS) {
      throw StateError('The public entrypoint supports Web and iOS.');
    }
    config.validate(
      platform: kIsWeb ? PublicPatientPlatform.web : PublicPatientPlatform.ios,
    );
    await Firebase.initializeApp(
      options: FirebaseOptions(
        apiKey: config.apiKey,
        appId: config.appId,
        messagingSenderId: '842827776169',
        projectId: config.projectId,
        authDomain: config.authDomain,
        iosBundleId: kIsWeb ? null : 'com.moshimoshimonshin.patient',
      ),
    );
    final analytics = await PatientAnalytics.initialize();
    if (kIsWeb) {
      await FirebaseAuth.instance.setPersistence(Persistence.NONE);
    } else {
      // Native Auth persists in the Keychain. Start each process signed out;
      // never silently reopen a previous patient's session on a shared phone.
      await FirebaseAuth.instance.signOut();
    }
    await FirebaseAuth.instance.setLanguageCode('ja');
    await FirebaseAppCheck.instance.activate(
      providerWeb: kIsWeb ? ReCaptchaEnterpriseProvider(config.siteKey) : null,
      providerApple: const AppleAppAttestProvider(),
    );
    final connection = PublicPatientConnection._(config);
    connection._subscription = FirebaseAuth.instance.authStateChanges().listen(
      connection._syncIdentity,
    );
    connection.api = PublicPatientApi(
      origin: config.apiOrigin,
      client: connection._client,
      session: () => connection._epoch,
      analytics: analytics,
      tokens: () async {
        final user = FirebaseAuth.instance.currentUser;
        connection._syncIdentity(user);
        final auth = await user?.getIdToken();
        final check = await patientAppCheckToken(
          () => FirebaseAppCheck.instance.getToken(),
        );
        return (auth: auth, appCheck: check);
      },
    );
    return connection;
  }

  void _syncIdentity(User? user) {
    if (_uid == user?.uid) return;
    _uid = user?.uid;
    _epoch = Object();
    _changes.add(null);
  }

  Future<void> signIn(String email, String password) async {
    final credential = await FirebaseAuth.instance.signInWithEmailAndPassword(
      email: email,
      password: password,
    );
    // Establish the session before the caller loads /me, even when the SDK's
    // auth stream emits later. Duplicate events for this UID do not clear UI.
    _syncIdentity(credential.user);
  }

  Future<bool> refreshEmailVerification() async {
    await FirebaseAuth.instance.currentUser?.reload();
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) throw const PatientRequestFailure('401');
    await user.getIdToken(true);
    return user.emailVerified;
  }

  Future<void> sendEmailVerification() async {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) throw const PatientRequestFailure('401');
    await user.sendEmailVerification();
  }

  Future<void> signOut() async {
    await FirebaseAuth.instance.signOut();
    _syncIdentity(null);
  }

  Future<void> resetPassword(String email) =>
      FirebaseAuth.instance.sendPasswordResetEmail(email: email);
  Future<void> dispose() async {
    await _subscription.cancel();
    await _changes.close();
    _client.close();
  }
}
