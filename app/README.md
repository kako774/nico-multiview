# ニコ生マルチビュー(アプリのソース)

ニコニコ生放送を複数枠まとめて同時視聴する Windows 用デスクトップアプリ(Electron)です。
使い方は、配布フォルダの `使い方.html` か、[サイト](https://nico-multiview.pages.dev) を見てください。

## 動かす(開発用)
1. [Node.js](https://nodejs.org/)(LTS)をインストール
2. このフォルダで `npm install` のあと `npm start`(Windows は `start.bat` をダブルクリックでも可)

## ビルド(配布用のフォルダを作る)
```
npm install
npx electron-builder --win dir --x64
```
`dist/win-unpacked/` に `NicoMultiView.exe` ができます。フォルダごと zip にして配布します。

- `resources/app.asar` と `NicoMultiView.exe` は、必ずセットでコピーしてください(exe に asar の整合性ハッシュが入っています)。
- `package.json` の `signAndEditExecutable` を `false` にしているため、exe のアイコンはビルドでは入りません。Windows 以外でビルドするときは、`icon.ico` を [resedit](https://www.npmjs.com/package/resedit) などで exe に書き込んでください。
- Electron と Chromium のライセンス(`LICENSE.electron.txt` / `LICENSES.chromium.html`)は、配布フォルダに必ず残してください。

## ファイル
| ファイル | 役割 |
|---|---|
| `main.js` | メインプロセス。枠(ネイティブのビュー)の管理、ログイン、検索、ギフトイベントの順位取得、メニュー |
| `ui.html` / `preload.js` | ツールバーと枠の一覧(画面) |
| `view-preload.js` | 各枠(ニコ生の視聴ページ)の中で動く。ドラッグ検出、コメント収集、ダブルクリック |
| `menu.html` / `menu-preload.js` | 映像の上に重ねるメニュー(ギフトイベント、枠の保存、検索候補) |
| `viewer.html` / `viewer-preload.js` | 統合コメントビューア |
| `exit-preload.js` | 全画面中の「全画面を終了」ボタン |

## 注意
非公式のツールです。ニコニコの公式に公開されていない通信を使っているため、仕様が変わると動かなくなることがあります。
