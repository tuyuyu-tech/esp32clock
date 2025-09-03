#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <WiFi.h>
#include <time.h>

// BLE UUID定義
#define SERVICE_UUID        "12345678-1234-1234-1234-123456789abc"
#define COMMAND_CHAR_UUID   "12345678-1234-1234-1234-123456789abd"
#define RESPONSE_CHAR_UUID  "12345678-1234-1234-1234-123456789abe"

// ピン定義
#define MOTOR_PIN 26
#define LED_PIN 2

// プロトコル定義
#define CMD_TIME_SYNC  0x01
#define CMD_MOTOR_CMD  0x02
#define CMD_WIFI_SYNC  0x03

// WiFi設定（必要に応じて変更）
const char* ssid = "your_wifi_ssid";      // WiFi SSID
const char* password = "your_wifi_password";  // WiFi パスワード

// BLE変数
BLEServer* pServer = nullptr;
BLEService* pService = nullptr;
BLECharacteristic* pCommandCharacteristic = nullptr;
BLECharacteristic* pResponseCharacteristic = nullptr;
bool deviceConnected = false;

// 統計用（簡素化）
uint32_t totalCommands = 0;

// ===== 関数定義（クラスより前に配置）=====
void handleWiFiSync(uint8_t* data, size_t length) {
    Serial.println("WiFi時刻同期を開始...");
    
    // WiFi接続試行
    if (WiFi.status() != WL_CONNECTED) {
        WiFi.begin(ssid, password);
        
        int attempts = 0;
        while (WiFi.status() != WL_CONNECTED && attempts < 20) {
            delay(500);
            Serial.print(".");
            attempts++;
        }
        
        if (WiFi.status() == WL_CONNECTED) {
            Serial.println("\nWiFi接続成功");
            Serial.print("IP: ");
            Serial.println(WiFi.localIP());
        } else {
            Serial.println("\nWiFi接続失敗");
            
            // 失敗応答
            uint8_t response[2] = {CMD_WIFI_SYNC, 0}; // 0 = 失敗
            if (deviceConnected && pResponseCharacteristic) {
                pResponseCharacteristic->setValue(response, 2);
                pResponseCharacteristic->notify();
            }
            return;
        }
    }
    
    // NTP時刻同期
    configTime(9 * 3600, 0, "pool.ntp.org", "time.nist.gov"); // JST (UTC+9)
    
    struct tm timeinfo;
    int attempts = 0;
    while (!getLocalTime(&timeinfo) && attempts < 10) {
        delay(1000);
        Serial.println("NTP時刻取得中...");
        attempts++;
    }
    
    if (getLocalTime(&timeinfo)) {
        Serial.println("NTP時刻同期成功");
        Serial.printf("現在時刻: %04d/%02d/%02d %02d:%02d:%02d\n",
                     timeinfo.tm_year + 1900, timeinfo.tm_mon + 1, timeinfo.tm_mday,
                     timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
        
        // 成功応答
        uint8_t response[2] = {CMD_WIFI_SYNC, 1}; // 1 = 成功
        if (deviceConnected && pResponseCharacteristic) {
            pResponseCharacteristic->setValue(response, 2);
            pResponseCharacteristic->notify();
        }
    } else {
        Serial.println("NTP時刻同期失敗");
        
        // 失敗応答
        uint8_t response[2] = {CMD_WIFI_SYNC, 0}; // 0 = 失敗
        if (deviceConnected && pResponseCharacteristic) {
            pResponseCharacteristic->setValue(response, 2);
            pResponseCharacteristic->notify();
        }
    }
    
    // WiFi切断（省電力）
    WiFi.disconnect();
    Serial.println("WiFi切断（省電力モード）");
}

void handleTimeSync(uint8_t* data, size_t length) {
    if (length < 9) return;
    
    int64_t t1 = 0;
    memcpy(&t1, data + 1, 8);
    
    // ESP32側もUnixタイムスタンプ風に調整（millis基準）
    int64_t t2 = millis();
    int64_t t3 = millis() + 1; // 1ms後
    
    uint8_t response[25];
    response[0] = CMD_TIME_SYNC;
    memcpy(response + 1, &t1, 8);
    memcpy(response + 9, &t2, 8);
    memcpy(response + 17, &t3, 8);
    
    if (deviceConnected && pResponseCharacteristic) {
        pResponseCharacteristic->setValue(response, 25);
        pResponseCharacteristic->notify();
    }
    
    Serial.printf("Time sync: Web=%lld, ESP32=%lld\n", t1, t2);
}

void handleMotorCommand(uint8_t* data, size_t length) {
    if (length < 20) return;
    
    totalCommands++;
    
    uint8_t motorCmd = data[1];
    int64_t sentAt, delayMs;
    uint16_t sequence;
    
    memcpy(&sentAt, data + 2, 8);
    memcpy(&delayMs, data + 10, 8);  // 相対遅延時間
    memcpy(&sequence, data + 18, 2);
    
    int64_t receivedAt = millis();
    
    // 指定された遅延時間待機
    if (delayMs > 0 && delayMs < 1000) {
        delay(delayMs);
    }
    
    int64_t executedAt = millis();
    
    // モーター制御
    digitalWrite(MOTOR_PIN, HIGH);
    delayMicroseconds(100);
    digitalWrite(MOTOR_PIN, LOW);
    
    // 受信・実行時刻を含む応答
    uint8_t response[12];
    response[0] = CMD_MOTOR_CMD;
    response[1] = motorCmd;
    memcpy(response + 2, &receivedAt, 4);  // 受信時刻（4バイト）
    memcpy(response + 6, &executedAt, 4);  // 実行時刻（4バイト）
    memcpy(response + 10, &sequence, 2);   // シーケンス番号
    
    if (deviceConnected && pResponseCharacteristic) {
        pResponseCharacteristic->setValue(response, 12);
        pResponseCharacteristic->notify();
    }
    
    Serial.printf("[%d] Motor: delay=%lldms, actual=%lldms\n", 
                  sequence, delayMs, executedAt - receivedAt);
}

// ===== BLEコールバッククラス =====
class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
        deviceConnected = true;
        digitalWrite(LED_PIN, HIGH);
        Serial.println("BLE Connected");
    }
    
    void onDisconnect(BLEServer* pServer) {
        deviceConnected = false;
        digitalWrite(LED_PIN, LOW);
        Serial.println("BLE Disconnected");
        pServer->getAdvertising()->start();
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
                case CMD_WIFI_SYNC:
                    handleWiFiSync(data, length);
                    break;
                default:
                    Serial.printf("Unknown cmd: 0x%02X\n", command);
                    break;
            }
        }
    }
};

// ===== メイン関数 =====
void setup() {
    Serial.begin(115200);
    Serial.println("ESP32 BLE Timer Starting...");
    
    // GPIO初期化
    pinMode(MOTOR_PIN, OUTPUT);
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(MOTOR_PIN, LOW);
    digitalWrite(LED_PIN, LOW);
    
    // BLE初期化
    BLEDevice::init("ESP32-Timer");
    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new MyServerCallbacks());
    
    pService = pServer->createService(SERVICE_UUID);
    
    pCommandCharacteristic = pService->createCharacteristic(
        COMMAND_CHAR_UUID,
        BLECharacteristic::PROPERTY_WRITE
    );
    pCommandCharacteristic->setCallbacks(new CommandCallbacks());
    
    pResponseCharacteristic = pService->createCharacteristic(
        RESPONSE_CHAR_UUID,
        BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
    );
    pResponseCharacteristic->addDescriptor(new BLE2902());
    
    pService->start();
    
    BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(false);
    pAdvertising->setMinPreferred(0x0);
    BLEDevice::startAdvertising();
    
    Serial.println("BLE Ready. Waiting for connection...");
}

void loop() {
    // シリアル時刻同期処理
    if (Serial.available()) {
        String command = Serial.readStringUntil('\n');
        command.trim();
        
        if (command.startsWith("SYNC:")) {
            // 高精度時刻同期
            float webTime = command.substring(5).toFloat();
            
            // ESP32受信時刻（マイクロ秒精度）
            float t2 = (float)esp_timer_get_time() / 1000.0; // ミリ秒に変換
            
            // 最小限の処理時間
            delayMicroseconds(10);
            
            // ESP32送信時刻
            float t3 = (float)esp_timer_get_time() / 1000.0;
            
            // 応答送信（高速）
            Serial.printf("SYNC_ACK:%.3f:%.3f\n", t2, t3);
            Serial.flush(); // 即座に送信
        }
    }
    
    // 接続状態監視
    static unsigned long lastCheck = 0;
    if (millis() - lastCheck > 10000) {
        if (deviceConnected) {
            Serial.printf("BLE Connected. Total commands: %d\n", totalCommands);
        } else {
            Serial.println("BLE Ready. Waiting for connection...");
        }
        lastCheck = millis();
    }
    
    delay(10); // シリアル応答性向上
}