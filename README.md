# Tiki's Tokyo Events v2.0

Google カレンダーと同期する公式イベントカレンダー。
**判定ロジックを設定ファイル化**し、運用変更をコード変更なしで反映可能。

---

## v1 からの主な変更点

### アーキテクチャ：3層分離
| 層 | 内容 | 変更時の作業 |
|---|---|---|
| データ層 | Google カレンダー入力 | 川崎さんが日常運用 |
| **設定層** | `config/categories.json`、`config/display.json` | **運用ルール変更時に編集** |
| コード層 | `api/events.js`、`index.html` | エンジニア対応のみ |

### 機能改善
- **複数カテゴリ対応**：1イベントに複数のジャンルタグ
  例：「🎵 MONDAY MUSIC × HULA SHOW」→ `[music, hula_tahiti]` 両方タグ表示
- **絵文字優先判定**：絵文字マッチ＞キーワードマッチ。カンナフラワーに「フラ」が含まれる等の偶然一致を回避
- **貸切時間範囲表示**：「15:00–17:00 貸切」のように開始〜終了時刻を明示
- **ゲスト自動抽出**：タイトル中の `～○○～` を「ゲスト：○○」形式で表示
- **説明欄構造化**：`Music Charge: 2,000円` のような Key:Value 形式を自動パース
- **終日イベント対応**：時間未定の特別企画も適切に表示
- **0分イベントバグ修正**：DTEND が DTSTART と同じ場合の誤表示を回避

---

## ファイル構成

```
tikis-events/
├── config/
│   ├── categories.json   ← カテゴリ定義（絵文字・色・優先順位）
│   └── display.json      ← 表示ルール（貸切表記・ゲスト抽出等）
├── api/
│   └── events.js           ← config を読み込みで接位配列
├── index.html             ← ファイリ追加エンジド表示（single-page app）
├── package.json
├── vercel.json
└── README.md
```

---

## デプロイ手順（既存のVercelプロジェクトを更新する場合）

### 方法A: GitHubにファイル一式をpush

1. GitHubリポジトリ `dodanuki-design/tikis-events` をローカルにclone
2. このv2のファイル一式をコピペで上書き
3. commit & push
4. Vercelが自動でデプロイ（GitHub連携済みの場合）

### 方法B: GitHubブラウザで直接編集

1. https://github.com/dodanuki-design/tikis-events を開く
2. 既存ファイルを順次更新：
   - `api/events.js` を新版に置き換え
   - `index.html` を新版に置き換え
   - `package.json` を新版に置き換え
   - `vercel.json` を新版に置き換え
3. **新規ファイルを追加**：
   - `config/categories.json` を新規作成
   - `config/display.json` を新規作成
4. Commit changes

### 環境変数（既存のものをそのまま使用）

`GCAL_ICAL_URL` = Google カレンダーの公開 iCal URL

変更不要です。

---

## カテゴリ追加・変更の手順

### 例1: 「DJイベント」カテゴリを追加したい

`config/categories.json` の `categories` 配列に1ブロック追加するだけ：

```json
{
  "id": "dj",
  "label": "DJ",
  "labelEn": "DJ",
  "color": "#5A4FCF",
  "priority": 95,
  "emojis": ["🎧", "🪩"],
  "keywords": ["DJ"]
}
```

→ コード変更不要。git commit & push のみ。

### 例2: 「フラ」と「タヒチ」を再分離したい

`config/categories.json` の `hula_tahiti` を2つに分割：

```json
{ "id": "hula", "label": "フラショー", ..., "emojis": ["🌺"] },
{ "id": "tahiti", "label": "タヒチアン", ..., "emojis": ["🌴"] }
```

→ 既存イベントは絵文字に基づいて自動再分類。

---

## カレンダー入力ガイド（川崎さん向け）

### タイトル冒頭の絵文字でカテゴリ判定

| 絵文字 | カテゴリ |
|---|---|
| 🌺 | フラ・タヒチ（フラ） |
| 🌴 | フラ・タヒチ（タヒチ） |
| 🌺🌴 | フラ・タヒチ（複合） |
| 🎵 🎶 🎸 🎤 | ライブ |
| 🎵🌺 等 | 複数カテゴリ（音楽 + フラ） |
| 🧘 | ヨガ |
| 🎀 🌸 | ワークショップ |
| 🎉 🎊 | 特別企画（金枠表示） |
| 🐶 | ペット |
| 🔒 | 貸切・休業 |

### タイトル中のゲスト表記
```
✓ 🌺 HULA SHOW ～Na Hoku O Kahealani～
✓ 🎸 Hawaiian Live (DJ MIDORI)
```
→ 自動的に「ゲスト：Na Hoku O Kahealani」と整形して表示。

### 説明欄の追加情報（任意）

```
Music Charge: 2,000円
Guest: 藤崎理映子
予約: https://example.com
備考: 限定30名
```

→ 自動的に整形表示。Key名は config/display.json で拡張可能。

### 貸切日

```
タイトル: 🔒 貸切
開始時刻: 15:00
終了時刻: 17:00
```

→ 表示は「15:00–17:00 貸切」となります。

### 終日・時間未定

Google カレンダーで「終日」にチェック → ページ側は「終日」と表示。

---

## API レスポンス仕様

`GET /api/events` 

```json
{
  "events": [
    {
      "id": "uid@google",
      "date": "2026-04-25",
      "startTime": "18:30",
      "endTime": "21:00",
      "timeLabel": "18:30–21:00",
      "allDay": false,
      "rawTitle": "🎊【1周年記念】明治学院大学 HULA SHOW",
      "title": "【1周年記念】明治学院大学 HULA SHOW",
      "cleanTitle": "【1周年記念】明治学院大学 HULA SHOW",
      "categories": [
        { "id": "special", "label": "特別企画", "color": "#B8852E" },
        { "id": "hula_tahiti", "label": "フラ・タヒチ", "color": "#C94538" }
      ],
      "primaryCategory": { "id": "special", ... },
      "featured": true,
      "guests": [],
      "properties": [],
      "descriptionFreeText": "",
      "location": "代々木公園 BE STAGE 1F",
      "times": ["18:30"]
    }
  ],
  "lastUpdated": "2026-05-08T13:43:18.221Z",
  "count": 84,
  "meta": {
    "categoriesAvailable": [...],
    "timezone": "Asia/Tokyo"
  }
}
```

---

## テスト

```bash
npm install
node test-runner.js   # 47ケース：基本機能
node test-edge.js     # 35ケース：エッジケース
```

---

## トラブルシューティング

### イベントが表示されない
- Vercel の Environment Variables で `GCAL_ICAL_URL` を確認
- iCal URL が「公開URL」（`/public/basic.ics` で終わる）かを確認

### カテゴリが正しく判定されない
- タイトル冒頭の絵文字を確認
- `config/categories.json` の `emojis` 配列にその絵文字が含まれるか確認

### 反映が遅い
- キャッシュは5分間
- 急ぎなら Vercel ダッシュボードから「Redeploy」で即時反映

---

Made with 🌺 by 洞田貫プランニングス | v2.0
