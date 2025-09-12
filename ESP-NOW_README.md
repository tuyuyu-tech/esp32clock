# ESP-NOW 750ms周期測定システム

## 概要
2台のESP32を使用して、ESP-NOWプロトコルでの超低遅延（1ms以下）タイミング測定を行うシステムです。

## ファイル構成
- `esp32_sender.ino` - ESP32-A（送信側）ファームウェア
- `esp32_receiver.ino` - ESP32-B（受信側）ファームウェア

## 測定仕様
- **送信周期**: 750ms
- **信号回数**: 20回
- **総測定時間**: 14.25秒
- **期待精度**: ±1ms以下（ESP-NOWの超低遅延特性）

## セットアップ手順

### 1. ESP32-B（受信側）の準備
1. `esp32_receiver.ino` をESP32-Bにアップロード
2. シリアルモニター（115200 baud）を開く
3. 表示されるMACアドレスをメモする
```
Receiver MAC: 24:0A:C4:XX:XX:XX
```

### 2. ESP32-A（送信側）の設定
1. `esp32_sender.ino` を開く
2. 6行目のMACアドレスを ESP32-B のアドレスに変更
```cpp
uint8_t receiver_mac[] = {0x24, 0x0A, 0xC4, 0xXX, 0xXX, 0xXX}; // ESP32-BのMAC
```
3. ESP32-Aにアップロード

### 3. 測定実行
1. ESP32-A のシリアルモニターでキーを押してテスト開始
2. ESP32-B で受信タイミングをリアルタイム監視
3. 20回受信完了後に詳細統計を表示

## 期待される出力例

### ESP32-A（送信側）
```
=== ESP32-A: ESP-NOW Sender ===
Press any key to start test...

=== Test Started ===
Signal #1 sent at 1234ms: Success
Signal #1: Delivered
Signal #2: Delivered
...
Signal #20: Delivered

=== Test Complete ===
```

### ESP32-B（受信側）
```
=== ESP32-B: ESP-NOW Receiver ===
Signal #1: 0ms (baseline)
Signal #2: 750ms
Signal #3: 1500ms
Signal #4: 2250ms
...
Signal #20: 14250ms

===================================================
                  TEST RESULTS
===================================================
Received: 20/20 signals
Test duration: 14.250 seconds

Timing Analysis:
Seq#  Received   Expected   Deviation
----  --------   --------   ---------
 1:      0ms        0ms       +0ms
 2:    750ms      750ms       +0ms
 3:   1499ms     1500ms       -1ms
 4:   2251ms     2250ms       +1ms
...
20:  14249ms    14250ms       -1ms
----------------------------------------
Average deviation: 0.3ms
Max deviation:     1ms
Min deviation:     0ms

Precision Analysis:
Within ±1ms:  20/20 (100%)
Within ±5ms:  20/20 (100%)
Within ±10ms: 20/20 (100%)
===================================================
```

## 技術的特徴

### ESP-NOWの優位性
- **遅延**: 0.1-0.5ms（平均0.3ms）
- **プロトコル**: WiFi MAC層での直接通信
- **ルーター**: 不要（ESP32間直接通信）
- **距離**: 最大200m（見通し良好時）

### 測定精度
- **タイマー**: ハードウェアタイマー（1MHz精度）
- **時刻**: `millis()` 関数（1ms分解能）
- **統計**: 偏差分析、精度評価付き
- **リセット**: 連続測定可能

## トラブルシューティング

### 接続できない場合
1. MACアドレスが正しく設定されているか確認
2. ESP32同士の距離を近づける（1-10m）
3. WiFiチャンネルの干渉を避ける
4. 電源供給が安定しているか確認

### 測定精度が悪い場合
1. ESP32の電源を安定化
2. 周囲のWiFi機器を停止
3. ESP32間の障害物を除去
4. ファームウェアを再アップロード

## 応用例
- モーター制御精度測定
- 無線同期システム評価
- IoTデバイス間通信評価
- リアルタイムシステム解析

ESP-NOWの超低遅延特性により、BLEやWiFiを大幅に上回る精度での測定が可能です。