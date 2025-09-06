#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <esp_timer.h>

// BLE UUID定義 (Web側と合わせる)
#define SERVICE_UUID        "12345678-1234-1234-1234-123456789abc"
#define COMMAND_CHAR_UUID   "12345678-1234-1234-1234-123456789abd"
#define RESPONSE_CHAR_UUID  "12345678-1234-1234-1234-123456789abe"

// ピン定義
#define MOTOR_PIN 26
#define LED_PIN 2

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
void setupWiFiTime();
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

// BLEコールバック
class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
        deviceConnected = true;
        digitalWrite(LED_PIN, HIGH);
        Serial.println("BLE Client Connected");
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
    
    // 高精度タイマー初期化
    const esp_timer_create_args_t timerArgs = {
        .callback = &timerCallback,
        .name = "precision_timer"
    };
    esp_timer_create(&timerArgs, &precisionTimer);
    
    // WiFi時刻同期
    setupWiFiTime();
    
    // BLE初期化
    setupBLE();
    
    Serial.println("Setup complete. Waiting for BLE connection...");
}

void loop() {
    // 接続状態監視
    static unsigned long lastCheck = 0;
    if (millis() - lastCheck > 10000) {
        if (deviceConnected) {
            Serial.printf("Connected. Commands: %d, Periodic samples: %d/%d\n", 
                         stats.total_commands, periodicTest.sample_count, periodicTest.expected_count);
            if (periodicTest.is_running) {
                Serial.println("Periodic test in progress...");
            }
        }
        lastCheck = millis();
    }
    delay(500);
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
        Serial.printf("[%d] First signal received (baseline)\n", sequence);
    } else {
        // 期待される受信時刻を計算
        uint32_t expected_time = periodicTest.first_signal_time + 
                                (periodicTest.sample_count * periodicTest.expected_period);
        
        // ずれを計算（実際の受信時刻 - 期待時刻）
        int32_t deviation = (int32_t)(receivedAt - expected_time);
        periodicTest.deviations[periodicTest.sample_count] = (int16_t)deviation;
        
        Serial.printf("[%d] Signal received. Expected: %u, Actual: %u, Deviation: %dms\n", 
                      sequence, expected_time, receivedAt, deviation);
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