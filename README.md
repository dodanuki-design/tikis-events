# Tiki's Tokyo — イベントカレンダー

GoogleカレンダーをマスターにしたTiki's Tokyoの公式イベントページです。

## セットアップ

### 1. Googleカレンダーの設定
1. [calendar.google.com](https://calendar.google.com) で「Tiki's Tokyo｜Events」カレンダーを作成
2. 「設定と共有」→「アクセス権限」→「一般公開」にチェック
3. 「カレンダーの統合」セクションから **iCal形式の公開URL** をコピー

### 2. GitHubへアップロード
このファイル一式をGitHubリポジトリにアップロードします。

### 3. Vercelでデプロイ
1. [vercel.com](https://vercel.com) でGitHubリポジトリをインポート
2. **Environment Variables** に追加:
   - `GCAL_ICAL_URL` = （手順1でコピーしたiCal URL）
3. Deploy

## ファイル構成

```
tikis-events/
├── index.html        # フロントエンド（カレンダー表示）
├── api/
│   └── events.js     # Vercel Serverless Function（iCal → JSON変換）
├── package.json
├── vercel.json
└── .gitignore
```

## カラーコード（Googleカレンダー）

| 色 | 種別 |
|---|---|
| Tomato（赤） | フラショー |
| Flamingo（桃） | タヒチアン・ダンス |
| Banana（黄） | ワークショップ |
| Peacock（青） | ミュージック・ライブ |
| Sage（緑） | ムーンライト・ヨガ |
| Graphite（墨） | 特別企画・貸切 |
