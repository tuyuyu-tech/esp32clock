#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

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

// BLE変数
BLEServer* pServer = nullptr;
BLEService* pService = nullptr;
BLECharacteristic* pCommandCharacteristic = nullptr;
BLECharacteristic* pResponseCharacteristic = nullptr;
bool deviceConnected = false;

// 統計用（簡素化）
uint32_t totalCommands = 0;

// ===== 関数定義（クラスより前に配置）=====
void handleTimeSync(uint8_t* data, size_t length) {
    if (length < 9) return;
    
    int64_t t1 = 0;
    memcpy(&t1, data + 1, 8);
    
    int64_t t2 = millis();
    int64_t t3 = millis();
    
    uint8_t response[25];
    response[0] = CMD_TIME_SYNC;
    memcpy(response + 1, &t1, 8);
    memcpy(response + 9, &t2, 8);
    memcpy(response + 17, &t3, 8);
    
    if (deviceConnected && pResponseCharacteristic) {
        pResponseCharacteristic->setValue(response, 25);
        pResponseCharacteristic->notify();
    }
    
    Serial.printf("Time sync: %lld\n", t1);
}

void handleMotorCommand(uint8_t* data, size_t length) {
    if (length < 20) return;
    
    totalCommands++;
    
    uint8_t motorCmd = data[1];
    int64_t sentAt, executeAt;
    uint16_t sequence;
    
    memcpy(&sentAt, data + 2, 8);
    memcpy(&executeAt, data + 10, 8);
    memcpy(&sequence, data + 18, 2);
    
    int64_t receivedAt = millis();
    int64_t delayMs = executeAt - receivedAt;
    
    // 簡単な遅延実行
    if (delayMs > 0 && delayMs < 1000) {
        delay(delayMs);
    }
    
    int64_t executedAt = millis();
    
    // モーター制御
    digitalWrite(MOTOR_PIN, HIGH);
    delayMicroseconds(100);
    digitalWrite(MOTOR_PIN, LOW);
    
    // 応答
    uint8_t response[20];
    response[0] = CMD_MOTOR_CMD;
    response[1] = motorCmd;
    memcpy(response + 2, &receivedAt, 8);
    memcpy(response + 10, &executedAt, 8);
    memcpy(response + 18, &sequence, 2);
    
    if (deviceConnected && pResponseCharacteristic) {
        pResponseCharacteristic->setValue(response, 20);
        pResponseCharacteristic->notify();
    }
    
    Serial.printf("[%d] Motor executed\n", sequence);
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
    static unsigned long lastCheck = 0;
    if (millis() - lastCheck > 10000) {
        if (deviceConnected) {
            Serial.printf("Active. Commands: %d\n", totalCommands);
        }
        lastCheck = millis();
    }
    delay(500);
}