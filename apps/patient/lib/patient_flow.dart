import 'dart:async';
import 'dart:math';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'auth_method_screen.dart';
import 'demo_legal_document_transport.dart';
import 'demo_registration_transport.dart';
import 'email_auth_client.dart';
import 'home_screen.dart';
import 'legal_document_client.dart';
import 'patient_common.dart';
import 'patient_intake_api.dart';
import 'patient_intake_screen.dart';
import 'patient_redirect.dart';
import 'patient_screen_access.dart';
import 'patient_session_state.dart';
import 'profile_form_screen.dart';
import 'reconsent_contract.dart';
import 'welcome_screen.dart';

/// consentType → 表示名。未知の種別はそのまま表示する（審査済み文書名ではない）。
const _consentLabels = {
  'terms_of_service': '利用規約',
  'privacy_policy_ack': 'プライバシー説明',
  'health_data_collection': '医療情報の取得',
  'hospital_disclosure': '医療機関への情報提供',
  'optional_analytics': '利用状況の分析（任意）',
};

String _newOperationKey() => List.generate(
      24,
      (_) => Random.secure().nextInt(256),
    ).map((v) => v.toRadixString(16).padLeft(2, '0')).join();

/// 実接続フローが要求する接続層。`FirebaseIntakeConnection` が実装する。
/// すべてのメンバーは fail-closed のローカル/エミュレータ接続であること。
abstract interface class PatientFlowHost {
  PatientIntakeApi get api;
  String get origin;
  http.Client get client;
  String? get currentUid;
  Stream<void> get changes;
  Future<void> signIn(String email, String password);
  Future<void> signOut();
}

/// 実接続フローのルート。
///
/// 認証状態（[PatientSessionState]）から `patientLanding` で着地点を決め、
/// 未認証は「利用開始→方式選択→メール」、認証済みは「同意→プロフィール→
/// ホーム→症状入力」へ進める。Google/パスキーは未実装のため方式選択では
/// 無効表示のまま。すべての通信はエミュレータ専用 transport/api に限定される。
class PatientFlowScreen extends StatefulWidget {
  const PatientFlowScreen({
    super.key,
    required this.connection,
    @visibleForTesting this.session,
    @visibleForTesting this.requirementsLoader,
  });

  final PatientFlowHost connection;

  /// テスト用に [PatientSessionState] を差し替える。指定時はこの画面が
  /// dispose しない（注入側の責務）。
  final PatientSessionState? session;

  /// テスト用に同意要件の取得を差し替える。null なら実 API を使う。
  final Future<ConsentRequirements> Function()? requirementsLoader;

  @override
  State<PatientFlowScreen> createState() => _PatientFlowScreenState();
}

class _PatientFlowScreenState extends State<PatientFlowScreen> {
  late final PatientSessionState _session;
  late final bool _ownSession;
  late final StreamSubscription<void> _subscription;
  int _authStep = 0; // 0=welcome, 1=method, 2=email
  bool _inSymptom = false;

  @override
  void initState() {
    super.initState();
    _ownSession = widget.session == null;
    _session = widget.session ??
        PatientSessionState((_) => widget.connection.api.meJson());
    _subscription = widget.connection.changes.listen((_) => _onAuthEvent());
    unawaited(_session.updateUser(widget.connection.currentUid));
  }

  void _onAuthEvent() {
    setState(() {
      _authStep = 0;
      _inSymptom = false;
    });
    unawaited(_session.updateUser(widget.connection.currentUid));
  }

  Future<void> _reload() =>
      _session.updateUser(widget.connection.currentUid);

  Future<void> _signOut() async {
    try {
      await widget.connection.signOut();
    } catch (_) {
      // サインアウト失敗は authStateChanges が走らないため明示的に残す。
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('ログアウトできません。再試行してください。')),
        );
      }
    }
  }

  Future<ConsentRequirements> _loadRequirements() =>
      widget.requirementsLoader?.call() ??
      LegalDocumentClient(
        DemoLegalDocumentTransport(
          baseUrl: widget.connection.origin,
          client: widget.connection.client,
        ),
      ).fetchRequirements();

  /// 登録は成功したが続くサインインが失敗した状態。登録自体を再送しては
  /// いけないため、呼び出し側がログインへ誘導する。
  Future<void> _register(
    String email,
    String password,
    ConsentRequirements requirements,
    String idempotencyKey,
  ) async {
    final client = EmailAuthClient(
      transport: DemoRegistrationTransport(
        baseUrl: widget.connection.origin,
        client: widget.connection.client,
      ),
      signInProvider: const _NoImplicitSignIn(),
      requiredConsentTypes: requirements.requiredConsents.toSet(),
    );
    await client.register(
      email: email,
      password: password,
      consents: {
        for (final type in requirements.requiredConsents)
          type: ConsentSelection(
            accepted: true,
            documentVersion: requirements.documentVersions[type]!,
          ),
      },
      idempotencyKey: idempotencyKey,
    );
    // 登録成功後は明示的にサインインする（登録が自動サインインを兼ねない）。
    try {
      await widget.connection.signIn(email, password);
    } catch (_) {
      throw const _SignInAfterRegisterFailed();
    }
  }

  Future<void> _recordConsents(
    Map<String, ConsentDecision> consents,
    String idempotencyKey,
  ) async {
    await widget.connection.api.recordOnboardingConsents(
      consents: {
        for (final e in consents.entries)
          e.key: {
            'accepted': e.value.accepted,
            'documentVersion': e.value.documentVersion,
          },
      },
      idempotencyKey: idempotencyKey,
    );
    await _reload();
  }

  Future<void> _submitProfile(Map<String, Object> patch) async {
    await widget.connection.api.patchProfile(patch);
    await _reload();
  }

  @override
  void dispose() {
    _subscription.cancel();
    if (_ownSession) _session.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _session,
      builder: (context, _) {
        switch (_session.phase) {
          case PatientSessionPhase.unresolved:
            return const Scaffold(
              body: SafeArea(child: PatientStateView(status: PatientStatus.loading)),
            );
          case PatientSessionPhase.unavailable:
            return Scaffold(
              body: SafeArea(
                child: PatientStateView(
                  status: PatientStatus.error,
                  message: '利用状態を確認できません。接続を確認して再試行してください。',
                  onRetry: _reload,
                ),
              ),
            );
          case PatientSessionPhase.signedOut:
            return _buildAuthFlow();
          case PatientSessionPhase.ready:
            return _buildAuthed();
        }
      },
    );
  }

  Widget _buildAuthFlow() => switch (_authStep) {
        1 => AuthMethodScreen(
            passkeyEnabled: const bool.fromEnvironment('PASSKEY_AUTH_ENABLED'),
            enabledMethods: const [AuthMethod.email],
            onMethodSelected: (method) {
              if (method == AuthMethod.email) {
                setState(() => _authStep = 2);
              }
            },
          ),
        2 => _EmailCredentialScreen(
            onLogin: widget.connection.signIn,
            loadRequirements: _loadRequirements,
            onRegister: _register,
            onBack: () => setState(() => _authStep = 1),
          ),
        _ => WelcomeScreen(onStart: () => setState(() => _authStep = 1)),
      };

  Widget _buildAuthed() {
    final landing = patientLanding(
      auth: PatientAuthState.authenticated,
      me: _session.snapshot,
    );
    return switch (landing) {
      PatientLanding.loading => const Scaffold(
          body: SafeArea(child: PatientStateView(status: PatientStatus.loading)),
        ),
      PatientLanding.welcome => _buildAuthFlow(),
      PatientLanding.consent => _ConsentScreen(
          loadRequirements: _loadRequirements,
          onSubmit: _recordConsents,
          onSignOut: _signOut,
        ),
      PatientLanding.profileRegistration => ProfileFormScreen(
          onSubmit: _submitProfile,
          onSignOut: _signOut,
        ),
      PatientLanding.home => _inSymptom
          ? PatientIntakeScreen(
              api: widget.connection.api,
              signIn: widget.connection.signIn,
              signOut: widget.connection.signOut,
              sessionChanges: widget.connection.changes,
              startAuthenticated: true,
            )
          : HomeScreen(
              onStartQuestionnaire: () => setState(() => _inSymptom = true),
              onSignOut: _signOut,
            ),
      PatientLanding.deletionPending => _StatusOnlyScreen(
          title: '退会の手続き中です',
          body: '退会申請が進行中のため、利用機能は停止しています。',
          onSignOut: _signOut,
        ),
      PatientLanding.blocked => _StatusOnlyScreen(
          title: 'このアカウントは利用できません',
          body: 'アカウントが停止または削除されています。窓口へお問い合わせください。',
          onSignOut: _signOut,
        ),
    };
  }
}

/// 登録が暗黙のサインインを兼ねないことを保証するための EmailSignIn。
class _NoImplicitSignIn implements EmailSignIn {
  const _NoImplicitSignIn();
  @override
  Future<void> signIn(String email, String password) =>
      throw StateError('Registration must not sign in automatically');
}

/// 登録 API は成功したが直後のサインインが失敗したことを表すマーカー。
class _SignInAfterRegisterFailed implements Exception {
  const _SignInAfterRegisterFailed();
}

/// メールでのログイン/新規登録（P-004）。
///
/// 新規登録は同意要件を `/v1/public/legal-documents` から取得し、全必須同意へ
/// チェックを入れてから `POST /v1/auth/register` を行う。文書本文は API が
/// 公開していないため、種別と版を表示する（同意した版の特定に使う）。
class _EmailCredentialScreen extends StatefulWidget {
  const _EmailCredentialScreen({
    required this.onLogin,
    required this.loadRequirements,
    required this.onRegister,
    required this.onBack,
  });

  final Future<void> Function(String email, String password) onLogin;

  /// 必須同意の種別と文書版の取得。登録の前に提示して確認する。
  final Future<ConsentRequirements> Function() loadRequirements;
  final Future<void> Function(
    String email,
    String password,
    ConsentRequirements requirements,
    String idempotencyKey,
  ) onRegister;
  final VoidCallback onBack;

  @override
  State<_EmailCredentialScreen> createState() => _EmailCredentialScreenState();
}

class _EmailCredentialScreenState extends State<_EmailCredentialScreen> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _register = false;
  bool _busy = false;
  String? _message;

  /// リクエスト本文と対になる冪等キー。同一本文への再試行は同じキーを使い、
  /// 本文が変わったら再生成する（EmailAuthClient の契約）。
  String? _opKey;
  String? _opKeyBody;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy || !_formKey.currentState!.validate()) return;
    final email = _email.text.trim();
    final password = _password.text;

    ConsentRequirements? requirements;
    if (_register) {
      // 同意確認の前に要件を取得・確認する。キャンセル時は送信も
      // パスワードのクリアも行わない。
      try {
        requirements = await widget.loadRequirements();
      } catch (_) {
        if (mounted) {
          setState(() => _message = '同意要件を確認できません。接続を確認して再試行してください。');
        }
        return;
      }
      if (!mounted) return;
      final agreed = await _confirmConsents(requirements);
      if (!mounted || agreed != true) return;
    }

    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      if (_register) {
        final bodyId = '$email\n$password\n${requirements!.documentVersions}';
        if (_opKeyBody != bodyId) {
          _opKey = _newOperationKey();
          _opKeyBody = bodyId;
        }
        await widget.onRegister(email, password, requirements, _opKey!);
      } else {
        await widget.onLogin(email, password);
      }
    } on _SignInAfterRegisterFailed {
      if (mounted) {
        setState(() {
          _register = false;
          _message = '登録は完了しました。ログインをお試しください。';
        });
      }
    } on EmailAuthException catch (e) {
      if (mounted) {
        setState(() {
          _message = switch (e.reason) {
            EmailAuthFailure.rateLimited =>
              '試行が多いため、安全のため一時的に制限されています。しばらくお待ちください。',
            EmailAuthFailure.registrationRejected =>
              '登録できませんでした。入力内容をご確認ください。すでに登録済みの場合はログインをお試しください。',
            _ => '登録できませんでした。時間をおいて再試行してください。',
          };
        });
      }
    } on FirebaseAuthException catch (e) {
      if (mounted) {
        setState(() {
          _message = e.code == 'too-many-requests'
              ? '試行が多いため、安全のため一時的に制限されています。しばらくお待ちください。'
              : 'ログインできませんでした。メールアドレスとパスワードをご確認ください。';
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _message = _register
              ? '登録できませんでした。時間をおいて再試行してください。'
              : 'ログインできませんでした。メールアドレスとパスワードをご確認ください。';
        });
      }
    } finally {
      _password.clear();
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 必須同意の確認。文書本文は未公開のため種別と版を提示する。
  Future<bool?> _confirmConsents(ConsentRequirements requirements) {
    final checked = {
      for (final type in requirements.requiredConsents) type: false,
    };
    return showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('利用に必要な同意'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('以下の文書版の提示に同意いただく必要があります。'),
                for (final type in requirements.requiredConsents)
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(
                      '${_consentLabels[type] ?? type}'
                      '（版 ${requirements.documentVersions[type]}）に同意する（必須）',
                    ),
                    value: checked[type],
                    onChanged: (v) =>
                        setDialogState(() => checked[type] = v == true),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('キャンセル'),
            ),
            FilledButton(
              onPressed: checked.values.every((v) => v)
                  ? () => Navigator.of(context).pop(true)
                  : null,
              child: const Text('同意して登録'),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('メールでの利用登録・ログイン'),
        leading: BackButton(onPressed: _busy ? null : widget.onBack),
      ),
      body: SafeArea(
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 600),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Wrap(
                      spacing: 8,
                      children: [
                        ChoiceChip(
                          label: const Text('ログイン'),
                          selected: !_register,
                          onSelected: _busy
                              ? null
                              : (_) => setState(() {
                                    _register = false;
                                    _message = null;
                                  }),
                        ),
                        ChoiceChip(
                          label: const Text('新規登録'),
                          selected: _register,
                          onSelected: _busy
                              ? null
                              : (_) => setState(() {
                                    _register = true;
                                    _message = null;
                                  }),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      controller: _email,
                      enabled: !_busy,
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [AutofillHints.email],
                      autocorrect: false,
                      decoration: const InputDecoration(
                        labelText: 'メールアドレス',
                        border: OutlineInputBorder(),
                      ),
                      validator: (v) => v == null || v.trim().isEmpty
                          ? 'メールアドレスを入力してください。'
                          : null,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _password,
                      enabled: !_busy,
                      obscureText: true,
                      autocorrect: false,
                      enableSuggestions: false,
                      decoration: const InputDecoration(
                        labelText: 'パスワード',
                        border: OutlineInputBorder(),
                      ),
                      validator: (v) {
                        if (v == null || v.isEmpty) {
                          return 'パスワードを入力してください。';
                        }
                        if (_register &&
                            (v.length < 8 ||
                                v.length > 128 ||
                                !RegExp(r'[A-Za-z]').hasMatch(v) ||
                                !RegExp(r'[0-9]').hasMatch(v))) {
                          return 'パスワードは8〜128文字で英字と数字を含めてください。';
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: 16),
                    if (_register)
                      const Text(
                        '登録の前に、必須の同意文書（種別と版）を確認して同意いただきます。',
                      ),
                    if (_message != null)
                      Semantics(liveRegion: true, child: Text(_message!)),
                    if (_busy) const LinearProgressIndicator(),
                    const SizedBox(height: 8),
                    FilledButton(
                      onPressed: _busy ? null : _submit,
                      child: Text(_register ? '登録へ進む' : 'ログイン'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 同意が未完了/旧版のときの同意画面（P-002）。
class _ConsentScreen extends StatefulWidget {
  const _ConsentScreen({
    required this.loadRequirements,
    required this.onSubmit,
    required this.onSignOut,
  });

  final Future<ConsentRequirements> Function() loadRequirements;
  final Future<void> Function(
    Map<String, ConsentDecision> consents,
    String idempotencyKey,
  ) onSubmit;
  final VoidCallback onSignOut;

  @override
  State<_ConsentScreen> createState() => _ConsentScreenState();
}

class _ConsentScreenState extends State<_ConsentScreen> {
  /// 同一画面での同意送信は同一本文のため冪等キーは固定（失敗時の再試行に使う）。
  final String _key = _newOperationKey();
  ConsentRequirements? _requirements;
  Map<String, bool> _checked = {};
  bool _busy = false;
  bool _loadFailed = false;
  String? _submitError;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loadFailed = false;
      _submitError = null;
    });
    try {
      final requirements = await widget.loadRequirements();
      if (!mounted) return;
      setState(() {
        _requirements = requirements;
        _checked = {
          for (final type in requirements.requiredConsents) type: false,
        };
      });
    } catch (_) {
      if (mounted) setState(() => _loadFailed = true);
    }
  }

  Future<void> _submit() async {
    final requirements = _requirements;
    if (requirements == null || _busy) return;
    setState(() {
      _busy = true;
      _submitError = null;
    });
    try {
      await widget.onSubmit({
        for (final type in requirements.requiredConsents)
          type: ConsentDecision(
            accepted: true,
            documentVersion: requirements.documentVersions[type]!,
          ),
      }, _key);
    } catch (_) {
      if (mounted) {
        setState(() => _submitError = '同意を記録できませんでした。もう一度お試しください。');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final requirements = _requirements;
    return Scaffold(
      appBar: AppBar(
        title: const Text('利用に必要な同意'),
        actions: [
          IconButton(
            onPressed: widget.onSignOut,
            icon: const Icon(Icons.logout),
            tooltip: 'ログアウト',
          ),
        ],
      ),
      body: SafeArea(
        child: _loadFailed
            ? PatientStateView(
                status: PatientStatus.error,
                message: '同意要件を確認できません。接続を確認して再試行してください。',
                onRetry: _load,
              )
            : requirements == null
                ? const PatientStateView(status: PatientStatus.loading)
                : SingleChildScrollView(
                    padding: const EdgeInsets.all(24),
                    child: Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 640),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            const Text(
                              '利用を続けるには、以下の文書版の提示に同意いただく必要があります。'
                              '同意すると利用登録へ進めます。',
                            ),
                            const SizedBox(height: 16),
                            for (final type in requirements.requiredConsents)
                              CheckboxListTile(
                                contentPadding: EdgeInsets.zero,
                                title: Text(
                                  '${_consentLabels[type] ?? type}'
                                  '（版 ${requirements.documentVersions[type]}）に同意する（必須）',
                                ),
                                value: _checked[type] ?? false,
                                onChanged: _busy
                                    ? null
                                    : (v) => setState(
                                        () => _checked[type] = v == true,
                                      ),
                              ),
                            const SizedBox(height: 16),
                            if (_submitError != null)
                              Semantics(
                                  liveRegion: true,
                                  child: Text(_submitError!)),
                            if (_busy) const LinearProgressIndicator(),
                            FilledButton(
                              onPressed:
                                  !_busy && _checked.values.every((v) => v)
                                      ? _submit
                                      : null,
                              child: const Text('同意して進む'),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
      ),
    );
  }
}

/// 状態だけを伝える画面（停止・退会中など）。ログアウト導線のみ持つ。
class _StatusOnlyScreen extends StatelessWidget {
  const _StatusOnlyScreen({
    required this.title,
    required this.body,
    required this.onSignOut,
  });

  final String title;
  final String body;
  final VoidCallback onSignOut;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(body),
              const SizedBox(height: 24),
              OutlinedButton(
                onPressed: onSignOut,
                child: const Text('ログアウト'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
