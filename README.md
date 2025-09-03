# ESP32 BLE タイミング精度テスター

ESP32とWeb Bluetooth APIを使用したモーター制御の高精度タイミング測定システム

## 概要

このプロジェクトは、ESP32マイコンとWebブラウザー間でBLE（Bluetooth Low Energy）通信を行い、モーター制御信号のタイミング精度を測定するシステムです。目標精度は±5ms以内です。

## 特徴

- **Web Bluetooth API**: ブラウザーから直接ESP32に接続
- **高精度タイミング**: ESP32の高精度タイマーを使用
- **リアルタイム可視化**: Chart.jsによるリアルタイムグラフ表示
- **時刻同期**: NTP風プロトコルによる時刻同期
- **統計分析**: CSV エクスポート機能付き
- **GitHub Pages対応**: 静的サイトとして公開可能

## システム構成

```
[Webブラウザー] <-- BLE --> [ESP32] --> [モーター/LED]
     ↓                         ↓
[Chart.js表示]              [高精度制御]
[統計表示]                  [タイムスタンプ]
[CSV出力]                   [誤差測定]
```

## ファイル構成

```
esp32clock/
├── index.html          # メインHTML (Web Bluetooth UI)
├── style.css          # スタイルシート
├── app.js             # JavaScript (Web Bluetooth API)
├── src/
│   └── main.cpp       # ESP32 Arduino コード
├── platformio.ini     # PlatformIO 設定
├── CLAUDE.md          # 開発ガイド
└── README.md          # このファイル
```

## セットアップ

### ESP32側

1. **PlatformIO環境構築**
   ```bash
   # PlatformIOをインストール済みの場合
   pio project init --board esp32dev
   ```

2. **ファームウェア書き込み**
   ```bash
   # ビルドとアップロード
   pio run -t upload
   
   # シリアルモニター
   pio device monitor
   ```

3. **配線**
   ```
   ESP32    接続先
   GPIO26   モーター制御信号/LED
   GPIO2    ステータスLED
   GND      GND
   3.3V     VCC
   ```

### Web側

1. **GitHub Pages設定**
   - リポジトリをGitHub Pagesに公開
   - `index.html`がメインページとして表示される

2. **ローカル開発**
   ```bash
   # HTTPサーバーで起動 (Web Bluetooth APIにはHTTPS必要)
   python -m http.server 8000
   # または
   npx serve .
   ```

## 使用方法

### 1. 接続
1. WebブラウザーでGitHub Pagesサイトを開く
2. 「ESP32に接続」ボタンをクリック
3. ESP32デバイスを選択

### 2. 時刻同期
1. 「時刻同期実行」ボタンをクリック
2. 20回のサンプリングで時刻オフセットを計算
3. 同期完了後、テストが可能になる

### 3. タイミングテスト
1. テスト設定を調整：
   - **テスト間隔**: コマンド送信間隔 (100-1000ms)
   - **実行遅延**: 受信から実行までの遅延 (50-200ms)  
   - **テスト回数**: 測定サンプル数 (1-1000回)

2. 「テスト開始」ボタンでテスト実行

3. 結果確認：
   - リアルタイムグラフで誤差を監視
   - 統計情報で平均誤差、5ms以内の成功率を確認
   - CSVエクスポートで詳細分析

## 測定項目

- **送信遅延**: Webブラウザー送信からESP32受信までの時間
- **実行誤差**: 指定時刻と実際の実行時刻の差
- **成功率**: ±5ms以内で実行できた割合
- **統計情報**: 平均、最大、最小誤差

## 技術的詳細

### 時刻同期プロトコル
```
1. Web → ESP32: T1 (送信時刻)
2. ESP32: T2 (受信時刻) を記録
3. ESP32 → Web: T1, T2, T3 (応答送信時刻)
4. Web: T4 (受信時刻) を記録

遅延 = ((T4-T1) - (T3-T2)) / 2
オフセット = ((T2-T1) + (T3-T4)) / 2
```

### BLE プロトコル
```
Service UUID: 12345678-1234-1234-1234-123456789abc
- Command Characteristic (Write): 12345678-1234-1234-1234-123456789abd  
- Response Characteristic (Notify): 12345678-1234-1234-1234-123456789abe

コマンド形式:
- 時刻同期: [0x01][T1:8bytes]
- モーター制御: [0x02][cmd:1][送信時刻:8][実行時刻:8][sequence:2]
```

## 制約事項

- **ブラウザー対応**: Chromium系ブラウザー (Chrome, Edge, Opera) のみ
- **HTTPS必須**: Web Bluetooth APIはHTTPS環境でのみ動作
- **接続数制限**: ESP32は1台のデバイスとのみ接続可能
- **精度限界**: BLEの特性上、完全な1ms精度は困難（5ms以内は実用可能）

## トラブルシューティング

### BLE接続できない
- ESP32がAdvertisingモードか確認
- ブラウザーのBluetooth設定を確認
- 他のBLEデバイスとの競合を確認

### 時刻同期に失敗
- WiFi環境でNTP同期を有効化
- ESP32のRTC精度を確認
- Connection Intervalを調整

### 精度が出ない
- 2.4GHz帯の干渉を確認
- Connection Parameterを最適化
- 複数回測定で統計的に改善

## ライセンス

MIT License

## 貢献

Issue、Pull Request歓迎です。