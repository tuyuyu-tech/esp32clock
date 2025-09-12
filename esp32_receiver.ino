#include <esp_now.h>
#include <WiFi.h>

// 信号パケット構造体
typedef struct {
    uint16_t sequence;
    uint32_t send_time;
} signal_packet_t;

// 測定データ保存用
uint32_t first_receive_time = 0;
uint32_t receive_times[20];
uint16_t received_sequences[20];
int received_count = 0;
bool baseline_set = false;
bool test_active = false;

void setup() {
    Serial.begin(115200);
    delay(1000);
    
    Serial.println("=== ESP32-B: ESP-NOW Receiver ===");
    Serial.println("750ms周期信号の受信タイミング測定");
    
    // WiFi Station モード
    WiFi.mode(WIFI_STA);
    
    // MACアドレス表示
    Serial.printf("Receiver MAC: %s\n", WiFi.macAddress().c_str());
    Serial.println("注意: 送信側でこのMACアドレスを設定してください");
    
    // ESP-NOW初期化
    if (esp_now_init() != ESP_OK) {
        Serial.println("Error initializing ESP-NOW");
        return;
    }
    
    // 受信コールバック登録
    esp_now_register_recv_cb(onDataReceived);
    
    Serial.println("\nReady to receive signals...");
    Serial.println("Expected: 20 signals at 750ms intervals");
    Serial.println("Output format: Signal #N: XXXms");
    Serial.println("========================================");
}

void loop() {
    // テスト完了後の統計表示
    static bool stats_shown = false;
    if (received_count >= 20 && !stats_shown) {
        delay(1000); // 最後の信号処理を待つ
        showStatistics();
        stats_shown = true;
        
        // リセット準備
        Serial.println("\nPress any key to reset for next test...");
    }
    
    // リセット機能
    if (Serial.available() > 0 && stats_shown) {
        Serial.read();
        resetTest();
        stats_shown = false;
    }
    
    delay(100);
}

void onDataReceived(const esp_now_recv_info_t *recv_info, const uint8_t *data, int len) {
    if (len != sizeof(signal_packet_t)) {
        Serial.println("Invalid packet size received");
        return;
    }
    
    signal_packet_t *packet = (signal_packet_t*)data;
    uint32_t now = millis();
    
    // 初回受信時の処理
    if (!baseline_set) {
        first_receive_time = now;
        baseline_set = true;
        test_active = true;
        Serial.println("=== Reception Started ===");
        Serial.printf("Signal #1: 0ms (baseline)\n");
    } else {
        // 基準からの相対時間を計算
        uint32_t relative_time = now - first_receive_time;
        Serial.printf("Signal #%d: %ums\n", packet->sequence + 1, relative_time);
    }
    
    // データを保存
    if (received_count < 20) {
        receive_times[received_count] = now;
        received_sequences[received_count] = packet->sequence;
        received_count++;
    }
    
    // 20個受信完了の通知
    if (received_count >= 20) {
        Serial.println("=== All 20 signals received ===");
        test_active = false;
    }
}

void showStatistics() {
    Serial.println("\n" + String('=', 50));
    Serial.println("           TEST RESULTS");
    Serial.println(String('=', 50));
    
    Serial.printf("Received: %d/20 signals\n", received_count);
    Serial.printf("Test duration: %.3f seconds\n", (receive_times[received_count-1] - first_receive_time) / 1000.0);
    
    Serial.println("\nTiming Analysis:");
    Serial.println("Seq#  Received   Expected   Deviation");
    Serial.println("----  --------   --------   ---------");
    
    float total_deviation = 0;
    int max_deviation = 0;
    int min_deviation = 999999;
    
    for (int i = 0; i < received_count; i++) {
        uint32_t relative = receive_times[i] - first_receive_time;
        uint32_t expected = i * 750; // 期待値：0, 750, 1500, 2250...
        int32_t deviation = relative - expected;
        
        total_deviation += abs(deviation);
        if (abs(deviation) > max_deviation) max_deviation = abs(deviation);
        if (abs(deviation) < min_deviation) min_deviation = abs(deviation);
        
        Serial.printf("%2d:   %4ums     %4ums     %+4dms\n", 
                     i + 1, relative, expected, deviation);
    }
    
    // 統計サマリー
    Serial.println(String('-', 40));
    Serial.printf("Average deviation: %.1fms\n", total_deviation / received_count);
    Serial.printf("Max deviation:     %dms\n", max_deviation);
    Serial.printf("Min deviation:     %dms\n", min_deviation);
    
    // 精度評価
    Serial.println("\nPrecision Analysis:");
    int within_1ms = 0, within_5ms = 0, within_10ms = 0;
    
    for (int i = 0; i < received_count; i++) {
        uint32_t relative = receive_times[i] - first_receive_time;
        uint32_t expected = i * 750;
        int32_t abs_deviation = abs(relative - expected);
        
        if (abs_deviation <= 1) within_1ms++;
        if (abs_deviation <= 5) within_5ms++;
        if (abs_deviation <= 10) within_10ms++;
    }
    
    Serial.printf("Within ±1ms:  %2d/20 (%3d%%)\n", within_1ms, (within_1ms * 100) / 20);
    Serial.printf("Within ±5ms:  %2d/20 (%3d%%)\n", within_5ms, (within_5ms * 100) / 20);
    Serial.printf("Within ±10ms: %2d/20 (%3d%%)\n", within_10ms, (within_10ms * 100) / 20);
    
    Serial.println(String('=', 50));
}

void resetTest() {
    baseline_set = false;
    test_active = false;
    received_count = 0;
    first_receive_time = 0;
    
    memset(receive_times, 0, sizeof(receive_times));
    memset(received_sequences, 0, sizeof(received_sequences));
    
    Serial.println("Test reset. Ready for next measurement...");
    Serial.println("========================================");
}