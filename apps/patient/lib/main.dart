import 'package:flutter/material.dart';

import 'firebase_bootstrap.dart';
import 'firebase_intake_connection.dart';
import 'patient_flow.dart';
import 'patient_theme.dart';
import 'welcome_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final config = EmulatorConfig.fromEnvironment();
  await initializeDemoFirebase(config);
  runApp(PatientApp(connection: FirebaseIntakeConnection(config)));
}

/// アプリのルート Widget。
class PatientApp extends StatelessWidget {
  const PatientApp({super.key, this.connection});
  final FirebaseIntakeConnection? connection;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'もしもし問診 患者アプリ',
      theme: buildPatientTheme(),
      debugShowCheckedModeBanner: false,
      home: connection == null
          ? const WelcomeScreen()
          : PatientFlowScreen(connection: connection!),
    );
  }
}
