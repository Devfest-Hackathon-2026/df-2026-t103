import 'patient_screen_access.dart';

/// Converts a decoded successful GET /v1/me response into a UI access snapshot.
///
/// [authenticatedUid] must come from the current authenticated session, not the
/// response. This function does not authenticate the response or perform HTTP.
/// The caller must accept only a successful response from the trusted API,
/// clear the previous snapshot when starting a fetch, on failure or sign-out,
/// and discard in-flight results if the session changes (even to the same uid).
/// Otherwise stale account or consent state could be reused. Server-side
/// authorization remains mandatory. Invalid input throws [FormatException].
PatientAccessSnapshot patientAccessSnapshotFromMe(
  Object? json, {
  required String authenticatedUid,
}) {
  Never invalid() => throw const FormatException('Invalid /v1/me response');

  if (authenticatedUid.isEmpty || json is! Map<String, dynamic>) invalid();
  final uid = json['uid'];
  final status = json['accountStatus'];
  final onboarding = json['onboardingState'];
  final consents = json['requiredConsents'];
  final deletion = json['deletionRequest'];
  const statuses = {
    'active',
    'onboarding_pending',
    'pending_deletion',
    'suspended',
    'deleted',
  };
  const onboardingStates = {
    'not_started',
    'legal_pending',
    'profile_pending',
    'completed',
  };
  const deletionStates = {
    'none',
    'pending_deletion',
    'processing',
    'completed',
    'cancelled',
  };

  if (uid is! String ||
      uid.isEmpty ||
      uid != authenticatedUid ||
      !json.containsKey('accountStatus') ||
      (status != null && (status is! String || !statuses.contains(status))) ||
      onboarding is! String ||
      !onboardingStates.contains(onboarding) ||
      json['emailVerified'] is! bool ||
      json['profileComplete'] is! bool ||
      consents is! Map<String, dynamic> ||
      deletion is! Map<String, dynamic>) {
    invalid();
  }
  final current = consents['current'];
  final missing = consents['missing'];
  if (current is! bool ||
      missing is! List ||
      missing.any((item) => item is! String) ||
      (current && missing.isNotEmpty) ||
      deletion['status'] is! String ||
      !deletionStates.contains(deletion['status']) ||
      deletion['canCancel'] is! bool) {
    invalid();
  }
  // Conflicting deletion state must never grant normal access.
  final deletionStatus = deletion['status'];
  if ((status == 'pending_deletion' &&
          !{
            'pending_deletion',
            'processing',
            'completed',
          }.contains(deletionStatus)) ||
      (status != 'pending_deletion' &&
          status != 'deleted' &&
          {
            'pending_deletion',
            'processing',
            'completed',
          }.contains(deletionStatus))) {
    invalid();
  }
  // A deleted account may have a completed historical job, but never an
  // in-progress job. Screen access still blocks every deleted account.
  if (status == 'deleted' &&
      {'pending_deletion', 'processing'}.contains(deletionStatus)) {
    invalid();
  }
  for (final key in [
    'requestedAt',
    'scheduledForDeletionAt',
    'cancelDeadline',
    'jobStatus',
  ]) {
    if (deletion.containsKey(key) && deletion[key] is! String) invalid();
  }

  return PatientAccessSnapshot(
    accountStatus: status as String?,
    onboardingState: onboarding,
    requiredConsentsCurrent: current,
    profileComplete: json['profileComplete'] as bool,
  );
}
