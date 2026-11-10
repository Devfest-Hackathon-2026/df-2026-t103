import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:patient/patient_session_state.dart';

Map<String, dynamic> me(String uid) => {
  'uid': uid,
  'accountStatus': 'active',
  'onboardingState': 'completed',
  'emailVerified': true,
  'requiredConsents': {'current': true, 'missing': <String>[]},
  'profileComplete': true,
  'deletionRequest': {'status': 'none', 'canCancel': false},
};

void main() {
  test('clears a previous snapshot before refresh and on failure', () async {
    var fail = false;
    final state = PatientSessionState((uid) async {
      if (fail) throw StateError('sensitive detail');
      return me(uid);
    });
    await state.updateUser('a');
    expect(state.phase, PatientSessionPhase.ready);
    expect(state.snapshot, isNotNull);
    fail = true;
    final pending = state.updateUser('a');
    expect(state.phase, PatientSessionPhase.unresolved);
    expect(state.snapshot, isNull);
    await pending;
    expect(state.phase, PatientSessionPhase.unavailable);
    expect(state.snapshot, isNull);
    state.dispose();
  });

  test('discards a response after sign-out or a different session', () async {
    final first = Completer<Object?>();
    final state = PatientSessionState(
      (uid) => uid == 'a' ? first.future : Future.value(me(uid)),
    );
    final old = state.updateUser('a');
    await state.updateUser('b');
    expect(state.phase, PatientSessionPhase.ready);
    await state.updateUser(null);
    first.complete(me('a'));
    await old;
    expect(state.phase, PatientSessionPhase.signedOut);
    expect(state.snapshot, isNull);
    state.dispose();
  });

  test(
    'same UID in a newer session also invalidates the older response',
    () async {
      final first = Completer<Object?>();
      var calls = 0;
      final state = PatientSessionState((uid) {
        calls++;
        return calls == 1 ? first.future : Future.value(me(uid));
      });
      final old = state.updateUser('a');
      await state.updateUser('a');
      first.complete(me('wrong-user'));
      await old;
      expect(state.phase, PatientSessionPhase.ready);
      expect(state.snapshot, isNotNull);
      state.dispose();
    },
  );

  test(
    'mismatched UID and disposed sessions do not expose a snapshot',
    () async {
      final pending = Completer<Object?>();
      final state = PatientSessionState((_) => pending.future);
      final request = state.updateUser('a');
      pending.complete(me('b'));
      await request;
      expect(state.phase, PatientSessionPhase.unavailable);
      expect(state.snapshot, isNull);
      state.dispose();

      final lateResponse = Completer<Object?>();
      final disposed = PatientSessionState((_) => lateResponse.future);
      final old = disposed.updateUser('a');
      disposed.dispose();
      lateResponse.complete(me('a'));
      await old;
      expect(disposed.snapshot, isNull);
    },
  );
}
