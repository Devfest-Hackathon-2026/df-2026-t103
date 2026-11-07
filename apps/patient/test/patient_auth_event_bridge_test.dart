import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:patient/patient_auth_coordinator.dart';
import 'package:patient/patient_auth_event_bridge.dart';
import 'package:patient/patient_session_state.dart';

Map<String, dynamic> me(String uid) => {
  'uid': uid,
  'accountStatus': 'active',
  'onboardingState': 'completed',
  'emailVerified': true,
  'profileComplete': true,
  'requiredConsents': {'current': true, 'missing': <String>[]},
  'deletionRequest': {'status': 'none', 'canCancel': false},
};

void main() {
  test('every event, including same UID, invalidates and reloads session', () async {
    final events = StreamController<AuthSessionIdentity?>();
    var meCalls = 0;
    final state = PatientSessionState((uid) async {
      meCalls++;
      return me(uid);
    });
    final coordinator = PatientAuthCoordinator(
      register: () async => RegistrationOutcome.created,
      signIn: () async => const AuthSessionIdentity('a', 1),
      currentSession: () => const AuthSessionIdentity('a', 1),
      loadMe: (_) async => me('a'),
    );
    expect(await coordinator.run(), PatientAuthOutcome.ready);
    final previous = coordinator.snapshot;
    final bridge = PatientAuthEventBridge(
      events: events.stream,
      sessionState: state,
      coordinator: coordinator,
    );

    events.add(const AuthSessionIdentity('a', 1));
    await Future<void>.delayed(Duration.zero);
    expect(coordinator.snapshot, isNull);
    expect(state.phase, PatientSessionPhase.ready);
    expect(meCalls, 1);
    expect(previous, isNotNull);

    events.add(const AuthSessionIdentity('a', 2));
    await Future<void>.delayed(Duration.zero);
    expect(meCalls, 2);
    expect(state.snapshot, isNotNull);
    await bridge.close();
    await events.close();
    state.dispose();
  });

  test('stream error clears identity and fails closed; close unsubscribes', () async {
    final events = StreamController<AuthSessionIdentity?>();
    final state = PatientSessionState((uid) async => me(uid));
    final coordinator = PatientAuthCoordinator(
      register: () async => RegistrationOutcome.created,
      signIn: () async => const AuthSessionIdentity('a', 1),
      currentSession: () => const AuthSessionIdentity('a', 1),
      loadMe: (_) async => me('a'),
    );
    final bridge = PatientAuthEventBridge(
      events: events.stream,
      sessionState: state,
      coordinator: coordinator,
    );
    events.add(const AuthSessionIdentity('a', 1));
    await Future<void>.delayed(Duration.zero);
    events.addError(StateError('private detail'));
    await Future<void>.delayed(Duration.zero);
    expect(bridge.currentIdentity, isNull);
    expect(state.phase, PatientSessionPhase.unavailable);
    expect(state.snapshot, isNull);

    await bridge.close();
    final phaseAfterClose = state.phase;
    events.add(const AuthSessionIdentity('b', 2));
    await Future<void>.delayed(Duration.zero);
    expect(state.phase, phaseAfterClose);
    expect(bridge.currentIdentity, isNull);
    await events.close();
    state.dispose();
  });

  test('new event invalidates in-flight /me even for the same UID', () async {
    final events = StreamController<AuthSessionIdentity?>();
    final oldMe = Completer<Object?>();
    var calls = 0;
    final state = PatientSessionState((uid) {
      calls++;
      return calls == 1 ? oldMe.future : Future.value(me(uid));
    });
    final coordinator = PatientAuthCoordinator(
      register: () async => RegistrationOutcome.created,
      signIn: () async => const AuthSessionIdentity('a', 1),
      currentSession: () => const AuthSessionIdentity('a', 1),
      loadMe: (_) async => me('a'),
    );
    final bridge = PatientAuthEventBridge(
      events: events.stream,
      sessionState: state,
      coordinator: coordinator,
    );
    events.add(const AuthSessionIdentity('a', 1));
    await Future<void>.delayed(Duration.zero);
    expect(state.phase, PatientSessionPhase.unresolved);
    events.add(const AuthSessionIdentity('a', 2));
    await Future<void>.delayed(Duration.zero);
    oldMe.complete(me('a'));
    await Future<void>.delayed(Duration.zero);
    expect(state.phase, PatientSessionPhase.ready);
    expect(state.snapshot, isNotNull);
    expect(calls, 2);
    await bridge.close();
    await events.close();
    state.dispose();
  });

  for (final resolveAfterCloseCompletes in [false, true]) {
    test(
      'late /me after close${resolveAfterCloseCompletes ? ' completes' : ' starts'} cannot restore ready state',
      () async {
        final events = StreamController<AuthSessionIdentity?>();
        final delayedMe = Completer<Object?>();
        var calls = 0;
        final state = PatientSessionState((uid) {
          calls++;
          return calls == 1 ? Future.value(me(uid)) : delayedMe.future;
        });
        final coordinator = PatientAuthCoordinator(
          register: () async => RegistrationOutcome.created,
          signIn: () async => const AuthSessionIdentity('a', 1),
          currentSession: () => const AuthSessionIdentity('a', 1),
          loadMe: (_) async => me('a'),
        );
        final bridge = PatientAuthEventBridge(
          events: events.stream,
          sessionState: state,
          coordinator: coordinator,
        );

        events.add(const AuthSessionIdentity('a', 1));
        await Future<void>.delayed(Duration.zero);
        expect(state.phase, PatientSessionPhase.ready);
        expect(state.snapshot, isNotNull);

        events.add(const AuthSessionIdentity('a', 2));
        await Future<void>.delayed(Duration.zero);
        expect(state.phase, PatientSessionPhase.unresolved);
        expect(state.snapshot, isNull);

        final closing = bridge.close();
        // close() runs updateUser(null) through its first await synchronously.
        expect(state.phase, PatientSessionPhase.signedOut);
        expect(state.snapshot, isNull);
        if (resolveAfterCloseCompletes) {
          await closing;
          expect(state.phase, PatientSessionPhase.signedOut);
          delayedMe.complete(me('a'));
          await Future<void>.delayed(Duration.zero);
        } else {
          delayedMe.complete(me('a'));
          await Future<void>.delayed(Duration.zero);
          await closing;
        }
        expect(state.phase, PatientSessionPhase.signedOut);
        expect(state.snapshot, isNull);

        await events.close();
        state.dispose();
      },
    );
  }

  test('cancel failure is surfaced after session has failed closed', () async {
    final cancelGate = Completer<void>();
    final events = StreamController<AuthSessionIdentity?>(
      onCancel: () => cancelGate.future,
    );
    final state = PatientSessionState((uid) async => me(uid));
    final coordinator = PatientAuthCoordinator(
      register: () async => RegistrationOutcome.created,
      signIn: () async => const AuthSessionIdentity('a', 1),
      currentSession: () => const AuthSessionIdentity('a', 1),
      loadMe: (_) async => me('a'),
    );
    final bridge = PatientAuthEventBridge(
      events: events.stream,
      sessionState: state,
      coordinator: coordinator,
    );
    events.add(const AuthSessionIdentity('a', 1));
    await Future<void>.delayed(Duration.zero);

    final closing = bridge.close();
    expect(state.phase, PatientSessionPhase.signedOut);
    expect(state.snapshot, isNull);
    cancelGate.completeError(StateError('private cancel detail'));
    await expectLater(closing, throwsA(isA<StateError>()));
    expect(state.phase, PatientSessionPhase.signedOut);
    expect(state.snapshot, isNull);
    expect(bridge.currentIdentity, isNull);

    state.dispose();
  });
}
