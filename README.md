# MultiPane Browser

1つのウィンドウに最大10ペインを並べられる、Chromium（Electron）ベースのmacOS向けブラウザです。複数の Grok Bot チャット（grok.com/bot/…）を横並びで監視する用途向けに作っています。

> 非公式ツールです。xAI / X Corp. とは一切関係ありません。

## 主な機能
- **レイアウト**: 2x1 / 3x1 / 4x1 / 2x2 / 3x2 / 4x2 / 3x3 / 5x2。ペインを閉じると残りを自動で均等配置（auto-fit）
- **スプリッター**: ペイン間をドラッグで幅・高さ調整（レイアウトごとに保存、ダブルクリックで均等に戻す）
- **未読カウント / 光る枠**: 自分の最後の送信以降に届いたBotの返信数をタブとペインに表示、更新があったペインはオレンジに光る
- **入力待ち表示**: 最新のBotメッセージが `◆ --- 出力待ち --- ◆` で終わるペインは緑で表示
- **通知 & Dockバッジ**: 新着返信でmacOS通知（クリックでそのペインへ）、Dockに未読合計
- **お気に入りバー**: クリック=選択中のペイン / ⌘クリック=新しいペイン / ⇧クリック=別ウィンドウ / 右クリック=メニュー
- **タブ**: 均等幅・名前編集・右クリックメニュー（閉じる / ペインごと閉じる / 複製 / 他を閉じる など）、コンパクトモード（⌘⇧C）
- **保存レイアウト（ワークスペース）**: ペイン構成を名前付きで保存・ワンクリック切替
- **一斉送信**（⌘⇧B）: 1回入力して、選んだ複数のGrokペインに送信
- **使用量表示**: サブスクの使用量を「残 / 使」切替で表示（grok.comのログインセッションから読み取り専用で取得）
- **grokfix**: grok.com/bot の直リンクがサイドバーしか描画されない問題を、サイト内遷移で回避
- 単一ペイン最大化（⌘\（JISは⌘¥も）・ヘッダーのダブルクリック）
- 使用量ポップオーバー: ホバーで期限・残り・「今日使える目安」を表示（目安 = (残り% − 余裕) ÷ 日数、毎日9:00に日付切替）
- 一括更新（⌘⇧R）
- コマンドパレット（⌘K）

## 使い方
```sh
npm install
npm start                # 開発起動
npm run dist:mac         # .dmg / .zip をビルド
npm run install:mac      # arm64 の .app をビルドして /Applications にインストール（ad-hoc署名）
```
デバッグログ: `MPB_DEBUG=1 npm start` → `~/Library/Application Support/MultiPane Browser/pane-debug.log`

## English
MultiPane Browser is an unofficial Electron-based macOS browser that tiles up to 10 web panes in one window, built for monitoring multiple Grok Bot chats side by side. Features: layout presets with auto-fit, draggable splitters, per-pane unread counts and glow, "waiting for input" highlight, native notifications and dock badge, favorites bar, tabs with context menu, compact mode, saved layouts, broadcast send, subscription usage readout, and a workaround for grok.com bot deep links. Run with `npm install && npm start`. Not affiliated with xAI or X Corp.

## License
MIT
