import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/main.dart' as local_entrypoint;
import 'package:patient/main_public.dart' as public_entrypoint;
import 'package:patient/public_patient_config.dart';
import 'package:patient/public_patient_screen.dart';

void main() {
  test('public configuration validation rejects missing settings on iOS', () {
    const config = PublicPatientConfig(
      projectId: '',
      apiOrigin: '',
      apiKey: '',
      appId: '',
    );

    expect(
      () => config.validate(platform: PublicPatientPlatform.ios),
      throwsStateError,
    );
  });

  testWidgets(
    'missing public configuration shows fail-closed UI on iOS',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      try {
        expect(defaultTargetPlatform, TargetPlatform.iOS);
        await public_entrypoint.main();
        await tester.pumpAndSettle();

        expect(
          find.text('起動に必要な接続を確認できません。時間をおいて、開き直してください。'),
          findsOneWidget,
        );
        expect(find.byType(PublicPatientScreen), findsNothing);
        expect(find.byType(local_entrypoint.PatientApp), findsNothing);
        expect(find.text('もしもし問診へようこそ'), findsNothing);
        expect(Firebase.apps, isEmpty);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    },
  );
}
