enum PublicPatientPlatform { web, ios }

/// Explicit build-time settings for the deployed patient app.
/// Local emulator entrypoints remain separate and never fall back to this mode.
class PublicPatientConfig {
  const PublicPatientConfig({
    required this.projectId,
    required this.apiOrigin,
    required this.apiKey,
    required this.appId,
    this.authDomain = '',
    this.siteKey = '',
    this.facilityId = '',
  });
  final String projectId,
      apiOrigin,
      apiKey,
      appId,
      authDomain,
      siteKey,
      facilityId;
  factory PublicPatientConfig.fromEnvironment() => const PublicPatientConfig(
    projectId: String.fromEnvironment('FIREBASE_PROJECT_ID'),
    apiOrigin: String.fromEnvironment('API_BASE_URL'),
    apiKey: String.fromEnvironment('FIREBASE_API_KEY'),
    appId: String.fromEnvironment('FIREBASE_APP_ID'),
    authDomain: String.fromEnvironment('FIREBASE_AUTH_DOMAIN'),
    siteKey: String.fromEnvironment('APP_CHECK_SITE_KEY'),
    facilityId: String.fromEnvironment('PATIENT_FACILITY_ID'),
  );
  void validate({PublicPatientPlatform platform = PublicPatientPlatform.web}) {
    final uri = Uri.tryParse(apiOrigin);
    if (projectId != 'project-7efcc4c4-6c86-490c-ba5' ||
        uri == null ||
        uri.scheme != 'https' ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        uri.path.isNotEmpty ||
        apiOrigin.endsWith('/') ||
        [apiKey, appId].any((s) => s.trim().isEmpty) ||
        !RegExp('^1:842827776169:${platform.name}:[a-zA-Z0-9]+\$')
            .hasMatch(appId) ||
        (platform == PublicPatientPlatform.web &&
            (siteKey.trim().isEmpty ||
                !RegExp(r'^[a-zA-Z0-9.-]+$').hasMatch(authDomain)))) {
      throw StateError(
        'Patient public configuration is incomplete or invalid.',
      );
    }
  }
}
