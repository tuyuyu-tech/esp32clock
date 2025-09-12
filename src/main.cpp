#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <esp_timer.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>

// BLE UUID定義 (Web側と合わせる)
#define SERVICE_UUID        "12345678-1234-1234-1234-123456789abc"
#define COMMAND_CHAR_UUID   "12345678-1234-1234-1234-123456789abd"
#define RESPONSE_CHAR_UUID  "12345678-1234-1234-1234-123456789abe"

// ピン定義
#define MOTOR_PIN 26
#define LED_PIN 2
#define AUDIO_INPUT_PIN A0  // イヤホンジャック信号入力 (GPIO36)

// オーディオ信号検出設定
#define AUDIO_THRESHOLD_HIGH 2500  // 信号HIGH検出閾値 (12bit ADC: 0-4095)
#define AUDIO_THRESHOLD_LOW 1500   // 信号LOW検出閾値
#define AUDIO_DEBOUNCE_MS 5        // ノイズ除去のためのデバウンス時間

// プロトコル定義
#define CMD_TIME_SYNC           0x01
#define CMD_MOTOR_CMD           0x02
#define CMD_PERIODIC_TEST_START 0x03
#define CMD_PERIODIC_SIGNAL     0x04
#define CMD_GET_RESULTS         0x05

// 75ms周期測定用設定
#define MAX_PERIODIC_SAMPLES 1000
#define EXPECTED_PERIOD_MS   75

// BLE変数
BLEServer* pServer = nullptr;
BLEService* pService = nullptr;
BLECharacteristic* pCommandCharacteristic = nullptr;
BLECharacteristic* pResponseCharacteristic = nullptr;
bool deviceConnected = false;

// WiFi & HTTP変数
WebServer httpServer(80);
const char* wifi_ssid = "ESP32-Timer-WiFi";
const char* wifi_password = "12345678";
IPAddress wifi_ip(192, 168, 4, 1);
IPAddress wifi_gateway(192, 168, 4, 1);
IPAddress wifi_subnet(255, 255, 255, 0);

// タイマー関連
esp_timer_handle_t precisionTimer = nullptr;
bool motorPending = false;
uint64_t motorExecuteTime = 0;
uint16_t currentSequence = 0;

// 時刻同期関連
struct TimeSync {
    int64_t offset_ms = 0;
    bool is_synced = false;
    int64_t last_sync_time = 0;
} timeSync;

// 統計用
struct TimingStats {
    uint32_t total_commands = 0;
    uint32_t commands_within_5ms = 0;
    float total_error = 0;
    float max_error = 0;
    float min_error = 999999;
} stats;

// オーディオ信号検出用
struct AudioSignalDetector {
    bool is_signal_high = false;
    uint32_t last_transition_time = 0;
    uint32_t signal_count = 0;
    uint32_t first_signal_time = 0;
    bool monitoring_enabled = true;
    
    // 実際の測定データ保存用
    uint32_t timestamps[MAX_PERIODIC_SAMPLES];
    int16_t deviations[MAX_PERIODIC_SAMPLES];
    
    void reset() {
        signal_count = 0;
        first_signal_time = 0;
        is_signal_high = false;
        last_transition_time = 0;
        memset(timestamps, 0, sizeof(timestamps));
        memset(deviations, 0, sizeof(deviations));
    }
    
    void enable() { monitoring_enabled = true; }
    void disable() { monitoring_enabled = false; }
} audioDetector;

// 75ms周期測定用
struct PeriodicTest {
    bool is_running = false;
    uint16_t expected_count = 0;
    uint16_t expected_period = EXPECTED_PERIOD_MS;
    uint16_t max_deviation = 10;
    uint16_t sample_count = 0;
    uint32_t first_signal_time = 0;
    uint32_t receive_times[MAX_PERIODIC_SAMPLES];
    int16_t deviations[MAX_PERIODIC_SAMPLES]; // 期待時刻からのずれ (ms)
    
    void reset() {
        is_running = false;
        sample_count = 0;
        first_signal_time = 0;
        memset(receive_times, 0, sizeof(receive_times));
        memset(deviations, 0, sizeof(deviations));
    }
    
    void start(uint16_t count, uint16_t period) {
        reset();
        expected_count = count;
        expected_period = period;
        is_running = true;
    }
} periodicTest;

// プロトタイプ宣言
void setupBLE();
void setupWiFiAP();
void setupHTTPServer();
void setupWiFiTime();
void setupAudioInput();
int64_t getCurrentTimeMs();
void handleTimeSync(uint8_t* data, size_t length);
void handleMotorCommand(uint8_t* data, size_t length);
void handlePeriodicTestStart(uint8_t* data, size_t length);
void handlePeriodicSignal(uint8_t* data, size_t length);
void handleGetResults(uint8_t* data, size_t length);
void sendResponse(uint8_t command, uint8_t* data, size_t length);
void executeMotorControl();
void IRAM_ATTR timerCallback(void* arg);
void updateStatistics(float error);
void checkAudioInput();
void onAudioSignalDetected(uint32_t timestamp);
void handleHTTPCORS();
void handleAudioResults();

// BLEコールバック
class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
        deviceConnected = true;
        digitalWrite(LED_PIN, HIGH);
        Serial.println("BLE Client Connected");
        
        // BLE接続パラメータを最適化（最小遅延のため）
        // ESP32 BLEライブラリでは接続後の遅延で自動的に最適化される
        Serial.println("BLE connection established - optimizing for low latency");
    }
    
    void onDisconnect(BLEServer* pServer) {
        deviceConnected = false;
        digitalWrite(LED_PIN, LOW);
        Serial.println("BLE Client Disconnected");
        
        // 再接続可能にする
        pServer->getAdvertising()->start();
        Serial.println("Advertising restarted");
    }
};

class CommandCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic* pCharacteristic) {
        uint8_t* data = pCharacteristic->getData();
        size_t length = pCharacteristic->getValue().length();
        
        if (length > 0 && data != nullptr) {
            uint8_t command = data[0];
            
            switch (command) {
                case CMD_TIME_SYNC:
                    handleTimeSync(data, length);
                    break;
                case CMD_MOTOR_CMD:
                    handleMotorCommand(data, length);
                    break;
                case CMD_PERIODIC_TEST_START:
                    handlePeriodicTestStart(data, length);
                    break;
                case CMD_PERIODIC_SIGNAL:
                    handlePeriodicSignal(data, length);
                    break;
                case CMD_GET_RESULTS:
                    handleGetResults(data, length);
                    break;
                default:
                    Serial.printf("Unknown command: 0x%02X\n", command);
                    break;
            }
        }
    }
};

void setup() {
    Serial.begin(115200);
    Serial.println("ESP32 BLE Timing Tester Starting...");
    
    // GPIO初期化
    pinMode(MOTOR_PIN, OUTPUT);
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(MOTOR_PIN, LOW);
    digitalWrite(LED_PIN, LOW);
    
    // オーディオ入力初期化
    setupAudioInput();
    
    // 高精度タイマー初期化
    const esp_timer_create_args_t timerArgs = {
        .callback = &timerCallback,
        .name = "precision_timer"
    };
    esp_timer_create(&timerArgs, &precisionTimer);
    
    // WiFi時刻同期
    setupWiFiTime();
    
    // WiFi AP初期化
    setupWiFiAP();
    
    // HTTP Server初期化
    setupHTTPServer();
    
    // BLE初期化
    setupBLE();
    
    Serial.println("Setup complete. Waiting for BLE connection...");
}

void loop() {
    // HTTP server処理
    httpServer.handleClient();
    
    // オーディオ信号検出
    checkAudioInput();
    
    // 接続状態監視
    static unsigned long lastCheck = 0;
    if (millis() - lastCheck > 10000) {
        if (deviceConnected) {
            Serial.printf("BLE Connected. Commands: %d, Periodic samples: %d/%d\n", 
                         stats.total_commands, periodicTest.sample_count, periodicTest.expected_count);
            if (periodicTest.is_running) {
                Serial.println("Periodic test in progress...");
            }
        }
        if (audioDetector.signal_count > 0) {
            Serial.printf("Audio signals detected: %d\n", audioDetector.signal_count);
        }
        Serial.printf("WiFi AP: %s, IP: %s\n", wifi_ssid, WiFi.softAPIP().toString().c_str());
        lastCheck = millis();
    }
    delay(1); // オーディオ監視のため短い遅延
}

void setupWiFiTime() {
    // 簡易時刻初期化
    Serial.println("Time initialized");
}

void setupBLE() {
    BLEDevice::init("ESP32-Timer");
    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new MyServerCallbacks());
    
    pService = pServer->createService(SERVICE_UUID);
    
    // Command Characteristic (Write)
    pCommandCharacteristic = pService->createCharacteristic(
        COMMAND_CHAR_UUID,
        BLECharacteristic::PROPERTY_WRITE
    );
    pCommandCharacteristic->setCallbacks(new CommandCallbacks());
    
    // Response Characteristic (Read, Notify)
    pResponseCharacteristic = pService->createCharacteristic(
        RESPONSE_CHAR_UUID,
        BLECharacteristic::PROPERTY_READ |
        BLECharacteristic::PROPERTY_NOTIFY
    );
    pResponseCharacteristic->addDescriptor(new BLE2902());
    
    pService->start();
    
    // Advertising設定
    BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(true);
    pAdvertising->setMinPreferred(0x06); // iPhone compatibility
    pAdvertising->setMaxPreferred(0x12);
    
    // アドバタイジング開始
    BLEDevice::startAdvertising();
    
    Serial.println("BLE Service started");
    Serial.println("Device name: ESP32-Timer");
    Serial.println("Advertising UUID: " + String(SERVICE_UUID));
    Serial.println("Waiting for client connection...");
}

int64_t getCurrentTimeMs() {
    return millis();
}

void handleTimeSync(uint8_t* data, size_t length) {
    if (length < 9) {
        Serial.println("Invalid time sync packet");
        return;
    }
    
    // t1 (送信時刻)を取得
    int64_t t1 = 0;
    memcpy(&t1, data + 1, 8);
    
    int64_t t2 = getCurrentTimeMs();  // 受信時刻
    
    // 簡単な処理
    delayMicroseconds(100);
    
    int64_t t3 = getCurrentTimeMs();  // 送信時刻
    
    // 応答作成
    uint8_t response[17];
    response[0] = CMD_TIME_SYNC;
    memcpy(response + 1, &t1, 8);  // t1をエコーバック
    memcpy(response + 9, &t2, 8);  // t2
    // t3は17バイト目以降に入らないので、t2で代用
    
    // より正確な17バイト構造
    uint8_t fullResponse[25];
    fullResponse[0] = CMD_TIME_SYNC;
    memcpy(fullResponse + 1, &t1, 8);   // t1
    memcpy(fullResponse + 9, &t2, 8);   // t2
    memcpy(fullResponse + 17, &t3, 8);  // t3
    
    sendResponse(CMD_TIME_SYNC, fullResponse, 25);
    
    Serial.printf("Time sync: t1=%lld, t2=%lld, t3=%lld\n", t1, t2, t3);
}

void handleMotorCommand(uint8_t* data, size_t length) {
    if (length < 20) {
        Serial.println("Invalid motor command packet");
        return;
    }
    
    uint8_t motorCmd = data[1];
    int64_t sentAt, executeAt;
    uint16_t sequence;
    
    memcpy(&sentAt, data + 2, 8);
    memcpy(&executeAt, data + 10, 8);
    memcpy(&sequence, data + 18, 2);
    
    int64_t receivedAt = getCurrentTimeMs();
    
    // 実行時刻計算
    int64_t delayMs = executeAt - receivedAt;
    
    Serial.printf("[%d] Motor cmd received. Delay: %lldms\n", sequence, delayMs);
    
    if (delayMs > 0 && delayMs < 1000) {
        // 高精度タイマーでスケジューリング
        motorPending = true;
        motorExecuteTime = executeAt;
        currentSequence = sequence;
        
        esp_timer_start_once(precisionTimer, delayMs * 1000); // マイクロ秒単位
    } else {
        // 即座に実行
        int64_t executedAt = getCurrentTimeMs();
        executeMotorControl();
        
        // 応答送信
        uint8_t response[19];
        response[0] = CMD_MOTOR_CMD;
        response[1] = motorCmd;
        memcpy(response + 2, &receivedAt, 8);
        memcpy(response + 10, &executedAt, 8);
        memcpy(response + 18, &sequence, 2);
        
        sendResponse(CMD_MOTOR_CMD, response, 20);
        
        // 統計更新
        float error = (float)(executedAt - executeAt);
        updateStatistics(abs(error));
        
        Serial.printf("[%d] Immediate execution. Error: %.2fms\n", sequence, error);
    }
}

void IRAM_ATTR timerCallback(void* arg) {
    if (motorPending) {
        int64_t executedAt = getCurrentTimeMs();
        
        // モーター制御実行
        executeMotorControl();
        
        // 応答をメインループで送信するためにフラグセット
        motorPending = false;
        
        // 統計更新
        float error = (float)(executedAt - motorExecuteTime);
        updateStatistics(abs(error));
        
        // ここではSerial出力は避ける（ISRのため）
        // メインループで統計表示
    }
}

void executeMotorControl() {
    // モーター制御（パルス出力）
    digitalWrite(MOTOR_PIN, HIGH);
    delayMicroseconds(100);
    digitalWrite(MOTOR_PIN, LOW);
    
    // LED点滅で視覚確認
    digitalWrite(LED_PIN, HIGH);
    delayMicroseconds(50);
    digitalWrite(LED_PIN, LOW);
}

void sendResponse(uint8_t command, uint8_t* data, size_t length) {
    if (!deviceConnected || !pResponseCharacteristic) return;
    
    pResponseCharacteristic->setValue(data, length);
    pResponseCharacteristic->notify();
}

void updateStatistics(float error) {
    stats.total_commands++;
    stats.total_error += error;
    
    if (error <= 5.0) {
        stats.commands_within_5ms++;
    }
    
    if (error > stats.max_error) {
        stats.max_error = error;
    }
    
    if (error < stats.min_error) {
        stats.min_error = error;
    }
}

void handlePeriodicTestStart(uint8_t* data, size_t length) {
    if (length < 5) {
        Serial.println("Invalid periodic test start packet");
        return;
    }
    
    uint16_t count, period;
    memcpy(&count, data + 1, 2);
    memcpy(&period, data + 3, 2);
    
    // 範囲チェック
    if (count > MAX_PERIODIC_SAMPLES) {
        count = MAX_PERIODIC_SAMPLES;
    }
    
    periodicTest.start(count, period);
    
    Serial.printf("Periodic test started: %d signals, %dms period\n", count, period);
    
    // 確認応答（オプション）
    uint8_t response[2];
    response[0] = 0x01; // 成功
    response[1] = 0x00;
    
    if (deviceConnected && pResponseCharacteristic) {
        pResponseCharacteristic->setValue(response, 2);
        pResponseCharacteristic->notify();
    }
}

void handlePeriodicSignal(uint8_t* data, size_t length) {
    if (length < 11) {
        Serial.println("Invalid periodic signal packet");
        return;
    }
    
    if (!periodicTest.is_running) {
        Serial.println("Periodic test not running");
        return;
    }
    
    if (periodicTest.sample_count >= periodicTest.expected_count) {
        Serial.println("Periodic test sample limit reached");
        return;
    }
    
    uint32_t receivedAt = millis();
    
    uint16_t sequence;
    uint64_t sentAt;
    memcpy(&sequence, data + 1, 2);
    memcpy(&sentAt, data + 3, 8);
    
    // 最初の信号を基準として記録
    if (periodicTest.sample_count == 0) {
        periodicTest.first_signal_time = receivedAt;
        periodicTest.deviations[0] = 0; // 基準信号はずれなし
        Serial.printf("[%d] First signal received (baseline at %u ms)\n", sequence, receivedAt);
    } else {
        // 絶対時間での期待時刻を計算（累積誤差回避）
        uint32_t expected_time = periodicTest.first_signal_time + (periodicTest.sample_count * periodicTest.expected_period);
        
        // ずれを計算（実際の受信時刻 - 期待時刻）
        int32_t deviation = (int32_t)(receivedAt - expected_time);
        periodicTest.deviations[periodicTest.sample_count] = (int16_t)deviation;
        
        Serial.printf("[%d] Signal received. Baseline: %u, Expected: %u (+%dms), Actual: %u, Deviation: %dms\n", 
                      sequence, periodicTest.first_signal_time, expected_time, 
                      periodicTest.sample_count * periodicTest.expected_period, receivedAt, deviation);
    }
    
    periodicTest.receive_times[periodicTest.sample_count] = receivedAt;
    periodicTest.sample_count++;
    
    // テスト完了チェック
    if (periodicTest.sample_count >= periodicTest.expected_count) {
        periodicTest.is_running = false;
        Serial.printf("Periodic test completed: %d samples collected\n", periodicTest.sample_count);
    }
}

void handleGetResults(uint8_t* data, size_t length) {
    if (periodicTest.sample_count == 0) {
        Serial.println("No periodic test results available");
        
        // 空の応答
        uint8_t response[2];
        response[0] = 0x00;
        response[1] = 0x00;
        
        if (deviceConnected && pResponseCharacteristic) {
            pResponseCharacteristic->setValue(response, 2);
            pResponseCharacteristic->notify();
        }
        return;
    }
    
    // 結果データのサイズ計算
    uint16_t result_count = periodicTest.sample_count;
    size_t response_size = 2 + result_count * 2; // ヘッダー2バイト + 各結果2バイト
    
    // 最大MTUサイズを考慮してチャンク送信が必要かもしれません
    // 今回は簡単のため一度に送信
    if (response_size > 512) { // BLEの実用的な制限
        result_count = (512 - 2) / 2;
        response_size = 512;
    }
    
    uint8_t* response = (uint8_t*)malloc(response_size);
    if (!response) {
        Serial.println("Failed to allocate response buffer");
        return;
    }
    
    // ヘッダー（リトルエンディアン形式）
    response[0] = (result_count >> 0) & 0xFF;
    response[1] = (result_count >> 8) & 0xFF;
    
    // 結果データ（リトルエンディアン形式）
    for (uint16_t i = 0; i < result_count; i++) {
        int16_t deviation = periodicTest.deviations[i];
        response[2 + i * 2 + 0] = (deviation >> 0) & 0xFF;
        response[2 + i * 2 + 1] = (deviation >> 8) & 0xFF;
    }
    
    // 実際のデータサイズを調整（コマンドバイトは含めない）
    size_t actual_size = 2 + result_count * 2;
    
    pResponseCharacteristic->setValue(response, actual_size);
    pResponseCharacteristic->notify();
    
    Serial.printf("Results sent: %d samples\n", result_count);
    
    // 統計表示
    int32_t total_deviation = 0;
    int16_t max_abs_deviation = 0;
    uint16_t within_tolerance = 0;
    
    for (uint16_t i = 0; i < result_count; i++) {
        total_deviation += periodicTest.deviations[i];
        int16_t abs_dev = abs(periodicTest.deviations[i]);
        if (abs_dev > max_abs_deviation) {
            max_abs_deviation = abs_dev;
        }
        if (abs_dev <= periodicTest.max_deviation) {
            within_tolerance++;
        }
    }
    
    float avg_deviation = (float)total_deviation / result_count;
    float tolerance_percent = (float)within_tolerance / result_count * 100.0f;
    
    Serial.printf("Periodic Test Statistics:\n");
    Serial.printf("  Average deviation: %.2fms\n", avg_deviation);
    Serial.printf("  Max deviation: %dms\n", max_abs_deviation);
    Serial.printf("  Within tolerance: %.1f%%\n", tolerance_percent);
    
    free(response);
}

void setupAudioInput() {
    // ADC1の初期化（GPIO36 = A0）
    analogReadResolution(12); // 12bit分解能 (0-4095)
    
    // オーディオ検出器初期化
    audioDetector.reset();
    
    Serial.println("Audio input initialized on GPIO36 (A0)");
    Serial.printf("Signal thresholds: HIGH > %d, LOW < %d\n", 
                  AUDIO_THRESHOLD_HIGH, AUDIO_THRESHOLD_LOW);
}

void checkAudioInput() {
    if (!audioDetector.monitoring_enabled) return;
    
    uint32_t currentTime = millis();
    int adcValue = analogRead(AUDIO_INPUT_PIN);
    
    // 信号レベル判定
    bool signalHigh = (adcValue > AUDIO_THRESHOLD_HIGH);
    bool signalLow = (adcValue < AUDIO_THRESHOLD_LOW);
    
    // 状態変化検出（LOWからHIGHへの立ち上がりエッジ）
    if (!audioDetector.is_signal_high && signalHigh) {
        // デバウンス処理
        if (currentTime - audioDetector.last_transition_time >= AUDIO_DEBOUNCE_MS) {
            audioDetector.is_signal_high = true;
            audioDetector.last_transition_time = currentTime;
            onAudioSignalDetected(currentTime);
        }
    } else if (audioDetector.is_signal_high && signalLow) {
        // HIGH→LOW遷移
        if (currentTime - audioDetector.last_transition_time >= AUDIO_DEBOUNCE_MS) {
            audioDetector.is_signal_high = false;
            audioDetector.last_transition_time = currentTime;
        }
    }
}

void onAudioSignalDetected(uint32_t timestamp) {
    if (audioDetector.signal_count >= MAX_PERIODIC_SAMPLES) {
        Serial.println("Audio detector buffer full");
        return;
    }
    
    // タイムスタンプを保存
    audioDetector.timestamps[audioDetector.signal_count] = timestamp;
    
    if (audioDetector.signal_count == 0) {
        // 最初の信号を基準として記録
        audioDetector.first_signal_time = timestamp;
        audioDetector.deviations[0] = 0; // 基準は偏差0
        Serial.printf("[AUDIO] Signal #1 detected at %u ms (baseline)\n", timestamp);
    } else {
        // 75ms周期からの偏差を計算（絶対時間基準）
        uint32_t expected_time = audioDetector.first_signal_time + (audioDetector.signal_count * 75);
        int32_t deviation = (int32_t)(timestamp - expected_time);
        audioDetector.deviations[audioDetector.signal_count] = (int16_t)deviation;
        
        Serial.printf("[AUDIO] Signal #%d detected at %u ms (expected: %u ms, deviation: %+d ms)\n", 
                      audioDetector.signal_count + 1, timestamp, expected_time, deviation);
    }
    
    audioDetector.signal_count++;
}

void setupWiFiAP() {
    // WiFi Access Point設定
    WiFi.mode(WIFI_AP);
    WiFi.softAPConfig(wifi_ip, wifi_gateway, wifi_subnet);
    
    bool result = WiFi.softAP(wifi_ssid, wifi_password);
    
    if (result) {
        Serial.println("WiFi Access Point started successfully");
        Serial.printf("SSID: %s\n", wifi_ssid);
        Serial.printf("Password: %s\n", wifi_password);
        Serial.printf("IP Address: %s\n", WiFi.softAPIP().toString().c_str());
        Serial.println("Connect your phone to this WiFi network");
    } else {
        Serial.println("Failed to start WiFi Access Point");
    }
}

void setupHTTPServer() {
    // CORS対応
    httpServer.onNotFound([]() {
        handleHTTPCORS();
    });
    
    // API エンドポイント
    httpServer.on("/api/audio-results", HTTP_GET, handleAudioResults);
    httpServer.on("/api/audio-results", HTTP_OPTIONS, handleHTTPCORS);
    
    // ルートページ（テスト用）
    httpServer.on("/", []() {
        String html = "<html><body>";
        html += "<h1>ESP32 Timer - Audio Mode</h1>";
        html += "<p>Audio signals detected: " + String(audioDetector.signal_count) + "</p>";
        html += "<p>API endpoint: <a href='/api/audio-results'>/api/audio-results</a></p>";
        html += "</body></html>";
        
        httpServer.send(200, "text/html", html);
    });
    
    httpServer.begin();
    Serial.println("HTTP Server started on port 80");
}

void handleHTTPCORS() {
    httpServer.sendHeader("Access-Control-Allow-Origin", "*");
    httpServer.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    httpServer.sendHeader("Access-Control-Allow-Headers", "Content-Type");
    httpServer.send(200, "text/plain", "");
}

void handleAudioResults() {
    // CORS headers
    httpServer.sendHeader("Access-Control-Allow-Origin", "*");
    httpServer.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    httpServer.sendHeader("Access-Control-Allow-Headers", "Content-Type");
    
    // JSON レスポンス作成
    DynamicJsonDocument doc(2048);
    
    doc["signal_count"] = audioDetector.signal_count;
    doc["first_signal_time"] = audioDetector.first_signal_time;
    doc["monitoring_enabled"] = audioDetector.monitoring_enabled;
    
    // 偏差データ配列
    JsonArray deviations = doc.createNestedArray("deviations");
    JsonArray timestamps = doc.createNestedArray("timestamps");
    
    if (audioDetector.signal_count > 0) {
        for (int i = 0; i < audioDetector.signal_count && i < 100; i++) {
            // 実際の偏差データを使用
            deviations.add(audioDetector.deviations[i]);
            timestamps.add(audioDetector.timestamps[i]);
        }
    }
    
    String response;
    serializeJson(doc, response);
    
    httpServer.send(200, "application/json", response);
}