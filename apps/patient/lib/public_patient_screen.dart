import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'public_patient_api.dart';

class _Utf16LengthLimitingTextInputFormatter extends TextInputFormatter {
  const _Utf16LengthLimitingTextInputFormatter(this.maxCodeUnits);

  final int maxCodeUnits;

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    if (newValue.text.length <= maxCodeUnits) return newValue;
    var end = maxCodeUnits;
    final last = newValue.text.codeUnitAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) end--;
    final text = newValue.text.substring(0, end);
    final selection = newValue.selection;
    final offset = selection.baseOffset.clamp(0, end);
    final extent = selection.extentOffset.clamp(0, end);
    return TextEditingValue(
      text: text,
      selection: TextSelection(
        baseOffset: offset,
        extentOffset: extent,
        affinity: selection.affinity,
        isDirectional: selection.isDirectional,
      ),
    );
  }
}

/// Patient workflow backed entirely by the authenticated API. PHI is kept in
/// memory and cleared on every auth change. Never uses the preview fixtures.
class PublicPatientScreen extends StatefulWidget {
  const PublicPatientScreen({
    super.key,
    required this.api,
    required this.signIn,
    required this.signOut,
    required this.resetPassword,
    required this.changes,
    this.initialFacilityId = '',
    this.refreshEmailVerification,
    this.sendEmailVerification,
  });
  final PublicPatientApi api;
  final Future<void> Function(String, String) signIn;
  final Future<void> Function() signOut;
  final Future<void> Function(String) resetPassword;
  final Stream<void> changes;
  final String initialFacilityId;
  final Future<bool> Function()? refreshEmailVerification;
  final Future<void> Function()? sendEmailVerification;
  @override
  State<PublicPatientScreen> createState() => _PublicPatientScreenState();
}

class _PublicPatientScreenState extends State<PublicPatientScreen> {
  final _email = TextEditingController(), _password = TextEditingController();
  final _symptom = TextEditingController(),
      _facilityId = TextEditingController();
  final _answerFreeText = TextEditingController();
  // チャットの最新の質問を画面下へスクロールするためのコントローラ。
  final _scroll = ScrollController();
  late final StreamSubscription<void> _subscription;
  final _profileFields = <String, TextEditingController>{
    for (final key in [
      'familyName',
      'givenName',
      'familyNameKana',
      'givenNameKana',
      'birthDate',
      'phoneNumber',
      'postalCode',
      'prefecture',
      'city',
      'line1',
    ])
      key: TextEditingController(),
  };
  Map<String, dynamic> _legal = {};
  final _accepted = <String>{};
  String? _consentKey;
  String? _registrationKey;
  String? _registrationRecoveryNotice;
  String _step = 'login';
  bool _busy = false,
      _firstRegistration = false,
      _answerAttempted = false,
      _answerUncertain = false,
      _reviewed = false,
      _share = false,
      _profile = false,
      _medications = false;
  int _generation = 0;
  String? _error, _notice, _intakeId, _questionnaireId, _deliveryId;
  String? _createKey, _finalizeKey, _sendKey;
  String? _disclosureVersion, _disclosureHash;
  String _bodyLocation = 'whole_body';
  Map<String, dynamic>? _intake, _question, _summary, _facility, _delivery;
  Map<String, dynamic>? _editingAnswer, _editingQuestion;
  String _editingState = 'answered';
  final _editingCodes = <String>{};
  bool _editingMultiple = false;
  bool _answerEditNeedsReconcile = false;
  bool _answerEditQuestionChanged = false;
  Object? _answerEditOwner;
  int? _answerEditRevision;
  List<dynamic> _history = [];
  int _questionnaireRevision = 1;
  int? _questionIntakeRevision;
  String? _answerKey;
  Map<String, Object?>? _answerBody;
  Object? _answerOwner;
  DateTime? _answerKeyExpiresAt;
  final Stopwatch _answerKeyAge = Stopwatch();
  static const _answerRetryWindow = Duration(hours: 20);
  PublicPatientApi get api => widget.api;
  String _id(Object? value) {
    if (value is! String ||
        !RegExp(r'^[A-Za-z0-9_-]{1,200}$').hasMatch(value)) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    return value;
  }

  int _revision(Map<String, dynamic> data) {
    final revision = data['revision'] ?? data['intakeRevision'];
    if (revision is! int || revision < 1) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    return revision;
  }

  @override
  void initState() {
    super.initState();
    _facilityId.text = widget.initialFacilityId;
    _subscription = widget.changes.listen((_) {
      if (!mounted) return;
      setState(() {
        _generation++;
        _clear();
        _step = 'login';
        _busy = false;
      });
    });
  }

  void _clear() {
    _intake = _question = _summary = _facility = _delivery = null;
    _intakeId = _questionnaireId = _deliveryId = null;
    _createKey = _finalizeKey = _sendKey = null;
    _disclosureVersion = null;
    _disclosureHash = null;
    _history = [];
    _editingAnswer = _editingQuestion = null;
    _editingCodes.clear();
    _editingMultiple = false;
    _answerEditNeedsReconcile = false;
    _answerEditQuestionChanged = false;
    _answerEditOwner = null;
    _answerEditRevision = null;
    _editingState = 'answered';
    _symptom.clear();
    _answerFreeText.clear();
    _answerAttempted = false;
    _answerUncertain = false;
    _clearPendingAnswer();
    _legal = {};
    _accepted.clear();
    _consentKey = null;
    _registrationKey = null;
    _registrationRecoveryNotice = null;
    _firstRegistration = false;
    for (final field in _profileFields.values) {
      field.clear();
    }
    _password.clear();
    _bodyLocation = 'whole_body';
    _questionnaireRevision = 1;
    _questionIntakeRevision = null;
    _reviewed = _share = _profile = _medications = false;
    _error = _notice = null;
  }

  @override
  void dispose() {
    _subscription.cancel();
    for (final c in [
      _email,
      _password,
      _symptom,
      _answerFreeText,
      _facilityId,
      ..._profileFields.values,
    ]) {
      c.dispose();
    }
    _scroll.dispose();
    super.dispose();
  }

  /// チャットの最新メッセージが見えるよう最下部へスクロールする（アニメなし）。
  void _scrollToLatest() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    final generation = _generation;
    setState(() {
      _busy = true;
      _error = _notice = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted && generation == _generation) {
        setState(() {
          _error = e is PatientRequestFailure
              ? e.message
              : '操作を完了できません。入力内容と接続を確認してください。';
        });
      }
    } finally {
      if (mounted && generation == _generation) {
        setState(() {
          _busy = false;
        });
      }
    }
  }

  Future<void> _login() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.signIn(_email.text.trim(), _password.text);
      if (!mounted) return;
      setState(() {
        _busy = true;
      });
      _password.clear();
      final generation = _generation;
      await _resumeRegistration();
      if (!mounted || generation != _generation) return;
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e is PatientRequestFailure
              ? e.message
              : 'メールアドレス・パスワードと接続を確認してください。';
        });
      }
    } finally {
      _password.clear();
      if (mounted) {
        setState(() {
          _busy = false;
        });
      }
    }
  }

  Future<void> _resumeRegistration() async {
    final generation = _generation;
    final refresh = widget.refreshEmailVerification;
    if (refresh != null && !await refresh()) {
      if (mounted && generation == _generation) {
        setState(() {
          _step = 'verify';
        });
      }
      return;
    }
    final me = await api.request('GET', '/me');
    if (!mounted || generation != _generation) return;
    final status = me['accountStatus'];
    if (status != null &&
        status != 'active' &&
        status != 'onboarding_pending') {
      throw const PatientRequestFailure('403');
    }
    if (me['emailVerified'] != true) {
      setState(() {
        _step = 'verify';
      });
      return;
    }
    final consent = me['requiredConsents'];
    if (consent is! Map || consent['current'] != true) {
      await _loadRegistrationDocuments();
      return;
    }
    setState(() {
      _step = status == 'active' && me['profileComplete'] == true
          ? 'home'
          : 'profile';
    });
  }

  Future<void> _loadRegistrationDocuments() async {
    final generation = _generation;
    final response = await api.request(
      'GET',
      '/public/legal-documents',
      authenticated: false,
    );
    final required = response['requiredConsents'];
    final documents = response['documents'];
    const baseline = {
      'terms_of_service',
      'privacy_policy_ack',
      'health_data_collection',
    };
    if (required is! List ||
        documents is! Map ||
        required.isEmpty ||
        !required.toSet().containsAll(baseline)) {
      throw const PatientRequestFailure('LEGAL_UNAVAILABLE');
    }
    final selected = <String, dynamic>{};
    for (final type in required) {
      final doc = documents[type];
      if (type is! String ||
          !_legalLabels.containsKey(type) ||
          doc is! Map ||
          doc['text'] is! String ||
          (doc['text'] as String).trim().isEmpty ||
          (doc['text'] as String).length > 50000 ||
          doc['version'] is! String ||
          (doc['version'] as String).isEmpty ||
          doc['documentHash'] is! String ||
          (doc['documentHash'] as String).isEmpty) {
        throw const PatientRequestFailure('LEGAL_UNAVAILABLE');
      }
      selected[type] = Map<String, dynamic>.from(doc);
    }
    if (!mounted || generation != _generation) return;
    setState(() {
      _legal = selected;
      _accepted.clear();
      _consentKey = null;
      _step = 'consent';
    });
  }

  Future<void> _registerAccount() async {
    if (_legal.isEmpty || !_accepted.containsAll(_legal.keys)) {
      throw const PatientRequestFailure('412');
    }
    if (_email.text.trim().isEmpty ||
        _email.text.trim().length > 254 ||
        _password.text.length < 8 ||
        _password.text.length > 128) {
      throw const PatientRequestFailure('400');
    }
    _registrationKey ??= patientOperationKey();
    try {
      await api.request(
        'POST',
        '/auth/register',
        authenticated: false,
        key: _registrationKey,
        body: {
          'email': _email.text.trim(),
          'password': _password.text,
          'locale': 'ja-JP',
          'consents': {
            for (final entry in _legal.entries)
              entry.key: {
                'accepted': true,
                'documentVersion': entry.value['version'],
              },
          },
        },
      );
    } on PatientRequestFailure catch (error) {
      // A definitive validation/consent rejection did not create an account;
      // allow correction with a fresh key. For an unknown network outcome,
      // retain both this key and the now-locked request fields for safe replay.
      if (error.code == '400' || error.code == '412') {
        _registrationKey = null;
        _registrationRecoveryNotice = null;
      } else if (error.code == '409') {
        _registrationRecoveryNotice = '登録を完了できませんでした。既存アカウントの場合は、ログインをお試しください。';
      } else {
        _registrationRecoveryNotice =
            '登録結果を確認できません。登録済みの可能性があります。再試行する場合は同じ入力・同じキーを使います。';
      }
      rethrow;
    }
    _registrationRecoveryNotice =
        '登録は完了しました。ログインに失敗した場合は、同じメールアドレスとパスワードでログインできます。';
    try {
      await widget.signIn(_email.text.trim(), _password.text);
      _password.clear();
      await _resumeRegistration();
    } catch (_) {
      _registrationRecoveryNotice =
          '登録は完了しましたが、自動ログインを確認できませんでした。同じメールアドレスとパスワードでログインしてください。';
      throw const PatientRequestFailure('SIGN_IN_AFTER_REGISTER');
    }
  }

  Future<void> _beginRegistration() async {
    _firstRegistration = true;
    if (_registrationKey != null && _legal.isNotEmpty) {
      if (mounted) setState(() => _step = 'consent');
      return;
    }
    await _loadRegistrationDocuments();
  }

  Future<void> _returnToLogin() async {
    if (_registrationKey != null) {
      final proceed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('ログインに切り替えますか？'),
          content: Text(
            '${_registrationRecoveryNotice ?? '登録APIの結果を確認できません。'} '
            'ログインへ進んでも登録POSTは再送しません。メールアドレスとパスワードはこの画面内に保持します。',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('登録画面に戻る'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('ログインへ進む'),
            ),
          ],
        ),
      );
      if (proceed != true || !mounted) return;
    }
    setState(() {
      _step = 'login';
      _error = null;
    });
  }

  Future<void> _submitRegistrationConsents() async {
    if (_legal.isEmpty || !_accepted.containsAll(_legal.keys)) {
      throw const PatientRequestFailure('412');
    }
    _consentKey ??= patientOperationKey();
    try {
      await api.request(
        'POST',
        '/onboarding/consents',
        key: _consentKey,
        body: {
          'locale': 'ja-JP',
          'consents': {
            for (final entry in _legal.entries)
              entry.key: {
                'accepted': true,
                'documentVersion': entry.value['version'],
              },
          },
        },
      );
    } on PatientRequestFailure catch (e) {
      if (e.code == '412') await _loadRegistrationDocuments();
      rethrow;
    }
    await _resumeRegistration();
  }

  Future<void> _saveRegistrationProfile() async {
    final fields = {
      for (final e in _profileFields.entries) e.key: e.value.text.trim(),
    };
    if (fields.values.any((v) => v.isEmpty)) {
      throw const PatientRequestFailure('400');
    }
    await api.request(
      'PATCH',
      '/me/profile',
      body: {
        for (final entry in fields.entries)
          if (!{'prefecture', 'city', 'line1'}.contains(entry.key))
            entry.key: entry.value,
        'address': {
          for (final key in ['prefecture', 'city', 'line1']) key: fields[key],
        },
      },
    );
    await _resumeRegistration();
  }

  static const _legalLabels = {
    'terms_of_service': '利用規約',
    'privacy_policy_ack': 'プライバシーについて',
    'health_data_collection': '健康情報の取得について',
    'hospital_disclosure': '医療機関への情報提供について',
    'optional_analytics': '利用状況の解析について',
  };

  Future<void> _loadIntake({int? generation}) async {
    final result = await api.request('GET', '/intakes/${_id(_intakeId)}');
    if (generation != null && !_isCurrent(generation)) return;
    _intake = result;
    _revision(_intake!);
  }

  bool _validAnswers(Object? value) =>
      value is List &&
      value.every(
        (answer) =>
            answer is Map<String, dynamic> &&
            answer.keys.toSet().containsAll(const {
              'answerId',
              'questionId',
              'questionRevision',
              'stepIndex',
              'selectedCodes',
              'freeText',
              'answerState',
              'answeredAt',
              'updatedAt',
            }) &&
            answer['answerId'] is String &&
            answer['questionId'] is String &&
            answer['questionRevision'] is int &&
            answer['stepIndex'] is int &&
            answer['selectedCodes'] is List &&
            (answer['selectedCodes'] as List).every((code) => code is String) &&
            (answer['freeText'] == null || answer['freeText'] is String) &&
            {
              'answered',
              'unknown',
              'skipped',
            }.contains(answer['answerState']) &&
            answer['answeredAt'] is String &&
            answer['updatedAt'] is String,
      );

  Future<void> _saveSymptoms() async {
    final text = _symptom.text.trim();
    if (text.isEmpty || text.length > 1000) {
      throw const PatientRequestFailure('400');
    }
    _createKey ??= patientOperationKey();
    if (_intakeId == null) {
      final created = await api.request(
        'POST',
        '/intakes',
        key: _createKey,
        body: {'locale': 'ja-JP'},
      );
      _intakeId = _id(created['intakeId']);
    }
    await _loadIntake();
    if (_intake!['status'] == 'draft') {
      await api.request(
        'POST',
        '/intakes/$_intakeId/symptoms',
        body: {
          'initialSymptomText': text,
          'bodyLocations': [_bodyLocation],
          'expectedIntakeRevision': _revision(_intake!),
        },
      );
    }
    await _nextQuestion();
  }

  Future<void> _nextQuestion() async {
    final generation = _generation;
    await _loadIntake(generation: generation);
    if (!_isCurrent(generation)) return;
    if (_intake!['status'] == 'review') {
      await _review();
      if (!_isCurrent(generation)) return;
      return;
    }
    if (_intake!['status'] == 'finalized') {
      await _loadHistory();
      if (!_isCurrent(generation)) return;
      return;
    }
    if (_intake!['status'] != 'questioning') {
      throw const PatientRequestFailure('412');
    }
    final questions = _intake!['questions'];
    final answers = _intake!['answers'];
    if (questions is! List || !_validAnswers(answers)) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    final pending = questions.whereType<Map<String, dynamic>>().where(
      (q) =>
          q['status'] == 'active' &&
          !answers.whereType<Map>().any(
            (a) =>
                a['questionId'] == q['questionId'] &&
                a['questionRevision'] == q['questionRevision'],
          ),
    );
    final previousQuestion = _question;
    if (pending.isNotEmpty) {
      _question = pending.first;
    } else {
      final next = await api.request(
        'POST',
        '/intakes/$_intakeId/next-question',
        body: {'expectedIntakeRevision': _revision(_intake!)},
      );
      if (!_isCurrent(generation)) return;
      if (next['question'] == null) {
        await _review();
        if (!_isCurrent(generation)) return;
        return;
      }
      _question = Map<String, dynamic>.from(next['question'] as Map);
    }
    if (!_isCurrent(generation)) return;
    if (previousQuestion?['questionId'] != _question?['questionId'] ||
        previousQuestion?['questionRevision'] !=
            _question?['questionRevision']) {
      _answerFreeText.clear();
      _clearPendingAnswer();
    }
    _id(_question!['questionId']);
    if (_question!['questionText'] is! String ||
        _question!['options'] is! List) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    await _loadIntake(generation: generation);
    if (!_isCurrent(generation)) return;
    _validateActiveQuestion(_question!);
    _questionIntakeRevision = _revision(_intake!);
    if (mounted) {
      setState(() {
        _step = 'question';
      });
      _scrollToLatest();
    }
  }

  Future<void> _answer(String? code, String state) async {
    if (_answerAttempted) return;
    final q = _question!;
    final generation = _generation;
    final owner = api.session();
    final freeText = _answerFreeText.text;
    if (code != null && state == 'answered' && freeText.length > 2000) {
      throw const PatientRequestFailure('400');
    }
    try {
      await _loadIntake(generation: generation);
    } catch (_) {
      if (_isCurrent(generation)) _answerAttempted = false;
      rethrow;
    }
    if (!_isCurrent(generation)) return;
    if (!identical(owner, api.session())) {
      throw const PatientRequestFailure('401');
    }
    final currentAnswers = _intake?['answers'];
    if (!_validAnswers(currentAnswers)) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    _validateActiveQuestion(q);
    if (_questionIntakeRevision == null ||
        _revision(_intake!) != _questionIntakeRevision) {
      throw const PatientRequestFailure('412');
    }
    if ((currentAnswers as List).any(
      (answer) =>
          answer['questionId'] == q['questionId'] &&
          answer['questionRevision'] == q['questionRevision'],
    )) {
      _answerAttempted = false;
      throw const PatientRequestFailure('412');
    }
    _answerAttempted = true;
    _answerKey = patientOperationKey();
    _answerOwner = owner;
    // Server idempotency records expire after 24h. Use a shorter monotonic
    // window to leave margin; this cannot account for device suspension, so
    // retries are only best-effort and the server remains authoritative.
    _answerKeyAge
      ..reset()
      ..start();
    _answerKeyExpiresAt = api.now().add(_answerRetryWindow);
    _answerBody = {
      'questionId': _id(q['questionId']),
      'questionRevision': q['questionRevision'],
      'selectedCodes': code == null ? <String>[] : [code],
      'answerState': state,
      if (code != null && state == 'answered' && freeText.trim().isNotEmpty)
        'freeText': freeText,
      'expectedIntakeRevision': _revision(_intake!),
    };
    await _postPendingAnswer(generation);
  }

  Future<void> _postPendingAnswer(int generation) async {
    final key = _answerKey;
    final body = _answerBody;
    if (key == null || body == null || !_isCurrent(generation)) return;
    if (!identical(_answerOwner, api.session())) {
      throw const PatientRequestFailure('401');
    }
    if (_answerKeyExpiresAt == null ||
        !api.now().isBefore(_answerKeyExpiresAt!) ||
        !_answerKeyAge.isRunning ||
        _answerKeyAge.elapsed >= _answerRetryWindow) {
      _answerUncertain = true;
      throw const PatientRequestFailure('ANSWER_KEY_EXPIRED');
    }
    try {
      final result = await api.request(
        'POST',
        '/intakes/$_intakeId/answers',
        key: key,
        body: body,
      );
      if (result['answerId'] != body['questionId'] ||
          result['intakeRevision'] is! int ||
          result['intakeRevision'] !=
              (body['expectedIntakeRevision'] as int) + 1) {
        throw const PatientRequestFailure('INVALID_RESPONSE');
      }
    } on PatientRequestFailure catch (e) {
      if (_isCurrent(generation)) {
        final rejected =
            const {'400', '401', '403', '404', '412'}.contains(e.code) ||
            (e.code == '409' &&
                e.apiCode != null &&
                !(e.apiCode == 'IDEMPOTENCY_IN_PROGRESS' && e.retryable));
        if (rejected) {
          _clearPendingAnswer();
        } else {
          // A 409 may mean the server is still processing this same operation.
          _answerUncertain = true;
        }
      }
      rethrow;
    } catch (_) {
      if (_isCurrent(generation)) _answerUncertain = true;
      rethrow;
    }
    if (!_isCurrent(generation)) return;
    _clearPendingAnswer();
    await _nextQuestion();
  }

  void _clearPendingAnswer() {
    _answerKey = null;
    _answerBody = null;
    _answerOwner = null;
    _answerKeyExpiresAt = null;
    _answerKeyAge
      ..stop()
      ..reset();
    _answerAttempted = false;
    _answerUncertain = false;
  }

  Future<void> _retryPendingAnswer() async {
    final expiry = _answerKeyExpiresAt;
    if (expiry == null ||
        !api.now().isBefore(expiry) ||
        !_answerKeyAge.isRunning ||
        _answerKeyAge.elapsed >= _answerRetryWindow) {
      _answerUncertain = true;
      throw const PatientRequestFailure('ANSWER_KEY_EXPIRED');
    }
    if (!identical(_answerOwner, api.session())) {
      throw const PatientRequestFailure('401');
    }
    await _postPendingAnswer(_generation);
  }

  void _validateActiveQuestion(Map<String, dynamic> question) {
    final intake = _intake;
    final questions = intake?['questions'];
    if (intake == null ||
        intake['status'] != 'questioning' ||
        intake['currentQuestionId'] != question['questionId'] ||
        questions is! List ||
        questions.any((item) => item is! Map<String, dynamic>)) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    final active = questions.whereType<Map<String, dynamic>>().where(
      (item) => item['questionId'] == question['questionId'],
    );
    if (active.length != 1 ||
        active.first['status'] != 'active' ||
        active.first['questionRevision'] != question['questionRevision']) {
      throw const PatientRequestFailure('412');
    }
  }

  bool _isCurrent(int generation) => mounted && generation == _generation;

  Future<void> _review() async {
    final generation = _generation;
    await _loadIntake(generation: generation);
    if (!_isCurrent(generation)) return;
    final result = await api.request(
      'POST',
      '/intakes/$_intakeId/summary',
      body: {'expectedIntakeRevision': _revision(_intake!)},
    );
    if (!_isCurrent(generation)) return;
    _summary = Map<String, dynamic>.from(result['summary'] as Map);
    await _loadIntake(generation: generation);
    if (!_isCurrent(generation)) return;
    if (result['intakeRevision'] != _revision(_intake!)) {
      throw const PatientRequestFailure('409');
    }
    final savedAnswers = _intake?['answers'];
    final questions = _intake?['questions'];
    if (!_validAnswers(savedAnswers) ||
        questions is! List ||
        questions.any(
          (item) =>
              item is! Map<String, dynamic> ||
              item['questionId'] is! String ||
              item['questionRevision'] is! int ||
              item['questionText'] is! String ||
              item['options'] is! List,
        )) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    for (final answer in savedAnswers) {
      final matching = questions.whereType<Map<String, dynamic>>().where(
        (question) =>
            question['questionId'] == answer['questionId'] &&
            question['questionRevision'] == answer['questionRevision'],
      );
      if (matching.length != 1) {
        throw const PatientRequestFailure('INVALID_RESPONSE');
      }
    }
    if (mounted) {
      setState(() {
        _reviewed = false;
        _step = 'review';
      });
    }
  }

  Future<void> _beginAnswerEdit(
    Map<String, dynamic> answer,
    Map<String, dynamic> question,
  ) async {
    final selected = answer['selectedCodes'] as List;
    setState(() {
      _editingAnswer = answer;
      _editingQuestion = question;
      _editingState = answer['answerState'] as String;
      _editingCodes
        ..clear()
        ..addAll(selected.cast<String>());
      // Questions use single-choice UI. Preserve legacy multi-code answers for
      // free-text-only edits; a selection change must be explicitly confirmed.
      _editingMultiple = selected.length > 1;
      _answerEditNeedsReconcile = false;
      _answerEditQuestionChanged = false;
      _answerEditOwner = null;
      _answerEditRevision = null;
      _answerFreeText.text = answer['freeText'] as String? ?? '';
    });
  }

  Future<void> _saveAnswerEdit() async {
    final answer = _editingAnswer;
    final question = _editingQuestion;
    if (answer == null || question == null) {
      throw const PatientRequestFailure('412');
    }
    final generation = _generation;
    final owner = api.session();
    final questionId = _id(answer['questionId']);
    final questionRevision = answer['questionRevision'];
    if (questionRevision is! int ||
        questionRevision != question['questionRevision']) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    final selectedCodes = _editingState == 'answered'
        ? _editingCodes.toList()
        : <String>[];
    if (_editingState == 'answered' && selectedCodes.isEmpty) {
      throw const PatientRequestFailure('400');
    }
    final freeText =
        _editingState == 'answered' && _answerFreeText.text.trim().isNotEmpty
        ? _answerFreeText.text
        : null;
    if (_answerFreeText.text.length > 2000) {
      throw const PatientRequestFailure('400');
    }
    final body = <String, Object?>{
      'questionRevision': questionRevision,
      'selectedCodes': selectedCodes,
      'freeText': freeText,
      'answerState': _editingState,
    };
    final previousRevision = _revision(_intake!);
    var patchRevision = previousRevision + 1;
    var patchConfirmed = false;
    Object? patchFailure;
    try {
      final result = await api.request(
        'PATCH',
        '/intakes/${_id(_intakeId)}/answers/$questionId',
        body: {...body, 'expectedIntakeRevision': previousRevision},
      );
      if (result['answerId'] != questionId ||
          result['intakeRevision'] != previousRevision + 1) {
        throw const PatientRequestFailure('INVALID_RESPONSE');
      }
      patchRevision = result['intakeRevision'] as int;
      patchConfirmed = true;
    } on PatientRequestFailure catch (error) {
      // Explicit client/auth/resource/precondition rejections cannot have
      // committed this PATCH. Keep the draft editable and do not mislabel it
      // as an unknown outcome requiring reconciliation.
      if (const {'400', '401', '403', '404', '412'}.contains(error.code)) {
        rethrow;
      }
      patchFailure = error;
      // PATCH may have committed even if its response was lost. Never report
      // success until an authenticated GET confirms the exact edited values.
    } catch (error) {
      patchFailure = error;
    }
    _answerEditOwner = owner;
    _answerEditRevision = patchRevision;
    _answerEditNeedsReconcile = true;
    await _reconcileAnswerEdit(
      generation: generation,
      owner: owner,
      patchRevision: patchRevision,
      questionId: questionId,
      questionRevision: questionRevision,
      selectedCodes: selectedCodes,
      freeText: freeText,
      answerState: _editingState,
      patchConfirmed: patchConfirmed,
      patchFailure: patchFailure,
    );
  }

  Future<void> _retryAnswerEditReconcile() async {
    final answer = _editingAnswer;
    final question = _editingQuestion;
    final owner = _answerEditOwner;
    final patchRevision = _answerEditRevision;
    if (answer == null ||
        question == null ||
        owner == null ||
        patchRevision == null) {
      throw const PatientRequestFailure('412');
    }
    if (!identical(owner, api.session())) {
      throw const PatientRequestFailure('401');
    }
    final selectedCodes = _editingState == 'answered'
        ? _editingCodes.toList()
        : <String>[];
    final freeText =
        _editingState == 'answered' && _answerFreeText.text.trim().isNotEmpty
        ? _answerFreeText.text
        : null;
    await _reconcileAnswerEdit(
      generation: _generation,
      owner: owner,
      patchRevision: patchRevision,
      questionId: _id(answer['questionId']),
      questionRevision: question['questionRevision'] as int,
      selectedCodes: selectedCodes,
      freeText: freeText,
      answerState: _editingState,
      patchConfirmed: false,
      patchFailure: const PatientRequestFailure('409'),
    );
  }

  Future<void> _reconcileAnswerEdit({
    required int generation,
    required Object owner,
    required int patchRevision,
    required String questionId,
    required int questionRevision,
    required List<String> selectedCodes,
    required String? freeText,
    required String answerState,
    required bool patchConfirmed,
    required Object? patchFailure,
  }) async {
    if (!_isCurrent(generation) || !identical(owner, api.session())) {
      throw const PatientRequestFailure('401');
    }
    Map<String, dynamic> current;
    try {
      current = await api.request('GET', '/intakes/${_id(_intakeId)}');
    } catch (_) {
      if (_isCurrent(generation) && identical(owner, api.session())) {
        _answerEditNeedsReconcile = true;
      }
      rethrow;
    }
    if (!_isCurrent(generation) || !identical(owner, api.session())) {
      throw const PatientRequestFailure('401');
    }
    final answers = current['answers'];
    final updated = answers is List
        ? answers.whereType<Map<String, dynamic>>().where(
            (item) => item['questionId'] == questionId,
          )
        : const <Map<String, dynamic>>[];
    final latestRevision = current['revision'];
    final saved = updated.length == 1 ? updated.first : null;
    final latestQuestions = current['questions'];
    final latestQuestion = latestQuestions is List
        ? latestQuestions.whereType<Map<String, dynamic>>().where(
            (item) => item['questionId'] == questionId,
          )
        : const <Map<String, dynamic>>[];
    final questionUnchanged =
        latestQuestion.length == 1 &&
        latestQuestion.single['questionRevision'] == questionRevision &&
        _sameQuestionOptions(latestQuestion.single, _editingQuestion!);
    final matches =
        saved != null &&
        questionUnchanged &&
        latestRevision is int &&
        latestRevision == patchRevision &&
        saved['questionRevision'] == questionRevision &&
        saved['answerState'] == answerState &&
        _sameStringList(saved['selectedCodes'], selectedCodes) &&
        saved['freeText'] == freeText;
    // A 409 is an explicit rejection, not an ambiguous transport failure.
    // Even if a concurrent writer happened to save identical values at the
    // expected next revision, that does not establish that this PATCH worked.
    if (!patchConfirmed) {
      _intake = current;
      _revision(_intake!);
      _answerEditNeedsReconcile = false;
      final latestAnswers = current['answers'];
      final latest = latestAnswers is List
          ? latestAnswers.whereType<Map<String, dynamic>>().where(
              (item) => item['questionId'] == questionId,
            )
          : const <Map<String, dynamic>>[];
      if (latest.length == 1) _editingAnswer = latest.single;
      _answerEditQuestionChanged = !questionUnchanged;
      if (!questionUnchanged && latestQuestion.length == 1) {
        _editingQuestion = latestQuestion.single;
      }
      if (patchFailure is PatientRequestFailure && patchFailure.code == '409') {
        throw PatientRequestFailure(
          questionUnchanged
              ? 'ANSWER_EDIT_REJECTED'
              : 'ANSWER_EDIT_QUESTION_CHANGED',
        );
      }
      throw const PatientRequestFailure('ANSWER_EDIT_NOT_CONFIRMED');
    }
    if (!matches) {
      _intake = current;
      _revision(_intake!);
      _answerEditNeedsReconcile = false;
      final latestAnswers = current['answers'];
      final latest = latestAnswers is List
          ? latestAnswers.whereType<Map<String, dynamic>>().where(
              (item) => item['questionId'] == questionId,
            )
          : const <Map<String, dynamic>>[];
      if (latest.length == 1) _editingAnswer = latest.single;
      _answerEditQuestionChanged = !questionUnchanged;
      if (!questionUnchanged && latestQuestion.length == 1) {
        _editingQuestion = latestQuestion.single;
      }
      throw const PatientRequestFailure('409');
    }
    _intake = current;
    _revision(_intake!);
    _editingAnswer = _editingQuestion = null;
    _answerEditNeedsReconcile = false;
    _answerEditOwner = null;
    _answerEditRevision = null;
    _editingCodes.clear();
    _answerFreeText.clear();
    // The edit is confirmed and draft cleared before navigation. A follow-up
    // review/next request failure must not imply that the save itself failed.
    try {
      if (current['status'] == 'review') {
        await _review();
      } else if (current['status'] == 'questioning') {
        await _nextQuestion();
      } else {
        throw const PatientRequestFailure('412');
      }
    } catch (_) {
      if (_isCurrent(generation)) {
        _notice = '回答の変更は保存されました。次の画面を読み込めませんでした。内容を再読み込みしてください。';
        _step = 'review';
      }
    }
  }

  bool _sameQuestionOptions(
    Map<String, dynamic> latest,
    Map<String, dynamic> original,
  ) {
    final a = latest['options'], b = original['options'];
    if (a is! List || b is! List || a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] is! Map ||
          b[i] is! Map ||
          a[i]['code'] != b[i]['code'] ||
          a[i]['label'] != b[i]['label']) {
        return false;
      }
    }
    return latest['questionText'] == original['questionText'];
  }

  Map<String, dynamic>? _latestQuestionForAnswer(
    Object? questions,
    Object? questionId,
  ) {
    if (questions is! List) return null;
    final matching = questions.whereType<Map<String, dynamic>>().where(
      (item) => item['questionId'] == questionId,
    );
    return matching.length == 1 ? matching.single : null;
  }

  Future<void> _changeAnswerState(String state) async {
    if (state == _editingState) return;
    if (_answerFreeText.text.trim().isNotEmpty) {
      final discard = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('補足を削除しますか？'),
          content: const Text('「わからない」「答えたくない」に変更すると、入力済みの補足は保存されません。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('戻る'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('補足を削除して変更'),
            ),
          ],
        ),
      );
      if (discard != true || !mounted) return;
    }
    setState(() {
      _editingState = state;
      _editingCodes.clear();
      _answerFreeText.clear();
    });
  }

  bool _sameStringList(Object? actual, List<String> expected) {
    if (actual is! List || actual.length != expected.length) return false;
    for (var index = 0; index < actual.length; index++) {
      if (actual[index] is! String || actual[index] != expected[index]) {
        return false;
      }
    }
    return true;
  }

  Future<void> _finalize() async {
    if (!_reviewed) throw const PatientRequestFailure('412');
    _finalizeKey ??= patientOperationKey();
    final result = await api.request(
      'POST',
      '/intakes/$_intakeId/finalize',
      key: _finalizeKey,
      body: {
        'expectedIntakeRevision': _revision(_intake!),
        'summaryReviewConfirmed': true,
      },
    );
    _questionnaireId = _id(result['questionnaireId']);
    _questionnaireRevision = result['questionnaireRevision'] as int;
    if (mounted) {
      setState(() {
        _step = 'send';
      });
    }
    if (_facilityId.text.trim().isNotEmpty) await _loadFacility();
  }

  Future<void> _loadFacility() async {
    _facility = null;
    _disclosureVersion = null;
    _disclosureHash = null;
    _share = false;
    _sendKey = null;
    final result = await api.request(
      'GET',
      '/facilities/${_id(_facilityId.text.trim())}',
    );
    final docs = await api.request('GET', '/public/legal-documents');
    final version = (docs['documents'] as Map?)?['hospital_disclosure'];
    if (version is! Map ||
        version['version'] is! String ||
        (version['version'] as String).trim().isEmpty ||
        version['documentHash'] is! String ||
        (version['documentHash'] as String).trim().isEmpty) {
      throw const PatientRequestFailure('412');
    }
    if (mounted) {
      setState(() {
        _facility = result;
        _disclosureVersion = version['version'] as String;
        _disclosureHash = version['documentHash'] as String;
      });
    }
  }

  Future<void> _send() async {
    final facility = _facility;
    if (facility == null ||
        !_share ||
        (facility['verificationStatus'] != 'verified' &&
            facility['syntheticRecipient'] != true) ||
        facility['receivingEnabled'] != true) {
      throw const PatientRequestFailure('412');
    }
    if (_disclosureVersion == null || _disclosureHash == null) {
      throw const PatientRequestFailure('412');
    }
    _sendKey ??= patientOperationKey();
    final scope = {
      'includeProfile': _profile,
      'includeConfirmedMedications': _medications,
      'includePrescriptionImages': false,
    };
    final result = await api.request(
      'POST',
      '/deliveries',
      key: _sendKey,
      body: {
        'questionnaireId': _id(_questionnaireId),
        'questionnaireRevision': _questionnaireRevision,
        'facilityId': _id(facility['facilityId']),
        'shareScope': scope,
        'consent': {
          'accepted': true,
          'documentVersion': _disclosureVersion,
          'documentHash': _disclosureHash,
          'shareScope': scope,
        },
      },
    );
    _deliveryId = _id(result['deliveryId']);
    if (mounted) {
      setState(() {
        _step = 'delivery';
      });
    }
    await _refreshDelivery();
  }

  Future<void> _refreshDelivery() async {
    final result = await api.request('GET', '/deliveries/${_id(_deliveryId)}');
    if (mounted) {
      setState(() {
        _delivery = result;
      });
    }
  }

  Future<void> _loadHistory() async {
    final generation = _generation;
    final result = await api.request('GET', '/questionnaires');
    if (!_isCurrent(generation)) return;
    if (result['questionnaires'] is! List) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    if (mounted) {
      setState(() {
        _history = result['questionnaires'] as List;
        _step = 'history';
      });
    }
  }

  Future<void> _openQuestionnaire(Map row) async {
    final result = await api.request(
      'GET',
      '/questionnaires/${_id(row['questionnaireId'])}',
    );
    final revision = result['revision'];
    if (revision is! Map<String, dynamic>) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    _summary = revision;
    _questionnaireId = _id(result['questionnaireId']);
    _questionnaireRevision = revision['versionNumber'] as int;
    _facility = null;
    _share = false;
    _sendKey = null;
    if (mounted) {
      setState(() {
        _step = 'send';
      });
    }
  }

  Widget _button(
    String text,
    Future<void> Function() action, {
    bool enabled = true,
  }) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: FilledButton(
      onPressed: _busy || !enabled ? null : () => _run(action),
      child: Text(text),
    ),
  );
  Widget _field(
    String label,
    TextEditingController controller, {
    bool secret = false,
    int lines = 1,
    bool readOnly = false,
  }) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 10),
    child: TextField(
      key: ValueKey(label),
      controller: controller,
      enabled: !_busy,
      readOnly: readOnly,
      obscureText: secret,
      minLines: lines,
      maxLines: lines,
      autocorrect: false,
      enableSuggestions: !secret,
      keyboardType: secret
          ? TextInputType.visiblePassword
          : label == 'メールアドレス'
          ? TextInputType.emailAddress
          : TextInputType.text,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
    ),
  );

  /// チャットの吹き出し。アシスタント（質問）は左、患者（回答）は右に寄せる。
  /// 本文テキストは患者テーマ（20sp）を継承し、拡大・Semantics に配慮する。
  Widget _chatBubble(
    String text, {
    required bool fromUser,
    bool emphasis = false,
    bool header = false,
  }) {
    final scheme = Theme.of(context).colorScheme;
    final bubble = Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      padding: const EdgeInsets.all(14),
      constraints: const BoxConstraints(maxWidth: 520),
      decoration: BoxDecoration(
        color: fromUser ? scheme.primaryContainer : scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Text(
        text,
        style: emphasis ? const TextStyle(fontWeight: FontWeight.bold) : null,
      ),
    );
    return Align(
      alignment: fromUser ? Alignment.centerRight : Alignment.centerLeft,
      child: header ? Semantics(header: true, child: bubble) : bubble,
    );
  }

  /// 保存済みの症状・回答から会話トランスクリプトを組み立てる（サーバ権威の
  /// `_intake` 由来）。アシスタントの質問 → 患者の回答 の順で吹き出しを並べる。
  List<Widget> _chatTranscript() {
    final widgets = <Widget>[
      _chatBubble('気になる症状や、医療機関に伝えたいことを教えてください。', fromUser: false),
    ];
    final symptom = _intake?['initialSymptomText'];
    if (symptom is String && symptom.isNotEmpty) {
      widgets.add(_chatBubble(symptom, fromUser: true));
    }
    final answers = _intake?['answers'];
    final questions = _intake?['questions'];
    if (answers is List && questions is List) {
      final ordered = answers.whereType<Map<String, dynamic>>().toList()
        ..sort(
          (a, b) => '${a['answeredAt']}'.compareTo('${b['answeredAt']}'),
        );
      for (final raw in ordered) {
        // 現在表示中の質問はライブの吹き出しで出すため、履歴からは除外する。
        if (raw['questionId'] == _question?['questionId']) continue;
        final match = questions.whereType<Map<String, dynamic>>().where(
          (q) =>
              q['questionId'] == raw['questionId'] &&
              q['questionRevision'] == raw['questionRevision'],
        );
        if (match.length != 1) continue;
        final q = match.single;
        widgets.add(_chatBubble('${q['questionText'] ?? ''}', fromUser: false));
        final options = q['options'];
        final selected = raw['selectedCodes'];
        final labels = options is List && selected is List
            ? options
                  .whereType<Map>()
                  .where((o) => selected.contains(o['code']))
                  .map((o) => '${o['label']}')
                  .join('、')
            : '';
        final answerText = switch (raw['answerState']) {
          'unknown' => 'わからない',
          'skipped' => '答えたくない',
          _ => labels.isEmpty ? '未回答' : labels,
        };
        final free = raw['freeText'];
        widgets.add(
          _chatBubble(
            free is String && free.isNotEmpty
                ? '$answerText\n$free'
                : answerText,
            fromUser: true,
          ),
        );
      }
    }
    return widgets;
  }

  List<Widget> _summaryWidgets() {
    final summary = _summary;
    if (summary == null) return [];
    final chief = summary['chiefComplaint'];
    final sections = summary['sections'];
    final widgets = <Widget>[
      const Text('あなたが伝えたいこと', style: TextStyle(fontWeight: FontWeight.bold)),
      Text(chief is Map ? '${chief['value'] ?? '未回答'}' : '未回答'),
      if (sections is Map)
        ...sections.entries.map(
          (entry) => Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Text(
              '${_topic('${entry.key}')}：${entry.value is Map ? entry.value['value'] ?? '未回答' : '未回答'}',
            ),
          ),
        ),
      const SizedBox(height: 12),
      const Text('記載されていない内容は未回答です。診断結果ではありません。'),
    ];
    if (_step != 'review') return widgets;
    final answers = _intake?['answers'];
    final questions = _intake?['questions'];
    if (answers is! List || questions is! List) return widgets;
    widgets.add(const SizedBox(height: 16));
    widgets.add(
      const Text('保存済みの回答', style: TextStyle(fontWeight: FontWeight.bold)),
    );
    for (final raw in answers) {
      if (raw is! Map<String, dynamic>) continue;
      final question = questions.whereType<Map<String, dynamic>>().where(
        (item) =>
            item['questionId'] == raw['questionId'] &&
            item['questionRevision'] == raw['questionRevision'],
      );
      final editingThisAnswer =
          _editingAnswer?['questionId'] == raw['questionId'];
      final q =
          editingThisAnswer &&
              _latestQuestionForAnswer(questions, raw['questionId']) != null
          ? _latestQuestionForAnswer(questions, raw['questionId'])
          : question.length == 1
          ? question.single
          : null;
      if (q == null) continue;
      final options = q['options'];
      final selected = raw['selectedCodes'];
      final labels = options is List && selected is List
          ? options
                .whereType<Map>()
                .where((option) => selected.contains(option['code']))
                .map((option) => '${option['label']}')
                .join('、')
          : '';
      final answerText = switch (raw['answerState']) {
        'unknown' => 'わからない',
        'skipped' => '答えたくない',
        _ => labels.isEmpty ? '未回答' : labels,
      };
      widgets.add(
        Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  '${q['questionText'] ?? ''}',
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
                Text(answerText),
                if (raw['freeText'] is String &&
                    (raw['freeText'] as String).isNotEmpty)
                  Text(raw['freeText'] as String),
                if (identical(_editingAnswer, raw)) ...[
                  Wrap(
                    spacing: 8,
                    children: [
                      if (options is List)
                        for (final option in options.whereType<Map>())
                          ChoiceChip(
                            label: Text('${option['label']}'),
                            selected:
                                _editingState == 'answered' &&
                                _editingCodes.contains(option['code']),
                            onSelected: _busy || _answerEditNeedsReconcile
                                ? null
                                : (selected) {
                                    setState(() {
                                      _editingState = 'answered';
                                      final code = option['code'] as String;
                                      if (_editingMultiple &&
                                          _editingCodes.contains(code)) {
                                        _editingCodes.remove(code);
                                      } else if (_editingMultiple) {
                                        // Do not silently discard legacy codes.
                                        showDialog<void>(
                                          context: context,
                                          builder: (context) => AlertDialog(
                                            title: const Text(
                                              '回答を単一選択に変更しますか？',
                                            ),
                                            content: const Text(
                                              '以前の複数選択は、この変更で置き換えられます。',
                                            ),
                                            actions: [
                                              TextButton(
                                                onPressed: () =>
                                                    Navigator.pop(context),
                                                child: const Text('戻る'),
                                              ),
                                              FilledButton(
                                                onPressed: () {
                                                  setState(() {
                                                    _editingMultiple = false;
                                                    _editingCodes
                                                      ..clear()
                                                      ..add(code);
                                                  });
                                                  Navigator.pop(context);
                                                },
                                                child: const Text('単一選択に変更'),
                                              ),
                                            ],
                                          ),
                                        );
                                      } else {
                                        _editingCodes
                                          ..clear()
                                          ..add(code);
                                      }
                                    });
                                  },
                          ),
                      for (final state in const {
                        'unknown': 'わからない',
                        'skipped': '答えたくない',
                      }.entries)
                        ChoiceChip(
                          label: Text(state.value),
                          selected: _editingState == state.key,
                          onSelected: _busy || _answerEditNeedsReconcile
                              ? null
                              : (selected) => _changeAnswerState(state.key),
                        ),
                    ],
                  ),
                  TextField(
                    key: const ValueKey('保存済み回答の補足'),
                    controller: _answerFreeText,
                    enabled:
                        !_busy &&
                        !_answerEditNeedsReconcile &&
                        _editingState == 'answered',
                    maxLength: 2000,
                    minLines: 2,
                    maxLines: 4,
                    decoration: const InputDecoration(labelText: '回答の補足'),
                  ),
                  if (!_answerEditNeedsReconcile)
                    _button(
                      '編集内容を保存',
                      _saveAnswerEdit,
                      enabled: !_answerEditQuestionChanged,
                    ),
                  if (_answerEditQuestionChanged)
                    const Text('質問が更新されました。古い回答を送信せず、編集を取り消して最新内容を確認してください。'),
                  if (_answerEditNeedsReconcile)
                    _button('保存状態を再取得', _retryAnswerEditReconcile),
                  TextButton(
                    onPressed: _busy || _answerEditNeedsReconcile
                        ? null
                        : () => setState(() {
                            _editingAnswer = _editingQuestion = null;
                            _editingCodes.clear();
                            _answerEditNeedsReconcile = false;
                            _answerEditOwner = null;
                            _answerEditRevision = null;
                            _answerFreeText.clear();
                          }),
                    child: const Text('編集を取り消す'),
                  ),
                ] else
                  TextButton(
                    onPressed: _busy
                        ? null
                        : () => _run(() => _beginAnswerEdit(raw, q)),
                    child: const Text('回答を編集'),
                  ),
              ],
            ),
          ),
        ),
      );
    }
    return widgets;
  }

  String _topic(String name) =>
      const {
        'onset_timing': '症状が始まった時期',
        'severity': '症状の強さ',
        'frequency': '頻度',
        'life_impact': '生活への影響',
        'associated_symptoms': 'ほかの症状',
        'current_medication': '服薬',
        'medical_history': '持病・既往歴',
        'allergy': 'アレルギー',
      }[name] ??
      'その他';
  List<Widget> _content() => switch (_step) {
    'login' => [
      const Text(
        '医療機関に伝えたいことを、あなたの言葉で。',
        style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold),
      ),
      const SizedBox(height: 12),
      const Text('アカウントをお持ちの方はログインしてください。初めての方は新規登録へ進めます。'),
      if (_registrationRecoveryNotice != null)
        Semantics(liveRegion: true, child: Text(_registrationRecoveryNotice!)),
      _field('メールアドレス', _email),
      _field('パスワード', _password, secret: true),
      FilledButton(onPressed: _busy ? null : _login, child: const Text('ログイン')),
      TextButton(
        onPressed: _busy
            ? null
            : () => _run(() async {
                if (_email.text.trim().isEmpty) {
                  throw const PatientRequestFailure('400');
                }
                try {
                  await widget.resetPassword(_email.text.trim());
                } catch (_) {
                  /* Do not disclose account existence. */
                }
                if (mounted) {
                  setState(() {
                    _notice = '該当するアカウントがあれば、再設定メールを送信します。';
                  });
                }
              }),
        child: const Text('パスワードを再設定'),
      ),
      TextButton(
        onPressed: _busy ? null : () => _run(_beginRegistration),
        child: const Text('初めてご利用の方（新規登録）'),
      ),
    ],
    'verify' => [
      const Text(
        'メールアドレスの確認',
        style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
      ),
      const Text('確認メール内のリンクを開いたあと、「確認状況を更新」を押してください。'),
      _button('確認メールを送信', () async {
        final send = widget.sendEmailVerification;
        if (send == null) throw const PatientRequestFailure('UNAVAILABLE');
        await send();
        if (mounted) {
          setState(() {
            _notice = '確認メールを送信しました。';
          });
        }
      }, enabled: widget.sendEmailVerification != null),
      _button('確認状況を更新', _resumeRegistration),
    ],
    'consent' => [
      const Text(
        'ご利用前の確認',
        style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
      ),
      const Text('各文書を読み、同意する項目を選んでください。医療機関への送信は、問診後に別途確認します。'),
      if (_firstRegistration) ...[
        if (_registrationRecoveryNotice != null)
          Semantics(
            liveRegion: true,
            child: Text(_registrationRecoveryNotice!),
          ),
        _field('メールアドレス', _email, readOnly: _registrationKey != null),
        _field(
          'パスワード（8〜128文字）',
          _password,
          secret: true,
          readOnly: _registrationKey != null,
        ),
      ],
      for (final entry in _legal.entries) ...[
        const SizedBox(height: 20),
        Text(
          '${_legalLabels[entry.key]}（${entry.value['version']}）',
          style: const TextStyle(fontWeight: FontWeight.bold),
        ),
        SelectableText(entry.value['text'] as String),
        CheckboxListTile(
          title: Text('${_legalLabels[entry.key]}に同意する'),
          value: _accepted.contains(entry.key),
          onChanged:
              _busy ||
                  _consentKey != null ||
                  (_firstRegistration && _registrationKey != null)
              ? null
              : (value) => setState(() {
                  if (value == true) {
                    _accepted.add(entry.key);
                  } else {
                    _accepted.remove(entry.key);
                  }
                }),
        ),
      ],
      _button(
        _firstRegistration ? '同意してアカウントを登録' : '同意して登録を続ける',
        _firstRegistration ? _registerAccount : _submitRegistrationConsents,
        enabled: _legal.isNotEmpty && _accepted.containsAll(_legal.keys),
      ),
      if (_firstRegistration)
        TextButton(
          onPressed: _busy ? null : _returnToLogin,
          child: const Text('登録を再送せずログインへ'),
        ),
    ],
    'profile' => [
      const Text(
        'プロフィール登録',
        style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
      ),
      const Text('問診を始める前に必須項目を入力してください。'),
      for (final entry in const {
        'familyName': '姓',
        'givenName': '名',
        'familyNameKana': '姓（カタカナ）',
        'givenNameKana': '名（カタカナ）',
        'birthDate': '生年月日（例：1990-01-01）',
        'phoneNumber': '電話番号',
        'postalCode': '郵便番号（7桁）',
        'prefecture': '都道府県（例：東京都）',
        'city': '市区町村',
        'line1': '町名・番地',
      }.entries)
        _field(entry.value, _profileFields[entry.key]!),
      _button('プロフィールを保存して問診へ', _saveRegistrationProfile),
    ],
    'home' => [
      const Text(
        '今日は、どんなことを伝えたいですか？',
        style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold),
      ),
      const SizedBox(height: 16),
      const Text('症状の入力 → 質問への回答 → 内容の確認 → 施設へ送信'),
      const SizedBox(height: 24),
      _button('新しい問診をはじめる', () async {
        _clear();
        setState(() {
          _step = 'symptom';
        });
      }),
      _button('過去の問診票を見る', _loadHistory),
    ],
    'symptom' => [
      const Text(
        '気になる症状を入力',
        style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
      ),
      const Text('いつから、どこが、どのようにつらいか、書ける範囲で入力してください。'),
      _field('症状（1〜1000文字）', _symptom, lines: 5, readOnly: _createKey != null),
      DropdownButtonFormField<String>(
        initialValue: _bodyLocation,
        decoration: const InputDecoration(labelText: '気になる部位'),
        items:
            const {
                  'whole_body': '全身・特定できない',
                  'head': '頭',
                  'throat': '喉',
                  'chest': '胸',
                  'abdomen': 'お腹',
                  'upper_back': '背中',
                  'lower_back': '腰',
                  'skin': '皮膚',
                  'other': 'その他',
                }.entries
                .map(
                  (e) => DropdownMenuItem(value: e.key, child: Text(e.value)),
                )
                .toList(),
        onChanged: _busy || _createKey != null
            ? null
            : (v) => setState(() {
                _bodyLocation = v!;
              }),
      ),
      _button(_createKey == null ? '保存して質問へ進む' : '保存状態を再確認', _saveSymptoms),
    ],
    'question' => [
      // 会話トランスクリプト（これまでの症状・質問・回答）をチャット表示。
      ..._chatTranscript(),
      // 現在の質問をアシスタントの最新の吹き出しとして表示。
      _chatBubble(
        '${_question?['questionText'] ?? ''}',
        fromUser: false,
        emphasis: true,
        header: true,
      ),
      const SizedBox(height: 8),
      // 回答コンポーザ（選択肢・自由記述・わからない・答えたくない）。
      ...((_question?['options'] as List?) ?? []).whereType<Map>().map(
        (o) => _button(
          '${o['label']}',
          () => _answer('${o['code']}', 'answered'),
          enabled: !_answerAttempted,
        ),
      ),
      TextField(
        key: const ValueKey('回答（任意）'),
        controller: _answerFreeText,
        enabled: !_busy && !_answerAttempted,
        minLines: 3,
        maxLines: 6,
        inputFormatters: const [_Utf16LengthLimitingTextInputFormatter(2000)],
        decoration: const InputDecoration(
          labelText: '回答（任意）',
          helperText: '選択肢に補足したいことがあれば入力してください（最大2000文字分。絵文字などは2文字分）',
          border: OutlineInputBorder(),
        ),
      ),
      _button(
        'わからない',
        () => _answer(null, 'unknown'),
        enabled: !_answerAttempted,
      ),
      _button(
        '答えたくない',
        () => _answer(null, 'skipped'),
        enabled: !_answerAttempted,
      ),
      if (_answerUncertain)
        Semantics(
          liveRegion: true,
          child: Text(
            _answerKeyExpiresAt != null &&
                    !api.now().isBefore(_answerKeyExpiresAt!)
                ? '回答の保存結果を確認できません。再送可能期間が終了したため再送を停止しました。問診を続けず、サポートへお問い合わせください。'
                : '回答の保存結果を確認できません。同じ回答を再送して保存状態を再確認できます。',
          ),
        )
      else
        TextButton(
          onPressed: _busy ? null : () => _run(_nextQuestion),
          child: const Text('保存状態を再確認'),
        ),
      if (_answerUncertain &&
          _answerKeyExpiresAt != null &&
          api.now().isBefore(_answerKeyExpiresAt!))
        TextButton(
          onPressed: _busy ? null : () => _run(_retryPendingAnswer),
          child: const Text('同じ回答を再送して確認'),
        ),
    ],
    'review' => [
      const Text(
        '送信前に内容を確認',
        style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
      ),
      ..._summaryWidgets(),
      CheckboxListTile(
        value: _reviewed,
        onChanged: _busy
            ? null
            : (v) => setState(() {
                _reviewed = v!;
              }),
        title: const Text('問診の内容を確認しました'),
        controlAffinity: ListTileControlAffinity.leading,
      ),
      _button('この内容で問診票を確定', _finalize, enabled: _reviewed),
    ],
    'send' => [
      const Text(
        '送信先と共有内容を確認',
        style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
      ),
      ..._summaryWidgets(),
      const Divider(height: 32),
      _field('施設コード', _facilityId, readOnly: _sendKey != null),
      _button('施設を確認', _loadFacility, enabled: _sendKey == null),
      if (_facility != null) ...[
        Text(
          '${_facility!['displayName']}',
          style: const TextStyle(fontWeight: FontWeight.bold),
        ),
        Text('${_facility!['formattedAddress'] ?? ''}'),
        if (_facility!['syntheticRecipient'] == true)
          const Text('合成デモ施設です。実際の医療機関ではありません。'),
        if ((_facility!['verificationStatus'] != 'verified' &&
                _facility!['syntheticRecipient'] != true) ||
            _facility!['receivingEnabled'] != true)
          const Text('この施設は現在受け付けていません。送信できません。'),
        CheckboxListTile(
          value: _profile,
          onChanged: _busy || _sendKey != null
              ? null
              : (v) => setState(() {
                  _profile = v!;
                }),
          title: const Text('氏名・連絡先と持病を一緒に共有する'),
          controlAffinity: ListTileControlAffinity.leading,
        ),
        CheckboxListTile(
          value: _medications,
          onChanged: _busy || _sendKey != null
              ? null
              : (v) => setState(() {
                  _medications = v!;
                }),
          title: const Text('確認済みの薬剤情報を共有する'),
          controlAffinity: ListTileControlAffinity.leading,
        ),
        CheckboxListTile(
          value: _share,
          onChanged: _busy || _sendKey != null
              ? null
              : (v) => setState(() {
                  _share = v!;
                }),
          title: Text(
            '「${_facility!['displayName']}」へ、この問診票と選択した情報を送信することに同意します',
          ),
          controlAffinity: ListTileControlAffinity.leading,
        ),
        _button(
          _sendKey == null ? '同意した施設へ送信' : '同じ送信の結果を再確認',
          _send,
          enabled:
              _share &&
              (_facility!['verificationStatus'] == 'verified' ||
                  _facility!['syntheticRecipient'] == true) &&
              _facility!['receivingEnabled'] == true,
        ),
      ],
    ],
    'delivery' => [
      const Icon(Icons.check_circle_outline, size: 56, color: Colors.teal),
      const Text(
        '送信状況',
        style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold),
      ),
      Text(switch (_delivery?['status']) {
        'created' => '受付済み・配送処理中',
        'delivered' => '施設の受信箱へ届きました',
        'acknowledged' => '施設が受領を確認しました',
        'failed' => '配送に失敗しました',
        'revoked' => '送信は取り消されました',
        _ => '状況を確認してください',
      }),
      const Text('受信・受領確認は診察や予約の確定ではありません。'),
      _button('送信状況を更新', _refreshDelivery),
      _button('ホームへ戻る', () async {
        _clear();
        setState(() {
          _step = 'home';
        });
      }),
    ],
    'history' => [
      const Text(
        '過去の問診票',
        style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold),
      ),
      if (_history.isEmpty) const Text('確定した問診票はまだありません。'),
      ..._history.whereType<Map>().map(
        (row) => Card(
          child: ListTile(
            title: const Text('確定済み問診票'),
            subtitle: Text('${row['finalizedAt'] ?? ''}'),
            trailing: const Icon(Icons.chevron_right),
            onTap: _busy ? null : () => _run(() => _openQuestionnaire(row)),
          ),
        ),
      ),
    ],
    _ => [],
  };
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('もしもし問診'),
      actions: [
        if (_step != 'login')
          TextButton(
            onPressed: _busy ? null : () => _run(widget.signOut),
            child: const Text('ログアウト'),
          ),
      ],
    ),
    body: SafeArea(
      child: SingleChildScrollView(
        controller: _scroll,
        padding: const EdgeInsets.all(24),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 680),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: Theme.of(context)
                        .colorScheme
                        .surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Text('確認用公開版です。架空の情報でお試しください。診断・治療・予約は行いません。'),
                ),
                const SizedBox(height: 24),
                if (_busy) const LinearProgressIndicator(),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Semantics(
                      liveRegion: true,
                      child: Text(
                        _error!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ),
                  ),
                if (_notice != null)
                  Semantics(liveRegion: true, child: Text(_notice!)),
                ..._content(),
                if (![
                  'login',
                  'home',
                  'verify',
                  'consent',
                  'profile',
                ].contains(_step))
                  TextButton(
                    onPressed: _busy
                        ? null
                        : () => setState(() {
                            _step = 'home';
                          }),
                    child: const Text('ホームへ'),
                  ),
                const SizedBox(height: 24),
                const Text(
                  '問診は医療機関へ伝える情報を整理するものです。',
                  style: TextStyle(fontSize: 16),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
