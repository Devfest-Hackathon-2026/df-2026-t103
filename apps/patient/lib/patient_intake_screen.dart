import 'dart:async';

import 'package:flutter/material.dart';

import 'intake_question_flow.dart';
import 'patient_intake_api.dart';

class PatientIntakeScreen extends StatefulWidget {
  const PatientIntakeScreen({
    super.key,
    required this.api,
    required this.signIn,
    required this.signOut,
    required this.sessionChanges,
  });
  final PatientIntakeApi api;
  final Future<void> Function(String email, String password) signIn;
  final Future<void> Function() signOut;
  final Stream<void> sessionChanges;

  @override
  State<PatientIntakeScreen> createState() => _PatientIntakeScreenState();
}

class _PatientIntakeScreenState extends State<PatientIntakeScreen> {
  static const _bodyLocationOptions = <(String, String)>[
    ('head', '頭'),
    ('face', '顔'),
    ('neck', '首'),
    ('throat', 'のど'),
    ('chest', '胸'),
    ('abdomen', 'お腹'),
    ('upper_back', '背中（上部）'),
    ('lower_back', '腰・背中（下部）'),
    ('left_shoulder', '左肩'),
    ('right_shoulder', '右肩'),
    ('left_arm', '左腕'),
    ('right_arm', '右腕'),
    ('left_hand', '左手'),
    ('right_hand', '右手'),
    ('left_leg', '左脚'),
    ('right_leg', '右脚'),
    ('left_knee', '左膝'),
    ('right_knee', '右膝'),
    ('left_foot', '左足'),
    ('right_foot', '右足'),
    ('skin', '皮膚'),
    ('whole_body', '全身'),
    ('other', 'その他'),
  ];
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _symptoms = TextEditingController();
  final Set<String> _bodyLocations = {};
  late final StreamSubscription<void> _subscription;
  bool _ready = false, _busy = false, _saved = false;
  int _generation = 0;
  String? _message;
  IntakeSubmission? _submission;
  int? _startRevision;

  @override
  void initState() {
    super.initState();
    _subscription = widget.sessionChanges.listen((_) {
      if (!mounted) return;
      setState(() {
        _generation++;
        _ready = false;
        _saved = false;
        _submission = null;
        _startRevision = null;
        _symptoms.clear();
        _bodyLocations.clear();
        _message = null;
      });
    });
  }

  @override
  void dispose() {
    _subscription.cancel();
    _email.dispose();
    _password.dispose();
    _symptoms.dispose();
    super.dispose();
  }

  Future<void> _login() async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await widget.signIn(_email.text.trim(), _password.text);
      _password.clear();
      final generation = _generation;
      await widget.api.requireReady();
      if (!mounted || generation != _generation) return;
      setState(() {
        _ready = true;
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _message =
              'ログインまたは利用状態を確認できません。メール認証・同意・プロフィール登録の完了したアカウントを使用してください。';
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

  Future<void> _save() async {
    final text = _symptoms.text.trim();
    if (text.isEmpty) {
      setState(() {
        _message = '症状を入力してください。';
      });
      return;
    }
    _submission ??= IntakeSubmission(
      text,
      bodyLocations: _bodyLocations.toList(),
    );
    final generation = _generation;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final revision = await widget.api.submit(_submission!);
      if (!mounted || generation != _generation) return;
      setState(() {
        _saved = true;
        _startRevision = revision;
        _symptoms.clear();
      });
    } catch (error) {
      if (mounted && generation == _generation) {
        setState(() {
          if (error is IntakeApiException && error.code == 'INVALID_INPUT') {
            _submission = null;
            _message = '症状を1〜1000文字で入力してください。記号だけでは保存できません。';
          } else {
            _message = '保存結果を確認できません。再試行すると同じ内容の保存状態を確認します。';
          }
        });
      }
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('もしもし問診'),
      actions: [
        TextButton(
          onPressed: _busy
              ? null
              : () async {
                  try {
                    await widget.signOut();
                  } catch (_) {
                    if (mounted) {
                      setState(() {
                        _message = 'ログアウトできません。再試行してください。';
                      });
                    }
                  }
                },
          child: const Text('ログアウト'),
        ),
      ],
    ),
    body: SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 600),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('症状を入力し、問診の下書きに保存します。診断・治療・予約は行いません。'),
                const SizedBox(height: 24),
                if (!_ready) ...[
                  const Text('登録・メール認証・同意・プロフィール登録を完了したアカウントでログインしてください。'),
                  TextField(
                    controller: _email,
                    enabled: !_busy,
                    keyboardType: TextInputType.emailAddress,
                    autocorrect: false,
                    decoration: const InputDecoration(labelText: 'メールアドレス'),
                  ),
                  TextField(
                    controller: _password,
                    enabled: !_busy,
                    obscureText: true,
                    autocorrect: false,
                    enableSuggestions: false,
                    decoration: const InputDecoration(labelText: 'パスワード'),
                  ),
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: _busy ? null : _login,
                    child: const Text('ログイン'),
                  ),
                ] else if (_saved &&
                    _submission != null &&
                    _startRevision != null) ...[
                  const Text('症状を保存しました。続けて質問にお答えください。'),
                  const SizedBox(height: 16),
                  IntakeQuestionFlow(
                    api: widget.api,
                    submission: _submission!,
                    startRevision: _startRevision!,
                  ),
                ] else ...[
                  TextField(
                    controller: _symptoms,
                    readOnly: _busy || _submission != null,
                    minLines: 4,
                    maxLines: 8,
                    maxLength: 1000,
                    decoration: const InputDecoration(
                      labelText: '症状（必須）',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 16),
                  const Text('気になる部位（複数選択可・未選択でも可）'),
                  for (final (code, label) in _bodyLocationOptions)
                    CheckboxListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text(label),
                      value: _bodyLocations.contains(code),
                      onChanged: _busy || _submission != null
                          ? null
                          : (selected) => setState(() {
                              if (selected == true) {
                                _bodyLocations.add(code);
                              } else {
                                _bodyLocations.remove(code);
                              }
                            }),
                    ),
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: _busy ? null : _save,
                    child: Text(_submission == null ? '症状を保存' : '保存状態を再確認'),
                  ),
                ],
                if (_busy) const LinearProgressIndicator(),
                if (_message != null)
                  Semantics(liveRegion: true, child: Text(_message!)),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
