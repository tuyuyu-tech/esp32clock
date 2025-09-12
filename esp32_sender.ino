#include <esp_now.h>
#include <WiFi.h>

// 信号パケット構造体
typedef struct {
    uint16_t sequence;
    uint32_t send_time;
} signal_packet_t;

// グローバル変数
signal_packet_t signal_data;
uint8_t receiver_mac[] = {0x24, 0x0A, 0xC4, 0x00, 0x00, 0x01}; // ESP32-BのMACアドレス（要変更）
int signal_count = 0;
const int MAX_SIGNALS = 20;
hw_timer_t *timer = NULL;
bool test_running = false;

// 前方宣言
void IRAM_ATTR sendSignal();

void setup() {
    Serial.begin(115200);
    delay(1000);
    
    Serial.println("=== ESP32-A: ESP-NOW Sender ===");
    Serial.println("750ms周期で20回信号送信");
    
    // WiFi Station モード
    WiFi.mode(WIFI_STA);
    
    // ESP-NOW初期化
    if (esp_now_init() != ESP_OK) {
        Serial.println("Error initializing ESP-NOW");
        return;
    }
    
    // 送信コールバック登録
    esp_now_register_send_cb(onDataSent);
    
    // 受信機ピア情報設定
    esp_now_peer_info_t peerInfo;
    memcpy(peerInfo.peer_addr, receiver_mac, 6);
    peerInfo.channel = 0;
    peerInfo.encrypt = false;
    
    // ピア追加
    if (esp_now_add_peer(&peerInfo) != ESP_OK) {
        Serial.println("Failed to add peer");
        return;
    }
    
    Serial.printf("Receiver MAC: %02X:%02X:%02X:%02X:%02X:%02X\n", 
                  receiver_mac[0], receiver_mac[1], receiver_mac[2], 
                  receiver_mac[3], receiver_mac[4], receiver_mac[5]);
    Serial.println("Press any key to start test...");
}

void loop() {
    if (Serial.available() > 0 && !test_running) {
        Serial.read(); // キー入力をクリア
        startTest();
    }
    delay(100);
}

void startTest() {
    test_running = true;
    signal_count = 0;
    
    Serial.println("\n=== Test Started ===");
    Serial.println("Sending 20 signals at 750ms intervals...");
    
    // ハードウェアタイマー設定 (Arduino Core 3.x対応)
    timer = timerBegin(1000000); // 1MHz
    timerAttachInterrupt(timer, &sendSignal);
    timerAlarm(timer, 750000, true, 0); // 750ms = 750,000μs, repeat=true, count=0
    
    // 最初の信号を即座に送信
    sendFirstSignal();
}

void sendFirstSignal() {
    signal_data.sequence = signal_count;
    signal_data.send_time = millis();
    
    esp_err_t result = esp_now_send(receiver_mac, (uint8_t*)&signal_data, sizeof(signal_data));
    
    Serial.printf("Signal #%d sent at %ums: %s\n", 
                  signal_count + 1,
                  signal_data.send_time,
                  result == ESP_OK ? "Success" : "Failed");
    
    signal_count++;
}

void IRAM_ATTR sendSignal() {
    if (signal_count >= MAX_SIGNALS) {
        timerStop(timer);
        timerEnd(timer);
        test_running = false;
        return;
    }
    
    signal_data.sequence = signal_count;
    signal_data.send_time = millis();
    
    esp_now_send(receiver_mac, (uint8_t*)&signal_data, sizeof(signal_data));
    signal_count++;
    
    if (signal_count >= MAX_SIGNALS) {
        Serial.println("All 20 signals sent!");
        test_running = false;
    }
}

void onDataSent(const wifi_tx_info_t *info, esp_now_send_status_t status) {
    Serial.printf("Signal #%d: %s\n", 
                  signal_data.sequence + 1, 
                  status == ESP_NOW_SEND_SUCCESS ? "Delivered" : "Failed");
    
    if (signal_data.sequence + 1 >= MAX_SIGNALS) {
        Serial.println("\n=== Test Complete ===");
        Serial.println("Press any key to restart test...");
    }
}