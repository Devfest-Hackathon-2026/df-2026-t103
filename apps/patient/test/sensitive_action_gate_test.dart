import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart' show FirebaseAuthException;
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/sensitive_action_gate.dart';

class FakeReauthenticator implements SensitiveReauthenticator {
  // Session currency is polled; a queue lets a test flip it between the first
  // (pre-reauth) and second (post-reauth) check to model a session change.
  List<bool> currency = [true, true];
  int currencyCalls = 0;

  int reauthCalls = 0;
  bool reauthReturns = true;
  Object? reauthThrows;

  int actionCalls = 0;
  bool actionThrows = false;

  @override
  bool isSessionCurrent() {
    final value = currency[currencyCalls < currency.length ? currencyCalls : currency.length - 1];
    currencyCalls++;
    return value;
  }

  @override
  Future<bool> reauthenticate() async {
    reauthCalls++;
    if (reauthThrows != null) throw reauthThrows!;
    return reauthReturns;
  }

  Future<void> action() async {
    actionCalls++;
    if (actionThrows) throw StateError('sensitive op detail');
  }
}

void main() {
  late FakeReauthenticator rea;
  late SensitiveActionGate gate;

  setUp(() {
    rea = FakeReauthenticator();
    gate = SensitiveActionGate(reauthenticator: rea);
  });

  test('a fresh re-authentication authorizes the action exactly once', () async {
    final outcome = await gate.authorize(rea.action);
    expect(outcome, ReauthOutcome.authorized);
    expect(rea.reauthCalls, 1);
    expect(rea.actionCalls, 1);
  });

  test('the action never runs before re-authentication succeeds', () async {
    rea.reauthReturns = false; // user cancelled the re-auth prompt
    final outcome = await gate.authorize(rea.action);
    expect(outcome, ReauthOutcome.cancelled);
    expect(rea.actionCalls, 0);
  });

  test('a user who is no longer signed in cannot start a sensitive action', () async {
    rea.currency = [false];
    final outcome = await gate.authorize(rea.action);
    expect(outcome, ReauthOutcome.notSignedIn);
    expect(rea.reauthCalls, 0);
    expect(rea.actionCalls, 0);
  });

  test('a session change between re-auth and the action aborts it (再認証切れ)', () async {
    // Current before re-auth, but no longer current when the action would run.
    rea.currency = [true, false];
    final outcome = await gate.authorize(rea.action);
    expect(outcome, ReauthOutcome.sessionChanged);
    expect(rea.reauthCalls, 1);
    expect(rea.actionCalls, 0);
  });

  test('throttled re-auth is reported as rate limited, not a plain failure', () async {
    rea.reauthThrows = FirebaseAuthException(code: 'too-many-requests');
    final outcome = await gate.authorize(rea.action);
    expect(outcome, ReauthOutcome.rateLimited);
    expect(rea.actionCalls, 0);
  });

  test('a wrong credential maps to a re-auth failure without leaking detail', () async {
    rea.reauthThrows = FirebaseAuthException(
      code: 'wrong-password',
      message: 'secret detail',
    );
    final outcome = await gate.authorize(rea.action);
    expect(outcome, ReauthOutcome.reauthFailed);
    expect(rea.actionCalls, 0);
  });

  test('a non-Firebase error during re-auth maps to unavailable', () async {
    rea.reauthThrows = StateError('socket closed');
    final outcome = await gate.authorize(rea.action);
    expect(outcome, ReauthOutcome.unavailable);
    expect(rea.actionCalls, 0);
  });

  test('an action failure is isolated and does not masquerade as authorized', () async {
    rea.actionThrows = true;
    final outcome = await gate.authorize(rea.action);
    expect(outcome, ReauthOutcome.actionFailed);
    expect(rea.actionCalls, 1);
  });

  test('a re-entrant authorize is rejected so a sensitive op cannot double-run', () async {
    // Start one authorize that is still awaiting re-auth, then call again.
    final firstReauth = Completer<bool>();
    rea = _SlowReauthenticator(firstReauth);
    gate = SensitiveActionGate(reauthenticator: rea);
    final first = gate.authorize((rea as _SlowReauthenticator).action);
    final second = await gate.authorize((rea as _SlowReauthenticator).action);
    expect(second, ReauthOutcome.duplicateRequest);
    firstReauth.complete(true);
    expect(await first, ReauthOutcome.authorized);
    expect((rea as _SlowReauthenticator).actionCalls, 1);
  });
}

class _SlowReauthenticator extends FakeReauthenticator {
  _SlowReauthenticator(this._gate);
  final Completer<bool> _gate;
  @override
  Future<bool> reauthenticate() async {
    reauthCalls++;
    return _gate.future;
  }
}
