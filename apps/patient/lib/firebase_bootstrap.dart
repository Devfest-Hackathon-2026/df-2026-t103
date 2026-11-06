import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_database/firebase_database.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter/foundation.dart';

/// Whether `10.0.2.2` is a usable alias for the host machine in this build.
///
/// The alias only exists inside the Android emulator, so it is meaningless on
/// the web build and on every other platform.
bool get allowsAndroidHostAlias =>
    !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

/// Whether [host] may be used for the local demo emulator connection.
///
/// Every emulator connection sends credentials to this host, so only loopback
/// hosts are accepted. `10.0.2.2` is the Android emulator's alias for the host
/// machine and is only accepted when [androidHostAliasAllowed] is true.
/// Matching is exact and case-sensitive so that URLs, ports, IPv6 literals,
/// whitespace and lookalike values such as `localhost.evil.example` fail
/// closed. This is the single host guard and runs before Firebase is touched.
@visibleForTesting
bool isDemoEmulatorHost(
  String host, {
  required bool androidHostAliasAllowed,
}) {
  const loopbackHosts = {'localhost', '127.0.0.1'};
  if (loopbackHosts.contains(host)) return true;
  return androidHostAliasAllowed && host == '10.0.2.2';
}

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

  /// Throws unless this configuration selects the local demo emulator.
  ///
  /// [initializeDemoFirebase] calls this before `Firebase.initializeApp`, so
  /// an unusable host is rejected before any Firebase connection exists.
  /// [androidHostAliasAllowed] is supplied by the caller so the platform rule
  /// stays injectable and testable without touching the device.
  void validate({required bool androidHostAliasAllowed}) {
    if (!enabled || projectId != 'demo-mmr-dev') {
      throw StateError('Firebase requires the demo emulator configuration.');
    }
    if (!isDemoEmulatorHost(
      host,
      androidHostAliasAllowed: androidHostAliasAllowed,
    )) {
      throw StateError(
        'Firebase demo emulator host must be localhost, 127.0.0.1, '
        'or 10.0.2.2 on Android.',
      );
    }
  }

  factory EmulatorConfig.fromEnvironment() {
    const override = String.fromEnvironment('FIREBASE_EMULATOR_HOST');
    return EmulatorConfig(
      enabled: const bool.fromEnvironment('USE_FIREBASE_EMULATOR'),
      projectId: const String.fromEnvironment('FIREBASE_PROJECT_ID'),
      host: override.isNotEmpty
          ? override
          : allowsAndroidHostAlias
          ? '10.0.2.2'
          : 'localhost',
    );
  }
}

Future<void> initializeDemoFirebase(EmulatorConfig config) async {
  config.validate(androidHostAliasAllowed: allowsAndroidHostAlias);
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
