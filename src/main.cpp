#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <WiFi.h>
#include <time.h>
#include <esp_timer.h>

// BLE UUID定義 (Web側と合わせる)
#define SERVICE_UUID        "12345678-1234-1234-1234-123456789abc"
#define COMMAND_CHAR_UUID   "12345678-1234-1234-1234-123456789abd"
#define RESPONSE_CHAR_UUID  "12345678-1234-1234-1234-123456789abe"

// ピン定義
#define MOTOR_PIN 26
#define LED_PIN 2

// プロトコル定義
#define CMD_TIME_SYNC  0x01
#define CMD_MOTOR_CMD  0x02

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

// プロトタイプ宣言
void setupBLE();
void setupWiFiTime();
int64_t getCurrentTimeMs();
void handleTimeSync(uint8_t* data, size_t length);
void handleMotorCommand(uint8_t* data, size_t length);
void sendResponse(uint8_t command, uint8_t* data, size_t length);
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
    // BLE接続状態監視
    static unsigned long lastCheck = 0;
    if (millis() - lastCheck > 5000) {
        if (deviceConnected) {
            Serial.printf("Stats: Total=%d, Within5ms=%d (%.1f%%), AvgError=%.2fms, MaxError=%.2fms\n",
                         stats.total_commands,
                         stats.commands_within_5ms,
                         stats.total_commands > 0 ? (100.0 * stats.commands_within_5ms / stats.total_commands) : 0,
                         stats.total_commands > 0 ? (stats.total_error / stats.total_commands) : 0,
                         stats.max_error);
        }
        lastCheck = millis();
    }
    
    delay(100);
}

void setupWiFiTime() {
    // 内蔵RTCの初期設定
    // 実際の運用では WiFi.begin() で接続してNTP同期
    struct timeval tv;
    tv.tv_sec = 1609459200; // 2021-01-01 00:00:00 UTC (初期値)
    tv.tv_usec = 0;
    settimeofday(&tv, NULL);
    
    Serial.println("Time initialized (use WiFi NTP for accuracy)");
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
    
    // Advertising開始
    BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(false);
    pAdvertising->setMinPreferred(0x0);
    BLEDevice::startAdvertising();
    
    Serial.println("BLE Service started");
}

int64_t getCurrentTimeMs() {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (int64_t)tv.tv_sec * 1000LL + tv.tv_usec / 1000;
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