# もしもし問診のアプリアイコン

`source.png` は2026-11-10にオーナーがアイコンとして指定したJPEG画像をPNGへ変換した素材です。
指定JPEGのSHA256: `75eec08fb99e2eacf2dcd6e45371b5ff25efd2a2e81c44dbbc81809e9c68beeb`。
PNGのSHA256: `f968cf7d4054ecac499a65024542b6b040d6e05355d58ba2b05fb15819d89fab`。
原本の文字・配色・構図を保持して各プラットフォーム用サイズへ展開します。

患者アプリ直下で次を実行します。

```sh
dart run tool/generate_app_icon.dart
```

Androidのadaptive foregroundとWebのmaskableアイコンには、全体が安全領域に入る余白を加えます。
iOS用は白背景の不透明PNGです。`app_icon.png` や各OSの出力を直接編集せず、素材と生成処理を更新してください。
`render_ios_icon.swift` は起動画像専用です。
