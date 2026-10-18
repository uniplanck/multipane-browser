# MultiPane Browser

1つのウィンドウに最大10ペインを並べられる、Chromium（Electron）ベースのmacOS向けブラウザです。複数の Grok Bot チャット（grok.com/bot/…）を横並びで監視する用途向けに作っています。

> 非公式ツールです。xAI / X Corp. とは一切関係ありません。

## 主な機能
- **レイアウト**: 2x1 / 3x1 / 4x1 / 2x2 / 3x2 / 4x2 / 3x3 / 5x2。ペインを閉じると残りを自動で均等配置（auto-fit）
- **スプリッター**: ペイン間をドラッグで幅・高さ調整（レイアウトごとに保存、ダブルクリックで均等に戻す）
- **未読カウント / 光る枠**: 自分の最後の送信以降に届いたBotの返信数をタブとペインに表示、更新があったペインはオレンジに光る
- **マーカー表示（最新のBotメッセージの末尾で判定。罫線・スペース・全角スペース・`◆ 日時 ◆` の違いは吸収）**
  - 🟢 **待機中**（緑・通知/Dockバッジ対象）: `🟢 ━━ 《 待機中 》 ━━ 🟢`（`待機中30` / `待機中60` も可。旧表記 `入力待機中` / `入力待ち` / `出力待ち` と `◆ ━━ … ━━ ◆` も引き続き待機中として扱う）
  - 🟣 **終了**（紫・光らない／通知・Dockバッジなし。数字は紫で表示）: `🟣 ━━ ［ 終　了 ］ ━━ 🟣`（「終」「了」の間は全角スペース。半角/なしも可）
  - 🔴 **作業中**（赤）: `🔴 ━━ 【 作業中 】 ━━ 🔴`
  - 複数あれば末尾に近いものが優先。自動スリープ（作業中・マーカーなし・フォーカス中・最大化中は対象外）: 🟣終了は終了を検知して**1分後**、🟢待機中は**30分後**。入力欄に文字・下書き・添付があるペインは眠らない（スリープ直前にも再確認）。待機中でスリープしたペインには、マーカー直上の引用（依頼内容）をスリープ画面に表示。スリープ画面の最上部にはボット名（大）とグループチャットならグループ名（小）も表示（ページの見出しから取得、取れなければタブタイトル）。スリープ中も色（紫/緑）を保ち、新着確認（水色＝未開封）の対象。再読み込み・移動・返信の生成中などで今の状態をまだ確認できていない間は、表示中の色は「最終確認」（薄く表示）で、自動スリープしない
- **クラウドPC自動最大化**: ページの「コンピュータを表示」を開くと、そのペインを自動で最大化してサイズ上限を解除（閉じる / Esc で元に戻る。すでに最大化中ならそのまま大きく表示し、閉じても縮めない）。表示メニューでON/OFF（既定ON）
- **閉じたペインを開き直す**（⌘⇧T / 上部の ↩ ボタン）: 直近10個まで。閉じた行・位置・URL・名前・ズーム・スリープ設定を復元
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

- **構成の保存**: ペイン構成（行・列・URL・名前など）は変更の0.2秒後と終了時に `panes.json` へ保存。起動のたびに直近5世代を `panes.json.日時.bak` として同じフォルダに残す（誤って上書きしても戻せる）
  - 保存は同じフォルダの一時ファイルに書いて fsync してから置き換えるので、途中で落ちても前回の `panes.json` が残る。置き換える前の正常な内容は `panes.json.prev-1〜3` として3世代残す。保存要求には番号を振り、古い内容が新しい内容を上書きしない。終了時の保存待ちは最大3秒
  - 読めない（壊れている・形式が違う）か新しいバージョンで保存された `panes.json` は、読み込みも上書きもしない（自動保存を停止）。起動時に復旧画面が開き、読める保存世代（prev / .bak）から復元するか、新しい構成で始めるかを確認付きで選べる。元のファイルは `panes.json.broken-日時`（新しいバージョンのものは `.newer-日時`）として残す
  - 保存に失敗したときは表示はそのままで、上部に「⚠ 保存できません」が出る（クリックで再試行）。突然の電源断で直前の変更がすべて残ることは保証しない
  - 開発時は `MPB_USER_DATA=/tmp/任意のフォルダ npm start` で、本番とは別のプロファイル（userData・sessionData）で起動できる

## 使い方
```sh
npm install
npm start                # 開発起動
npm run dist:mac         # .dmg / .zip をビルド
npm run install:mac      # arm64 の .app をビルドして /Applications にインストール（ad-hoc署名）
npm run build:preload    # src/pane-preload.js を生成（下記）
npm run check:preload    # 生成物が最新か確認（変更しない。古い/無いと exit 1）
```
- `src/pane-preload.js` は**生成物なので直接編集しない**。ペインの preload は sandbox で動きローカルファイルを `require` できないため、マーカー判定・引用抽出・下書き判定（`src/pane-rules.js`、main とテストも同じものを `require`）を `scripts/build-pane-preload.js` が `src/pane-preload.template.js` に組み込んで作る。どちらかを編集したら `npm run build:preload`。`npm start` とパッケージング（electron-builder の `beforePack`）の前に自動で確認し、古ければ止まる
- IPC: main が受け取る全チャンネルは `src/ipc-policy.js` の表にあり、受信は `src/main.js` の `ipcOn` / `ipcHandle` だけ。main が作った画面（ウィンドウUI・overlay・ペイン・裏の新着確認・承認Bot）を役割つきで登録し、登録済みの送信元・トップフレーム・同梱画面（file: は index.html / overlay.html と一致するときだけ）または許可origin・そのウィンドウにある対象・引数の型と範囲をすべて満たす送信だけを処理する。満たさない送信は何もせずに捨て、デバッグログには固定コード（`E_ROLE` など）だけを残す（内容・URLは出さない）。チャンネルや引数を変えたら `src/ipc-policy.js` も直し、`node test/ipc-policy.test.js` で確認する（実際の preload / renderer / overlay の送信が通ることも検査）
- 世代（`src/pane-state.js`）: main がペイン実体・ページの世代（読込・再読み込み・URL/SPA移動・スリープ・起床・レンダラ終了ごとに更新）・裏の新着確認の実行に起動ごとの通し番号を振り、ページの preload は受け取った番号と走査番号を件数の報告に付ける。main は報告を付いていた世代の中だけで比べ、閉じたペイン・古いページ/URL/新着確認・重複・逆順の報告は何も変えずに捨てる（診断は `count.drop` の固定コード）。番号は保存しない
- テスト: `for f in test/*.test.js; do node "$f"; done`
デバッグログ: `MPB_DEBUG=1 npm start` → `~/Library/Application Support/MultiPane Browser/pane-debug.log`
- 診断（設定 > 診断… / コマンドパレット「診断」）: バージョン・主な設定・この起動からの件数・保存状態（panes.json と診断ログ）を表示。「summaryをクリップボードにコピー…」は内容を確認ダイアログで見せてからクリップボードにだけコピーする（外部送信はしない）
  - 記録するのは時刻・固定のevent/結果コード・所要ms・試行数・起動ごとのペイン番号だけ（`src/diagnostics.js` の表にない値は保存前に捨てる。会話・Bot名・引用・入力・URL・パス・ヘッダー・エラー文は記録しない。未知のエラーは `UNKNOWN` として数える）。対象はページ読込・Bot表示の補正・再読み込み・スリープ/新着確認・採用しなかった件数/IPC・構成の読込/保存失敗
  - 普段はメモリに最新1000件だけ（終了で消える）。設定 >「診断ログをファイルにも保存」か `MPB_DEBUG` のときだけ `userData/diagnostics/diag-0〜2.jsonl`（フォルダ0700・ファイル0600、1ファイル2MiB・3世代・7日）に非同期でまとめて書く。書けない（満杯・権限）ときも記録とアプリは止まらず、失敗は1回だけ記録して間隔をあけて再試行。オフにしてもファイルは消さず、整理するのはこのフォルダの `diag-N.jsonl` だけ（`pane-debug.log` は別物で、URLなどを含むことがある）

## English
MultiPane Browser is an unofficial Electron-based macOS browser that tiles up to 10 web panes in one window, built for monitoring multiple Grok Bot chats side by side. Features: layout presets with auto-fit, draggable splitters, per-pane unread counts and glow, "waiting for input" highlight, native notifications and dock badge, favorites bar, tabs with context menu, compact mode, saved layouts, broadcast send, subscription usage readout, and a workaround for grok.com bot deep links. Run with `npm install && npm start`. Not affiliated with xAI or X Corp.

## License
MIT
