import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_account_preview.dart';
import 'package:patient/demo_ai_question_preview.dart';
import 'package:patient/demo_hospital_detail_preview.dart';
import 'package:patient/demo_hospital_search_preview.dart';
import 'package:patient/demo_medication_list_preview.dart';
import 'package:patient/demo_notifications_preview.dart';
import 'package:patient/demo_ocr_candidate_preview.dart';
import 'package:patient/demo_offline_draft_preview.dart';
import 'package:patient/demo_prescription_capture_preview.dart';
import 'package:patient/demo_profile_form_preview.dart';
import 'package:patient/demo_review_preview.dart';
import 'package:patient/demo_send_confirm_preview.dart';
import 'package:patient/demo_withdrawal_preview.dart';

/// 患者アプリ各プレビュー画面のアクセシビリティ受入（#77）。
///
/// NFR-01（本文20sp・OS 文字拡大）、NFR-02（読み上げラベル）、NFR-03（操作可能な
/// タップ領域）を自動検証する。flutter_test の a11y ガイドライン matcher を使い、
/// 端末や手動操作なしで CI で回帰確認できるようにする。
void main() {
  final screens = <String, Widget Function()>{
    'medication_list': () => const MedicationListPreview(),
    'ocr_candidate': () => const OcrCandidatePreview(),
    'hospital_search': () => const HospitalSearchPreview(),
    'hospital_detail': () => const HospitalDetailPreview(),
    'send_confirm': () => const SendConfirmPreview(),
    'ai_question': () => const AiQuestionPreview(),
    'review': () => const ReviewPreview(),
    'prescription_capture': () => const PrescriptionCapturePreview(),
    'withdrawal': () => const WithdrawalPreview(),
    'account': () => const AccountPreview(),
    'profile_form': () => const ProfileFormPreview(),
    'notifications': () => const NotificationsPreview(),
    'offline_draft': () => const OfflineDraftPreview(),
  };

  group('タップ領域・ラベルのガイドラインを満たす', () {
    screens.forEach((name, build) {
      testWidgets(name, (tester) async {
        final handle = tester.ensureSemantics();
        await tester.pumpWidget(build());
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
        handle.dispose();
      });
    });
  });

  group('OS 文字拡大200%・狭画面でも例外なく描画できる', () {
    screens.forEach((name, build) {
      testWidgets(name, (tester) async {
        tester.view.physicalSize = const Size(320, 640);
        tester.view.devicePixelRatio = 1;
        tester.platformDispatcher.textScaleFactorTestValue = 2;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        await tester.pumpWidget(build());
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      });
    });
  });
}
