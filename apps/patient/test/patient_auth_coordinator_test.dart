import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:patient/patient_auth_coordinator.dart';

Map<String, dynamic> me({String uid = 'user-a', bool consent = true}) => {
  'uid': uid,
  'accountStatus': 'active',
  'onboardingState': consent ? 'completed' : 'legal_pending',
  'emailVerified': true,
  'profileComplete': true,
  'requiredConsents': {
    'current': consent,
    'missing': consent ? <String>[] : ['terms_of_service'],
  },
  'deletionRequest': {'status': 'none', 'canCancel': false},
};

class FakeDependencies {
  final events = <String>[];
  RegistrationOutcome registration = RegistrationOutcome.created;
  AuthSessionIdentity? session = const AuthSessionIdentity('user-a', 1);
  AuthSessionIdentity signInIdentity = const AuthSessionIdentity('user-a', 1);
  Object? response = me();
  bool failRegistration = false;
  bool failSignIn = false;
  bool failMe = false;
  Completer<RegistrationOutcome>? pendingRegistration;
  Completer<Object?>? pendingMe;

  PatientAuthCoordinator coordinator() => PatientAuthCoordinator(
    register: () async {
      events.add('register');
      if (failRegistration) throw StateError('secret-password');
      return pendingRegistration == null
          ? registration
          : await pendingRegistration!.future;
    },
    signIn: () async {
      events.add('signIn');
      if (failSignIn) throw StateError('secret-password');
      return signInIdentity;
    },
    currentSession: () => session,
    loadMe: (uid) async {
      events.add('me:$uid');
      if (failMe) throw StateError('secret-password');
      return pendingMe == null ? response : await pendingMe!.future;
    },
  );
}

void main() {
  test('registers, signs in, then verifies /me before ready', () async {
    final fake = FakeDependencies();
    final coordinator = fake.coordinator();
    expect(await coordinator.run(), PatientAuthOutcome.ready);
    expect(fake.events, ['register', 'signIn', 'me:user-a']);
    expect(coordinator.snapshot?.requiredConsentsCurrent, true);
  });

  test('unknown registration never retries or signs in', () async {
    final fake = FakeDependencies()..failRegistration = true;
    final coordinator = fake.coordinator();
    expect(await coordinator.run(), PatientAuthOutcome.registrationUnknown);
    fake.failRegistration = false;
    expect(await coordinator.run(), PatientAuthOutcome.registrationUnknown);
    expect(fake.events, ['register']);
  });

  test('definitive rejection stops before sign-in', () async {
    final fake = FakeDependencies()
      ..registration = RegistrationOutcome.rejected;
    final coordinator = fake.coordinator();
    expect(await coordinator.run(), PatientAuthOutcome.registrationRejected);
    expect(fake.events, ['register']);
  });

  test('sign-in retry after creation never repeats registration', () async {
    final fake = FakeDependencies()..failSignIn = true;
    final coordinator = fake.coordinator();
    expect(await coordinator.run(), PatientAuthOutcome.signInFailed);
    fake.failSignIn = false;
    expect(await coordinator.run(), PatientAuthOutcome.ready);
    expect(fake.events, ['register', 'signIn', 'signIn', 'me:user-a']);
  });

  test('consent and access status are evaluated from /me', () async {
    final fake = FakeDependencies()..response = me(consent: false);
    final coordinator = fake.coordinator();
    expect(await coordinator.run(), PatientAuthOutcome.consentRequired);
    fake.response = {...me(), 'accountStatus': 'suspended'};
    expect(await coordinator.run(), PatientAuthOutcome.accessBlocked);
  });

  test('/me errors and malformed responses do not expose a snapshot', () async {
    final fake = FakeDependencies();
    final coordinator = fake.coordinator();
    expect(await coordinator.run(), PatientAuthOutcome.ready);
    fake.failMe = true;
    expect(await coordinator.run(), PatientAuthOutcome.meUnavailable);
    expect(coordinator.snapshot, isNull);
    fake.failMe = false;
    fake.response = {'uid': 'user-a'};
    expect(await coordinator.run(), PatientAuthOutcome.meUnavailable);
  });

  test(
    'different /me UID and different later sign-in UID are distinct',
    () async {
      final fake = FakeDependencies()..response = me(uid: 'user-b');
      final coordinator = fake.coordinator();
      expect(await coordinator.run(), PatientAuthOutcome.uidMismatch);
      expect(coordinator.snapshot, isNull);
      fake.signInIdentity = const AuthSessionIdentity('user-b', 2);
      fake.session = fake.signInIdentity;
      expect(await coordinator.run(), PatientAuthOutcome.uidMismatch);
      expect(fake.events, ['register', 'signIn', 'me:user-a', 'signIn']);
    },
  );

  test('concurrent requests are rejected without duplicate work', () async {
    final fake = FakeDependencies()
      ..pendingRegistration = Completer<RegistrationOutcome>();
    final coordinator = fake.coordinator();
    final first = coordinator.run();
    expect(await coordinator.run(), PatientAuthOutcome.duplicateRequest);
    fake.pendingRegistration!.complete(RegistrationOutcome.created);
    expect(await first, PatientAuthOutcome.ready);
    expect(fake.events, ['register', 'signIn', 'me:user-a']);
  });

  test('auth changes discard in-flight /me even for the same UID', () async {
    final fake = FakeDependencies()..pendingMe = Completer<Object?>();
    final coordinator = fake.coordinator();
    final result = coordinator.run();
    await Future<void>.delayed(Duration.zero);
    fake.session = const AuthSessionIdentity('user-a', 2);
    coordinator.invalidateSession();
    fake.pendingMe!.complete(me());
    expect(await result, PatientAuthOutcome.sessionChanged);
    expect(coordinator.snapshot, isNull);
  });

  test(
    'a stale sign-in result cannot bind a later session to the wrong UID',
    () async {
      final fake = FakeDependencies()
        ..session = const AuthSessionIdentity('user-b', 2);
      final coordinator = fake.coordinator();
      expect(await coordinator.run(), PatientAuthOutcome.sessionChanged);
      fake.signInIdentity = const AuthSessionIdentity('user-b', 2);
      fake.response = me(uid: 'user-b');
      expect(await coordinator.run(), PatientAuthOutcome.ready);
    },
  );
}
