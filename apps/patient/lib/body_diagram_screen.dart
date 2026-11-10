import 'package:flutter/material.dart';

/// 人体図の向き。
enum BodySide { front, back }

/// symptoms API に接続しない身体図（P-011）のプレビュー。
///
/// 前面／背面を切り替え、部位を複数タップで選べる人体図（簡易図）を提供する。
/// 空間的な操作が難しい利用者向けに、同じ部位を文字から選べる代替手段も用意し、
/// 部位が分からなくてもスキップして続行できる（docs/03 §3.4、FR-I02）。選択は
/// メモリ上のみで、保存・送信（symptoms API）は未接続。
class BodyDiagramScreen extends StatefulWidget {
  const BodyDiagramScreen({super.key});

  @override
  State<BodyDiagramScreen> createState() => _BodyDiagramScreenState();
}

class _BodyDiagramScreenState extends State<BodyDiagramScreen> {
  // 各向きの部位。左右は患者本人から見た左右。
  static const _regions = {
    BodySide.front: ['頭', '首', '胸', 'お腹', '左腕', '右腕', '左脚', '右脚'],
    BodySide.back: ['後頭部', '首のうしろ', '背中', '腰', '左腕', '右腕', '左脚', '右脚'],
  };

  BodySide _side = BodySide.front;
  // 向きで区別するため「前面: 胸」の形式で保持する。
  final Set<String> _selected = {};

  String _key(BodySide side, String region) =>
      '${side == BodySide.front ? '前面' : '背面'}: $region';

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final regions = _regions[_side]!;
    return Scaffold(
      appBar: AppBar(title: const Text('身体図デモ')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('架空のデモです。選択はメモリ上のみで、保存も送信もされません。'),
              const Text('左右は、患者本人から見た左右です。部位が分からなければスキップできます。'),
              const SizedBox(height: 16),
              Semantics(
                header: true,
                child: Text('気になる部位を選んでください', style: textTheme.titleLarge),
              ),
              const SizedBox(height: 12),
              // 前面／背面の切り替え。
              Row(
                children: [
                  for (final side in BodySide.values)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: ChoiceChip(
                        label: Text(side == BodySide.front ? '前面' : '背面'),
                        selected: _side == side,
                        onSelected: (_) => setState(() => _side = side),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              // 簡易の人体図（部位を配置したタップ領域）。
              _BodyFigure(
                regions: regions,
                isSelected: (region) => _selected.contains(_key(_side, region)),
                onTap: (region) => _toggle(_side, region),
              ),
              const SizedBox(height: 16),
              // 文字による代替選択。
              ExpansionTile(
                title: const Text('文字で選ぶ（図が使いにくいとき）'),
                children: [
                  for (final side in BodySide.values)
                    for (final region in _regions[side]!)
                      CheckboxListTile(
                        title: Text(
                          '${side == BodySide.front ? '前面' : '背面'}の$region',
                        ),
                        value: _selected.contains(_key(side, region)),
                        onChanged: (_) => _toggle(side, region),
                      ),
                ],
              ),
              const SizedBox(height: 16),
              Text(
                _selected.isEmpty
                    ? '未選択（部位が分からない場合はこのまま進めます）'
                    : '選択中: ${(_selected.toList()..sort()).join('、')}',
              ),
              const SizedBox(height: 16),
              const Text('保存・次の画面（symptoms API）はこのデモでは未接続です。'),
              const ElevatedButton(onPressed: null, child: Text('次へ')),
            ],
          ),
        ),
      ),
    );
  }

  void _toggle(BodySide side, String region) {
    final key = _key(side, region);
    setState(() {
      if (!_selected.add(key)) _selected.remove(key);
    });
  }
}

/// 部位を体の配置に近い形で並べた簡易人体図。
class _BodyFigure extends StatelessWidget {
  const _BodyFigure({
    required this.regions,
    required this.isSelected,
    required this.onTap,
  });

  final List<String> regions;
  final bool Function(String) isSelected;
  final ValueChanged<String> onTap;

  @override
  Widget build(BuildContext context) {
    // 体の配置に近い順で表示（頭→首→腕・胴→脚）。存在する部位だけ並べる。
    Widget chip(String region) => Padding(
          padding: const EdgeInsets.all(4),
          child: FilterChip(
            label: Text(region),
            selected: isSelected(region),
            onSelected: (_) => onTap(region),
          ),
        );

    final has = regions.toSet();
    Widget rowOf(List<String> names) => Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            for (final n in names)
              if (has.contains(n)) chip(n),
          ],
        );

    return Container(
      padding: const EdgeInsets.symmetric(vertical: 12),
      decoration: BoxDecoration(
        border: Border.all(color: Theme.of(context).dividerColor),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        children: [
          rowOf(['頭', '後頭部']),
          rowOf(['首', '首のうしろ']),
          rowOf(['左腕', '胸', '背中', '右腕']),
          rowOf(['お腹', '腰']),
          rowOf(['左脚', '右脚']),
        ],
      ),
    );
  }
}
