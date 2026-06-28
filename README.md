# すれっしゅ

Threads のポストをスクロールで収集し、CSV でダウンロードする Chrome 拡張機能です。

## 機能

- **純粋ポストのみ収集** … 引用・リプライを除外してトップレベルのポストだけを収集
- **スクロールで収集** … タイムラインをスクロールすると自動でポストを検出・カウント
- **CSV ダウンロード** … 収集したポストを CSV で保存

## 使い方

1. Chrome で `chrome://extensions` を開く
2. 「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」でこのフォルダ（`threads-export-extension`）を選択
4. [Threads の検索ページ](https://www.threads.net/search)（または threads.com）を開く
5. 画面右上に「すれっしゅ」パネルが表示される
6. 必要なら「純粋ポストのみ収集」にチェックを入れる
7. スクロールしてポストを読み込む
8. 「Download CSV」で CSV をダウンロード

## 拡張を更新したとき（更新が反映されない場合）

パネルに **「すれっしゅ v1.0.2」** のようにバージョンが表示されます。更新後も古いバージョンが表示される場合は、次の順で試してください。

1. **Threads のタブをすべて閉じる**（重要：開いたままでは古いスクリプトが動き続けます）
2. `chrome://extensions` を開く
3. 「すれっしゅ」の **⟳ 更新** をクリック（または一度 **削除** してから「読み込む」で同じフォルダを指定）
4. **Cursor で変更を保存** していることを確認（⌘+S / Ctrl+S）
5. もう一度 Threads の検索ページを開く
6. パネルのタイトルが **「すれっしゅ v1.0.2」** になっていれば更新済みです

## 対応 URL

- `https://www.threads.net/*`
- `https://threads.net/*`
- `https://www.threads.com/*`
- `https://threads.com/*`

## ファイル構成

```
threads-export-extension/
├── manifest.json       # Manifest V3
├── content/
│   ├── content.js      # 収集・UI・CSV 出力
│   └── content.css    # パネル用スタイル
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── icons/              # 任意: icon16/48/128.png を置くと拡張アイコンに反映
├── DESIGN.md           # 設計書
└── README.md
```

## CSV の列

| 列名 | 説明 |
|------|------|
| id | 連番 |
| post_text | ポスト本文 |
| post_url | ポスト URL |
| author_username | @ユーザー名 |
| posted_at | 投稿日時 |

## 注意

- Threads の HTML は変更されやすく、セレクタが合わなくなることがあります。その場合は `content/content.js` の `POST_LINK_SELECTOR` や `POST_ROOT_SELECTORS` を実際の DOM に合わせて修正してください。
- 表示されている公開情報のみを取得しています。利用規約に従ってご利用ください。

## ライセンス

MIT
