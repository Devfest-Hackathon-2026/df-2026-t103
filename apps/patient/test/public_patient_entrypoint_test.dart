import 'package:firebase_core/firebase_core.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/main.dart' as local_entrypoint;
import 'package:patient/main_public.dart' as public_entrypoint;
import 'package:patient/public_patient_screen.dart';

void main() {
  testWidgets(
    'missing public configuration fails closed before Firebase initialization',
    (tester) async {
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
    },
  );
}
