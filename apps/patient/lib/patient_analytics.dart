import 'dart:async';

import 'package:firebase_analytics/firebase_analytics.dart';
import 'package:flutter/foundation.dart';

/// Only names from the product's operational-event allowlist can be submitted.
/// There is deliberately no API for parameters, errors, URLs or user identity.
enum PatientAnalyticsEvent {
  intakeCompleted('intake_completed'),
  deliveryFailed('delivery_failed');

  const PatientAnalyticsEvent(this.name);
  final String name;
}

class PatientAnalytics {
  const PatientAnalytics.disabled() : _send = null;

  /// Injection point for transport contract tests; production uses [initialize].
  const PatientAnalytics({required Future<void> Function(String) send})
    : this._(send);

  const PatientAnalytics._(this._send);

  final Future<void> Function(String)? _send;

  static Future<PatientAnalytics> initialize() async {
    // Web has separate SDK/CSP/stream requirements. Do not initialize it here.
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.iOS) {
      return const PatientAnalytics.disabled();
    }
    try {
      final sdk = FirebaseAnalytics.instance;
      // Also clear any runtime-enabled collection persisted by a prior build.
      await sdk
          .setAnalyticsCollectionEnabled(false)
          .timeout(const Duration(seconds: 2));
      // Native Info.plist permanently deactivates collection for this release.
      // Enabling delivery needs a separate native-config change and acceptance;
      // no build flag or patient action can override that guard.
      return PatientAnalytics(send: (name) => sdk.logEvent(name: name));
    } catch (_) {
      // Monitoring is optional and must not block the patient workflow.
      return const PatientAnalytics.disabled();
    }
  }

  void record(PatientAnalyticsEvent event) {
    final send = _send;
    if (send == null) return;
    // No retries, disk queue or exception logging in the application boundary.
    // Both synchronous throws and rejected futures stay out of the patient flow.
    unawaited(
      Future<void>.sync(() => send(event.name)).catchError((Object _) {}),
    );
  }
}
