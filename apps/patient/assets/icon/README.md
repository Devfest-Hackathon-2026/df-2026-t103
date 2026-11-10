# もしもし問診のアプリアイコン

`source.png` は2026-11-09にオーナーがアイコンとして指定した画像の原本です。
SHA256: `5d6cfe5801ee7323fc96b7dc746747c0f044063b01f7764bfc05e270ed3df7a7`。
原本の文字・配色・構図を保持して各プラットフォーム用サイズへ展開します。

患者アプリ直下で次を実行します。

```sh
dart run tool/generate_app_icon.dart
```

Androidのadaptive foregroundとWebのmaskableアイコンには、全体が安全領域に入る余白を加えます。
iOS用は白背景の不透明PNGです。`app_icon.png` や各OSの出力を直接編集せず、素材と生成処理を更新してください。
`render_ios_icon.swift` は起動画像専用です。
