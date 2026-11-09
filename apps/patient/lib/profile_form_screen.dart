import 'package:flutter/material.dart';

/// PATCH /v1/me/profile の address.prefecture と一致させる都道府県一覧。
const _prefectures = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県',
  '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県',
  '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

typedef ProfileSubmit = Future<void> Function(Map<String, Object> patch);

/// プロフィール登録（P-006）。
///
/// [onSubmit] を渡すと実接続モードになり、必須項目の入力後に
/// `PATCH /v1/me/profile` 相当のマップを返す。保存結果の確認・画面遷移は
/// 呼び出し側の責務。未指定時は従来どおりの未接続プレビュー表示になる。
/// 妥当性ルールは API の profilePatchSchema に合わせる（docs/03 §3.2）。
class ProfileFormScreen extends StatefulWidget {
  const ProfileFormScreen({super.key, this.onSubmit, this.onSignOut});

  /// 接続時の保存コールバック。例外は失敗として画面内に表示する。
  final ProfileSubmit? onSubmit;

  /// ログアウト導線。接続時にオンボーディング途中のユーザーが
  /// サインアウトできるようにする。
  final VoidCallback? onSignOut;

  @override
  State<ProfileFormScreen> createState() => _ProfileFormScreenState();
}

class _ProfileFormScreenState extends State<ProfileFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _lastName = TextEditingController();
  final _firstName = TextEditingController();
  final _lastKana = TextEditingController();
  final _firstKana = TextEditingController();
  final _birthday = TextEditingController();
  final _phone = TextEditingController();
  final _postalCode = TextEditingController();
  final _city = TextEditingController();
  final _line1 = TextEditingController();
  final _line2 = TextEditingController();
  final _conditions = TextEditingController();
  String? _prefecture;
  bool _busy = false;
  String? _message;

  static final _kanaPattern = RegExp(r'^[ァ-ヶー・\s]+$');
  static final _datePattern = RegExp(r'^\d{4}-\d{2}-\d{2}$');

  bool get _connected => widget.onSubmit != null;

  @override
  void dispose() {
    for (final c in [
      _lastName,
      _firstName,
      _lastKana,
      _firstKana,
      _birthday,
      _phone,
      _postalCode,
      _city,
      _line1,
      _line2,
      _conditions,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(
        title: Text(_connected ? 'プロフィール登録' : 'プロフィール登録デモ'),
        actions: [
          if (_connected && widget.onSignOut != null)
            IconButton(
              onPressed: widget.onSignOut,
              icon: const Icon(Icons.logout),
              tooltip: 'ログアウト',
            ),
        ],
      ),
      body: SafeArea(
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (!_connected) ...[
                  const Text('架空のデモです。実在する個人情報は入力しないでください。'),
                  const Text('入力は画面内に保持されますが、保存（送信）はされません。'),
                  const SizedBox(height: 8),
                  const Text('この画面は、必須の同意が済んだあとに利用できます。'),
                ] else ...[
                  const Text('利用登録に必要な項目を入力してください。実患者情報は入力しないでください。'),
                ],
                const SizedBox(height: 16),
                Text('必須の項目', style: textTheme.titleMedium),
                const SizedBox(height: 8),
                _field(_lastName, '姓（必須）', _required('姓と名を入力してください')),
                _field(_firstName, '名（必須）', _required('姓と名を入力してください')),
                _field(_lastKana, '姓カナ（必須）', _kana),
                _field(_firstKana, '名カナ（必須）', _kana),
                _field(_birthday, '生年月日（必須・例 1950-01-01）', _birth),
                _field(_phone, '電話番号（必須）', _phoneValidator),
                _field(_postalCode, '郵便番号（必須・7桁）', _postal),
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: DropdownButtonFormField<String>(
                    initialValue: _prefecture,
                    decoration: const InputDecoration(
                      labelText: '都道府県（必須）',
                      border: OutlineInputBorder(),
                    ),
                    items: [
                      for (final p in _prefectures)
                        DropdownMenuItem(value: p, child: Text(p)),
                    ],
                    onChanged: _busy
                        ? null
                        : (value) => setState(() => _prefecture = value),
                    validator: (value) =>
                        value == null ? '都道府県を選んでください' : null,
                  ),
                ),
                _field(_city, '市区町村（必須）', _required('市区町村を入力してください')),
                _field(
                  _line1,
                  '番地・建物名など（必須）',
                  _required('住所を入力してください'),
                ),
                _field(_line2, '建物名・部屋番号（任意）', null),
                const SizedBox(height: 16),
                Text('任意の項目', style: textTheme.titleMedium),
                const SizedBox(height: 8),
                _field(
                  _conditions,
                  '持病（任意・なくても構いません）',
                  _conditionsValidator,
                  maxLines: 3,
                ),
                const SizedBox(height: 16),
                if (!_connected)
                  const Text('保存（PATCH /me/profile）はこのデモでは未接続です。'),
                if (_message != null)
                  Semantics(liveRegion: true, child: Text(_message!)),
                if (_busy) const Text('処理中…'),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: _busy ? null : _submit,
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(48, 48),
                      textStyle: const TextStyle(fontSize: 20),
                    ),
                    child: const Text('この内容で登録する'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _field(
    TextEditingController controller,
    String label,
    String? Function(String?)? validator, {
    int maxLines = 1,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextFormField(
        controller: controller,
        enabled: !_busy,
        validator: validator,
        maxLines: maxLines,
        decoration: InputDecoration(
          labelText: label,
          border: const OutlineInputBorder(),
        ),
      ),
    );
  }

  String? Function(String?) _required(String message) {
    return (value) => (value == null || value.trim().isEmpty) ? message : null;
  }

  String? _kana(String? value) {
    final text = value?.trim() ?? '';
    if (text.isEmpty || !_kanaPattern.hasMatch(text)) {
      return 'カタカナで入力してください';
    }
    return null;
  }

  String? _postal(String? value) {
    final digits = (value ?? '').replaceAll(RegExp(r'[\s\-ー－―]'), '').trim();
    if (digits.length != 7 || int.tryParse(digits) == null) {
      return '7桁の郵便番号を入力してください';
    }
    return null;
  }

  String? _phoneValidator(String? value) {
    final digits = (value ?? '').replaceAll(RegExp(r'[\s\-()（）ー－―]'), '');
    if (!RegExp(r'^0\d{9,10}$').hasMatch(digits)) {
      return '電話番号をご確認ください';
    }
    return null;
  }

  String? _birth(String? value) {
    final text = value?.trim() ?? '';
    if (!_datePattern.hasMatch(text)) return '正しい日付を選んでください';
    final year = int.parse(text.substring(0, 4));
    final month = int.parse(text.substring(5, 7));
    final day = int.parse(text.substring(8, 10));
    final date = DateTime.utc(year, month, day);
    // サーバ側は UTC 基準で「当日より前」を要求するため、クライアントも
    // UTC の日付で同じ境界を使う（当日入力をサーバ拒否で弾かない）。
    final nowUtc = DateTime.now().toUtc();
    final todayUtc = DateTime.utc(nowUtc.year, nowUtc.month, nowUtc.day);
    if (date.year != year ||
        date.month != month ||
        date.day != day ||
        !date.isBefore(todayUtc)) {
      return '正しい日付を選んでください';
    }
    return null;
  }

  /// 持病欄。改行・読点・カンマで区切り、API 上限（20件・各100文字）を検証する。
  /// 超過分を暗黙に捨てないよう、超過時はバリデーションエラーにする。
  String? _conditionsValidator(String? value) {
    final entries = (value ?? '')
        .split(RegExp(r'[\n、,，]'))
        .map((s) => s.trim())
        .where((s) => s.isNotEmpty)
        .toList();
    if (entries.length > 20) {
      return '持病は20件以内で入力してください';
    }
    if (entries.any((s) => s.length > 100)) {
      return '持病は1件100文字以内で入力してください';
    }
    return null;
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    if (!_connected) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('（デモ）入力内容は保存・送信されません。')),
      );
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    final history = _conditions.text
        .split(RegExp(r'[\n、,，]'))
        .map((s) => s.trim())
        .where((s) => s.isNotEmpty)
        .toList();
    final patch = <String, Object>{
      'familyName': _lastName.text.trim(),
      'givenName': _firstName.text.trim(),
      'familyNameKana': _lastKana.text.trim(),
      'givenNameKana': _firstKana.text.trim(),
      'birthDate': _birthday.text.trim(),
      'phoneNumber': _phone.text
          .trim()
          .replaceAll(RegExp(r'[\s\-()（）ー－―]'), ''),
      'postalCode': _postalCode.text
          .trim()
          .replaceAll(RegExp(r'[\s\-ー－―]'), ''),
      'address': {
        'prefecture': _prefecture!,
        'city': _city.text.trim(),
        'line1': _line1.text.trim(),
        if (_line2.text.trim().isNotEmpty) 'line2': _line2.text.trim(),
      },
      if (history.isNotEmpty) 'medicalHistory': history,
    };
    try {
      await widget.onSubmit!(patch);
    } catch (_) {
      if (mounted) {
        setState(() => _message = '保存できませんでした。時間をおいて再試行してください。');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}
