import 'package:flutter/material.dart';

enum EmailAuthResult { success, failure, cancelled }

/// The caller must supply the current, approved document, not placeholder text.
class AuthLegalDocument {
  const AuthLegalDocument({required this.version, required this.body});

  final String version;
  final String body;

  bool get isUsable =>
      version.trim().isNotEmpty &&
      version.length <= 100 &&
      body.trim().isNotEmpty;
}

class RegistrationDocuments {
  const RegistrationDocuments({
    required this.terms,
    required this.privacy,
    required this.health,
  });

  final AuthLegalDocument terms;
  final AuthLegalDocument privacy;
  final AuthLegalDocument health;

  bool get isUsable => terms.isUsable && privacy.isUsable && health.isUsable;
}

typedef EmailLogin = Future<EmailAuthResult> Function(
  String email,
  String password,
);
typedef EmailRegister = Future<EmailAuthResult> Function(
  String email,
  String password,
  Map<String, Map<String, Object>> consents,
);

/// UI only: the caller owns document provenance, API access and navigation.
class EmailAuthForm extends StatefulWidget {
  const EmailAuthForm({
    super.key,
    this.documents,
    this.onLogin,
    this.onRegister,
  });

  final RegistrationDocuments? documents;
  final EmailLogin? onLogin;
  final EmailRegister? onRegister;

  @override
  State<EmailAuthForm> createState() => _EmailAuthFormState();
}

class _EmailAuthFormState extends State<EmailAuthForm> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _accepted = [false, false, false];
  bool _register = false;
  bool _busy = false;
  String? _message;

  @override
  void didUpdateWidget(covariant EmailAuthForm oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A new document bundle requires fresh, explicit choices.
    if (oldWidget.documents != widget.documents) {
      _accepted.fillRange(0, _accepted.length, false);
    }
  }

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy || !_formKey.currentState!.validate()) return;
    final documents = widget.documents;
    if (_register &&
        (documents == null ||
            !documents.isUsable ||
            _accepted.any((value) => !value) ||
            widget.onRegister == null)) {
      return;
    }
    if (!_register && widget.onLogin == null) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final result = _register
          ? await widget.onRegister!(_email.text.trim(), _password.text, {
              'terms_of_service': {
                'accepted': true,
                'documentVersion': documents!.terms.version,
              },
              'privacy_policy_ack': {
                'accepted': true,
                'documentVersion': documents.privacy.version,
              },
              'health_data_collection': {
                'accepted': true,
                'documentVersion': documents.health.version,
              },
            })
          : await widget.onLogin!(_email.text.trim(), _password.text);
      if (!mounted) return;
      setState(() {
        _message = switch (result) {
          EmailAuthResult.success => null,
          EmailAuthResult.failure => '処理に失敗しました。もう一度お試しください。',
          EmailAuthResult.cancelled => '処理はキャンセルされました。',
        };
      });
    } catch (_) {
      if (mounted) setState(() => _message = '処理に失敗しました。もう一度お試しください。');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final docs = widget.documents;
    final available = docs != null && docs.isUsable;
    final canSubmit =
        !_busy &&
        (_register
            ? available &&
                  widget.onRegister != null &&
                  _accepted.every((v) => v)
            : widget.onLogin != null);
    return Form(
      key: _formKey,
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
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
            TextFormField(
              controller: _email,
              enabled: !_busy,
              keyboardType: TextInputType.emailAddress,
              autofillHints: const [AutofillHints.email],
              decoration: const InputDecoration(labelText: 'メールアドレス'),
              validator: (value) => value == null || value.trim().isEmpty
                  ? 'メールアドレスを入力してください。'
                  : null,
            ),
            TextFormField(
              controller: _password,
              enabled: !_busy,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'パスワード'),
              validator: (value) {
                if (value == null || value.isEmpty) return 'パスワードを入力してください。';
                if (_register &&
                    (value.length < 8 ||
                        value.length > 128 ||
                        !RegExp(r'[A-Za-z]').hasMatch(value) ||
                        !RegExp(r'[0-9]').hasMatch(value))) {
                  return 'パスワードは8〜128文字で英字と数字を含めてください。';
                }
                return null;
              },
            ),
            if (_register && !available) const Text('正式な同意文書は未接続です。登録できません。'),
            if (_register && available) ...[
              for (final (index, title, doc) in [
                (0, '利用規約に同意する（必須）', docs.terms),
                (1, 'プライバシー説明を確認する（必須）', docs.privacy),
                (2, '医療情報の取得に同意する（必須）', docs.health),
              ]) ...[
                Text('文書版: ${doc.version}'),
                Text(doc.body),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(title),
                  value: _accepted[index],
                  onChanged: _busy
                      ? null
                      : (value) =>
                            setState(() => _accepted[index] = value == true),
                ),
              ],
            ],
            if ((_register ? widget.onRegister : widget.onLogin) == null)
              const Text('認証は未接続です。'),
            if (_message != null)
              Semantics(liveRegion: true, child: Text(_message!)),
            if (_busy) const Text('処理中…'),
            ElevatedButton(
              onPressed: canSubmit ? _submit : null,
              child: Text(_register ? '登録する' : 'ログインする'),
            ),
          ],
        ),
      ),
    );
  }
}
