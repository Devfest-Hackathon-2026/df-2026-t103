import 'package:flutter/material.dart';

import 'patient_theme.dart';
import 'public_patient_config.dart';
import 'public_patient_connection.dart';
import 'public_patient_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    final config = PublicPatientConfig.fromEnvironment();
    final connection = await PublicPatientConnection.initialize(config);
    runApp(
      MaterialApp(
        title: 'もしもし問診',
        theme: buildPatientTheme(),
        home: PublicPatientScreen(
          api: connection.api,
          signIn: connection.signIn,
          signOut: connection.signOut,
          resetPassword: connection.resetPassword,
          changes: connection.changes,
          initialFacilityId: config.facilityId,
        ),
      ),
    );
  } catch (_) {
    runApp(
      MaterialApp(
        theme: buildPatientTheme(),
        home: const Scaffold(
          body: SafeArea(
            child: Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text('起動に必要な接続を確認できません。時間をおいて、開き直してください。'),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
