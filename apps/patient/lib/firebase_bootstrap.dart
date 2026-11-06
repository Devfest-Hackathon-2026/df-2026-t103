import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_database/firebase_database.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter/foundation.dart';

/// This scaffold only supports the local demo project; production setup requires
/// an independently reviewed configuration and must not silently fall back.
class EmulatorConfig {
  const EmulatorConfig({
    required this.enabled,
    required this.projectId,
    required this.host,
  });

  final bool enabled;
  final String projectId;
  final String host;

  void validate() {
    if (!enabled || projectId != 'demo-mmr-dev' || host.trim().isEmpty) {
      throw StateError('Firebase requires the demo emulator configuration.');
    }
  }

  factory EmulatorConfig.fromEnvironment() {
    const override = String.fromEnvironment('FIREBASE_EMULATOR_HOST');
    return EmulatorConfig(
      enabled: const bool.fromEnvironment('USE_FIREBASE_EMULATOR'),
      projectId: const String.fromEnvironment('FIREBASE_PROJECT_ID'),
      host: override.isNotEmpty
          ? override
          : (!kIsWeb && defaultTargetPlatform == TargetPlatform.android)
          ? '10.0.2.2'
          : 'localhost',
    );
  }
}

Future<void> initializeDemoFirebase(EmulatorConfig config) async {
  config.validate();
  final platform = kIsWeb
      ? 'web'
      : defaultTargetPlatform == TargetPlatform.iOS
      ? 'ios'
      : 'android';
  await Firebase.initializeApp(
    options: FirebaseOptions(
      apiKey: 'demo-key',
      appId: '1:1234567890:$platform:abcdef1234567890',
      messagingSenderId: '1234567890',
      projectId: config.projectId,
      databaseURL: 'https://${config.projectId}-default-rtdb.firebaseio.com',
      storageBucket: '${config.projectId}.appspot.com',
    ),
  );
  await FirebaseAuth.instance.useAuthEmulator(config.host, 9099);
  FirebaseFirestore.instance.useFirestoreEmulator(config.host, 8081);
  FirebaseDatabase.instance.useDatabaseEmulator(config.host, 9000);
  await FirebaseStorage.instance.useStorageEmulator(config.host, 9199);
}
