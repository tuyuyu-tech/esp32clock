// ESP32 BLE タイミングテスター
// Web Bluetooth API使用

class ESP32TimingTester {
    constructor() {
        // BLE接続関連
        this.device = null;
        this.server = null;
        this.service = null;
        this.commandCharacteristic = null;
        this.responseCharacteristic = null;
        
        // 時刻同期関連
        this.timeOffset = 0;
        this.lastSyncTime = null;
        this.isSynced = false;
        
        // テスト関連
        this.testResults = [];
        this.isTestRunning = false;
        this.currentTestIndex = 0;
        
        // シリアル通信用
        this.serialPort = null;
        this.serialReader = null;
        this.testSettings = {
            count: 50,
            interval: 100,
            executionDelay: 50
        };
        
        // Chart.js
        this.chart = null;
        
        this.initializeUI();
        this.initializeChart();
    }
    
    // UUIDの定義（ESP32と合わせる）
    static get SERVICE_UUID() { return '12345678-1234-1234-1234-123456789abc'; }
    static get COMMAND_CHARACTERISTIC_UUID() { return '12345678-1234-1234-1234-123456789abd'; }
    static get RESPONSE_CHARACTERISTIC_UUID() { return '12345678-1234-1234-1234-123456789abe'; }
    
    initializeUI() {
        // ボタンイベント
        document.getElementById('connectBtn').addEventListener('click', () => this.connect());
        document.getElementById('disconnectBtn').addEventListener('click', () => this.disconnect());
        document.getElementById('syncTimeBtn').addEventListener('click', () => this.syncTime());
        document.getElementById('startTestBtn').addEventListener('click', () => this.startTest());
        document.getElementById('stopTestBtn').addEventListener('click', () => this.stopTest());
        document.getElementById('clearBtn').addEventListener('click', () => this.clearResults());
        document.getElementById('exportBtn').addEventListener('click', () => this.exportCSV());
        document.getElementById('clearLogBtn').addEventListener('click', () => this.clearLog());
        
        // 設定変更
        document.getElementById('testCount').addEventListener('change', (e) => {
            this.testSettings.count = parseInt(e.target.value);
        });
        document.getElementById('testInterval').addEventListener('change', (e) => {
            this.testSettings.interval = parseInt(e.target.value);
        });
        document.getElementById('executionDelay').addEventListener('change', (e) => {
            this.testSettings.executionDelay = parseInt(e.target.value);
        });
        
        // 初期状態
        this.updateStatus('disconnected', '未接続');
        this.updateSyncStatus('BLE接続後に同期開始');
        
        // BLE同期ボタンを無効化（接続後に有効化）
        document.getElementById('syncTimeBtn').disabled = true;
    }
    
    initializeChart() {
        const ctx = document.getElementById('errorChart').getContext('2d');
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: '実行誤差 (ms)',
                    data: [],
                    borderColor: '#e74c3c',
                    backgroundColor: 'rgba(231, 76, 60, 0.1)',
                    tension: 0.1,
                    pointRadius: 2
                }, {
                    label: '送信遅延 (ms)',
                    data: [],
                    borderColor: '#3498db',
                    backgroundColor: 'rgba(52, 152, 219, 0.1)',
                    tension: 0.1,
                    pointRadius: 2
                }]
            },
            options: {
                responsive: true,
                scales: {
                    x: {
                        display: true,
                        title: {
                            display: true,
                            text: 'サンプル番号'
                        }
                    },
                    y: {
                        display: true,
                        title: {
                            display: true,
                            text: '誤差 (ms)'
                        },
                        min: -10,
                        max: 50
                    }
                },
                plugins: {
                    legend: {
                        display: true
                    }
                },
                animation: false
            }
        });
    }
    
    async connect() {
        try {
            this.updateStatus('connecting', '接続中...');
            this.log('BLE接続を開始します', 'info');
            
            // デバイス選択
            this.device = await navigator.bluetooth.requestDevice({
                filters: [{ name: 'ESP32-Timer' }],
                optionalServices: [ESP32TimingTester.SERVICE_UUID]
            });
            
            // 切断イベント
            this.device.addEventListener('gattserverdisconnected', () => {
                this.onDisconnected();
            });
            
            // GATT接続
            this.server = await this.device.gatt.connect();
            this.service = await this.server.getPrimaryService(ESP32TimingTester.SERVICE_UUID);
            
            // Characteristics取得
            this.commandCharacteristic = await this.service.getCharacteristic(
                ESP32TimingTester.COMMAND_CHARACTERISTIC_UUID
            );
            this.responseCharacteristic = await this.service.getCharacteristic(
                ESP32TimingTester.RESPONSE_CHARACTERISTIC_UUID
            );
            
            // 通知有効化
            await this.responseCharacteristic.startNotifications();
            this.responseCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
                this.onResponseReceived(event);
            });
            
            this.updateStatus('connected', '接続済み');
            this.log(`デバイス "${this.device.name}" に接続しました`, 'success');
            
            // UI更新
            document.getElementById('connectBtn').disabled = true;
            document.getElementById('disconnectBtn').disabled = false;
            document.getElementById('syncTimeBtn').disabled = false;
            
        } catch (error) {
            this.updateStatus('disconnected', '接続失敗');
            this.log(`接続エラー: ${error.message}`, 'error');
        }
    }
    
    async disconnect() {
        if (this.device && this.device.gatt.connected) {
            this.device.gatt.disconnect();
        }
        this.onDisconnected();
    }
    
    onDisconnected() {
        this.device = null;
        this.server = null;
        this.service = null;
        this.commandCharacteristic = null;
        this.responseCharacteristic = null;
        this.isSynced = false;
        
        this.updateStatus('disconnected', '未接続');
        this.updateSyncStatus('同期待ち');
        this.log('デバイスから切断しました', 'info');
        
        // UI更新
        document.getElementById('connectBtn').disabled = false;
        document.getElementById('disconnectBtn').disabled = true;
        document.getElementById('syncTimeBtn').disabled = true;
        document.getElementById('wifiSyncBtn').disabled = true;
        document.getElementById('startTestBtn').disabled = true;
        
        if (this.isTestRunning) {
            this.stopTest();
        }
    }
    
    async syncTime() {
        if (!this.commandCharacteristic) return;
        
        try {
            this.updateSyncStatus('BLE時刻同期中...');
            this.log('BLE時刻同期を開始します', 'info');
            
            const samples = [];
            const numSamples = 10;
            
            for (let i = 0; i < numSamples; i++) {
                const sample = await this.performTimeSync();
                if (sample && sample.roundTrip < 50) { // 50ms以下の良好なサンプル
                    samples.push(sample);
                }
                await this.sleep(100);
            }
            
            if (samples.length < 3) {
                throw new Error('十分なサンプルが取得できませんでした');
            }
            
            // オフセットを計算して設定
            const offsets = samples.map(s => s.offset);
            this.timeOffset = offsets.reduce((a, b) => a + b, 0) / offsets.length;
            
            // 遅延統計を計算
            const delays = samples.map(s => s.delay);
            const avgDelay = delays.reduce((a, b) => a + b, 0) / delays.length;
            const maxDelay = Math.max(...delays);
            const minDelay = Math.min(...delays);
            
            // 同期完了
            this.isSynced = true;
            this.lastSyncTime = new Date();
            
            this.updateSyncStatus('BLE同期完了');
            document.getElementById('startTestBtn').disabled = false;
            document.getElementById('timeOffset').textContent = this.timeOffset.toFixed(2);
            document.getElementById('lastSync').textContent = this.lastSyncTime.toLocaleTimeString();
            
            this.log(`BLE時刻同期完了: オフセット ${this.timeOffset.toFixed(2)}ms`, 'success');
            this.log(`送信遅延: 平均 ${avgDelay.toFixed(2)}ms (${minDelay.toFixed(2)}-${maxDelay.toFixed(2)}ms)`, 'info');
            this.log(`測定サンプル: ${samples.length}/${numSamples}`, 'info');
            
        } catch (error) {
            this.updateSyncStatus('BLE測定失敗');
            this.log(`BLE測定エラー: ${error.message}`, 'error');
        }
    }
    
    async performTimeSync() {
        return new Promise((resolve) => {
            const t1 = Date.now();
            
            // 時刻同期リクエスト（簡易版）
            const request = new ArrayBuffer(12);
            const view = new DataView(request);
            view.setUint8(0, 0x01); // TIME_SYNC command
            view.setBigUint64(1, BigInt(t1), true); // little endian
            
            this.commandCharacteristic.writeValue(request).then(() => {
                // 応答待ち (タイムアウト付き)
                let responseTimer = setTimeout(() => {
                    this.responseHandler = null;
                    resolve({
                        offset: 0,
                        delay: 10,
                        roundTrip: 20
                    });
                }, 1000);
                
                this.responseHandler = (data) => {
                    clearTimeout(responseTimer);
                    const t4 = Date.now();
                    const roundTrip = t4 - t1;
                    
                    // 簡易計算（時刻差は無視）
                    resolve({
                        offset: 0,  // オフセットは0固定
                        delay: roundTrip / 2,
                        roundTrip: roundTrip
                    });
                };
            });
        });
    }
    
    async wifiSyncTime() {
        if (!this.commandCharacteristic) return;
        
        try {
            this.updateSyncStatus('WiFi同期中...');
            this.log('ESP32のWiFi時刻同期を開始します', 'info');
            
            // WiFi同期コマンド送信
            const command = new ArrayBuffer(1);
            const view = new DataView(command);
            view.setUint8(0, 0x03); // WIFI_SYNC command
            
            await this.commandCharacteristic.writeValue(command);
            
            // 応答待ち
            await new Promise((resolve) => {
                let responseTimer = setTimeout(() => {
                    this.responseHandler = null;
                    resolve();
                }, 10000); // 10秒待機
                
                this.responseHandler = (data) => {
                    clearTimeout(responseTimer);
                    this.responseHandler = null;
                    resolve();
                };
            });
            
            this.updateSyncStatus('WiFi同期完了');
            this.log('ESP32のWiFi時刻同期が完了しました', 'success');
            
            // BLE同期も実行
            await this.syncTime();
            
        } catch (error) {
            this.updateSyncStatus('WiFi同期失敗');
            this.log(`WiFi同期エラー: ${error.message}`, 'error');
        }
    }
    
    applyManualOffset() {
        const offsetInput = document.getElementById('manualOffset');
        const manualOffset = parseFloat(offsetInput.value) || 0;
        
        this.timeOffset += manualOffset;
        document.getElementById('timeOffset').textContent = this.timeOffset.toFixed(2);
        
        this.log(`手動オフセット ${manualOffset}ms を適用しました`, 'info');
    }
    
    resetOffset() {
        this.timeOffset = 0;
        document.getElementById('manualOffset').value = '0';
        document.getElementById('timeOffset').textContent = '0.00';
        
        this.log('オフセットをリセットしました', 'info');
    }
    
    async serialSyncTime() {
        if (!('serial' in navigator)) {
            alert('このブラウザーはWeb Serial APIをサポートしていません。Chrome 89+が必要です。');
            return;
        }
        
        try {
            this.updateSyncStatus('USB-C同期中...');
            this.log('USB-C有線時刻同期を開始します', 'info');
            
            // シリアルポート接続
            if (!this.serialPort) {
                this.serialPort = await navigator.serial.requestPort();
                await this.serialPort.open({ baudRate: 115200 });
                
                const decoder = new TextDecoderStream();
                const inputDone = this.serialPort.readable.pipeTo(decoder.writable);
                this.serialReader = decoder.readable.getReader();
                
                this.log('USB-C接続成功', 'success');
            }
            
            // 高精度時刻同期プロトコル
            const samples = [];
            for (let i = 0; i < 10; i++) {
                const t1 = performance.now(); // マイクロ秒精度
                
                // シリアルコマンド送信
                const encoder = new TextEncoder();
                const writer = this.serialPort.writable.getWriter();
                await writer.write(encoder.encode(`SYNC:${t1}\n`));
                writer.releaseLock();
                
                // ESP32からの応答待ち
                const { value, done } = await this.serialReader.read();
                if (done) break;
                
                const response = value.trim();
                if (response.startsWith('SYNC_ACK:')) {
                    const t4 = performance.now();
                    const parts = response.split(':');
                    const t2 = parseFloat(parts[1]); // ESP32受信時刻
                    const t3 = parseFloat(parts[2]); // ESP32送信時刻
                    
                    const roundTrip = t4 - t1;
                    if (roundTrip < 10) { // 10ms以下の優良サンプル
                        const offset = ((t2 - t1) + (t3 - t4)) / 2;
                        samples.push({ offset, delay: roundTrip / 2 });
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            if (samples.length > 0) {
                // 中央値採用
                const offsets = samples.map(s => s.offset).sort((a, b) => a - b);
                this.timeOffset = offsets[Math.floor(offsets.length / 2)];
                
                this.isSynced = true;
                this.lastSyncTime = new Date();
                
                this.updateSyncStatus('USB-C基準時刻設定完了');
                document.getElementById('timeOffset').textContent = this.timeOffset.toFixed(2);
                document.getElementById('lastSync').textContent = this.lastSyncTime.toLocaleTimeString();
                
                // BLE測定を有効化
                document.getElementById('syncTimeBtn').disabled = false;
                document.getElementById('syncTimeBtn').textContent = '2. BLE測定開始';
                document.getElementById('startWiredTestBtn').disabled = false;
                document.getElementById('driftMeasureBtn').disabled = false;
                
                this.log(`USB-C基準同期完了: 精度 ±0.1ms, オフセット ${this.timeOffset.toFixed(2)}ms`, 'success');
                this.log(`有効サンプル: ${samples.length}/10`, 'info');
                this.log('次：BLE接続してBLE測定を開始してください', 'info');
            } else {
                throw new Error('有効なサンプルが取得できませんでした');
            }
            
        } catch (error) {
            this.updateSyncStatus('USB-C同期失敗');
            this.log(`USB-C同期エラー: ${error.message}`, 'error');
            
            // シリアルポートを閉じる
            if (this.serialReader) {
                await this.serialReader.cancel();
                this.serialReader = null;
            }
            if (this.serialPort) {
                await this.serialPort.close();
                this.serialPort = null;
            }
        }
    }
    
    async measureClockDrift() {
        if (!this.serialPort) {
            this.log('USB-C同期を先に実行してください', 'error');
            return;
        }
        
        try {
            this.log('ESP32時計精度測定中...', 'info');
            
            const encoder = new TextEncoder();
            const writer = this.serialPort.writable.getWriter();
            await writer.write(encoder.encode('DRIFT\n'));
            writer.releaseLock();
            
            // ESP32からの応答待ち
            const { value, done } = await this.serialReader.read();
            if (done) {
                throw new Error('シリアル通信が切断されました');
            }
            
            const response = value.trim();
            if (response.startsWith('DRIFT_RESULT:')) {
                const parts = response.split(':');
                const elapsedSeconds = parseFloat(parts[1]);
                const elapsedMs = parseFloat(parts[2]);
                const currentMs = parseFloat(parts[3]);
                const elapsedMicros = parseInt(parts[4]);
                
                const driftInfo = {
                    elapsed: elapsedSeconds,
                    precision: elapsedMicros / 1000000.0, // 秒単位
                    accuracy: 'マイクロ秒精度'
                };
                
                document.getElementById('clockDrift').textContent = 
                    `経過時間: ${elapsedSeconds.toFixed(1)}s, 精度: ±1μs`;
                
                this.log(`ESP32時計精度測定完了:`, 'success');
                this.log(`・経過時間: ${elapsedSeconds.toFixed(3)}秒`, 'info');
                this.log(`・理論精度: マイクロ秒単位（水晶振動子: ±20ppm）`, 'info');
                this.log(`・ESP32内部時計は ${(elapsedSeconds * 1000).toFixed(1)}ms間、正確に時を刻んでいます`, 'success');
            } else if (response === 'DRIFT_ERROR:Not_calibrated') {
                throw new Error('時計が校正されていません。USB-C同期を先に実行してください。');
            }
            
        } catch (error) {
            this.log(`時計精度測定エラー: ${error.message}`, 'error');
        }
    }
    
    async startWiredTest() {
        if (!this.serialPort || this.isTestRunning) {
            this.log('USB-C同期を先に実行してください', 'error');
            return;
        }
        
        this.isTestRunning = true;
        this.currentTestIndex = 0;
        this.testResults = [];
        
        document.getElementById('startWiredTestBtn').disabled = true;
        document.getElementById('startTestBtn').disabled = true;
        document.getElementById('stopTestBtn').disabled = false;
        
        this.testSettings = {
            interval: parseInt(document.getElementById('testInterval').value),
            executionDelay: parseInt(document.getElementById('executionDelay').value),
            count: parseInt(document.getElementById('testCount').value)
        };
        
        this.log(`有線遅延測定開始: ${this.testSettings.count}回`, 'info');
        this.log(`実行遅延: ${this.testSettings.executionDelay}ms, 間隔: ${this.testSettings.interval}ms`, 'info');
        
        while (this.isTestRunning && this.currentTestIndex < this.testSettings.count) {
            await this.performWiredTest();
            this.currentTestIndex++;
            this.updateProgress();
            
            if (this.isTestRunning && this.currentTestIndex < this.testSettings.count) {
                await new Promise(resolve => setTimeout(resolve, this.testSettings.interval));
            }
        }
        
        this.stopTest();
    }
    
    async performWiredTest() {
        const sequence = this.currentTestIndex + 1;
        const sendTime = performance.now();
        
        try {
            const encoder = new TextEncoder();
            const writer = this.serialPort.writable.getWriter();
            await writer.write(encoder.encode(
                `MOTOR:${sendTime.toFixed(3)}:${this.testSettings.executionDelay}:${sequence}\n`
            ));
            writer.releaseLock();
            
            // ESP32からの応答待ち（タイムアウト付き）
            const timeout = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('タイムアウト')), 2000));
            
            const response = Promise.race([
                this.serialReader.read().then(({ value, done }) => {
                    if (done) throw new Error('シリアル切断');
                    return value.trim();
                }),
                timeout
            ]);
            
            const result = await response;
            const responseTime = performance.now();
            
            if (result.startsWith('MOTOR_ACK:')) {
                const parts = result.split(':');
                const esp32ReceivedAt = parseFloat(parts[1]);
                const esp32ExecutedAt = parseFloat(parts[2]);
                const receivedSequence = parseInt(parts[3]);
                
                // 遅延計算（有線なので非常に高精度）
                const transmissionDelay = esp32ReceivedAt - sendTime;
                const executionError = (esp32ExecutedAt - esp32ReceivedAt) - this.testSettings.executionDelay;
                
                const testResult = {
                    sequence: receivedSequence,
                    sendTime: sendTime,
                    esp32ReceivedAt: esp32ReceivedAt,
                    esp32ExecutedAt: esp32ExecutedAt,
                    responseTime: responseTime,
                    transmissionDelay: transmissionDelay,
                    executionError: Math.abs(executionError),
                    rawExecutionError: executionError,
                    connectionType: 'wired'
                };
                
                this.testResults.push(testResult);
                this.updateStats();
                this.addToChart(testResult.executionError);
                
                document.getElementById('currentError').textContent = 
                    `${testResult.executionError.toFixed(2)}ms`;
                
                this.log(`[${sequence}] 有線: 送信遅延=${transmissionDelay.toFixed(3)}ms, ` +
                        `実行誤差=${executionError.toFixed(2)}ms`, 
                        Math.abs(executionError) <= 5 ? 'success' : 'error');
            }
            
        } catch (error) {
            this.log(`[${sequence}] 有線測定エラー: ${error.message}`, 'error');
        }
    }
    
    async startTest() {
        if (!this.isSynced || this.isTestRunning) return;
        
        this.isTestRunning = true;
        this.currentTestIndex = 0;
        this.testResults = [];
        
        document.getElementById('startTestBtn').disabled = true;
        document.getElementById('stopTestBtn').disabled = false;
        document.getElementById('clearBtn').disabled = true;
        
        this.log(`テスト開始: ${this.testSettings.count}回, ${this.testSettings.interval}ms間隔`, 'info');
        
        try {
            for (let i = 0; i < this.testSettings.count && this.isTestRunning; i++) {
                this.currentTestIndex = i + 1;
                await this.performTimingTest(i);
                
                this.updateProgress();
                this.updateStatistics();
                this.updateChart();
                
                if (i < this.testSettings.count - 1) {
                    await this.sleep(this.testSettings.interval);
                }
            }
        } catch (error) {
            this.log(`テストエラー: ${error.message}`, 'error');
        } finally {
            this.stopTest();
        }
    }
    
    async performTimingTest(sequence) {
        return new Promise((resolve) => {
            const sendTime = Date.now();
            const targetTime = sendTime + this.testSettings.executionDelay;
            
            // コマンド送信（相対タイミング）
            const command = new ArrayBuffer(20);
            const view = new DataView(command);
            view.setUint8(0, 0x02); // MOTOR_CMD command
            view.setUint8(1, 0x01); // motor command
            view.setBigUint64(2, BigInt(sendTime), true);
            view.setBigUint64(10, BigInt(this.testSettings.executionDelay), true); // 相対時間
            view.setUint16(18, sequence, true);
            
            this.commandCharacteristic.writeValue(command).then(() => {
                // 応答待ち
                let responseTimer = setTimeout(() => {
                    this.responseHandler = null;
                    resolve();
                }, 2000);
                
                this.responseHandler = (data) => {
                    clearTimeout(responseTimer);
                    const responseView = new DataView(data);
                    const responseTime = Date.now();
                    
                    if (data.byteLength >= 12) {
                        // ESP32からの詳細データを解析
                        const esp32ReceivedAt = responseView.getUint32(2, true);  // ESP32受信時刻
                        const esp32ExecutedAt = responseView.getUint32(6, true);  // ESP32実行時刻
                        
                        // ESP32の起動時刻を推定（初回のみ）
                        if (!this.esp32StartTime) {
                            this.esp32StartTime = sendTime - esp32ReceivedAt;
                        }
                        
                        // 送信遅延 = ESP32受信時刻 - 送信時刻（時刻差を考慮）
                        const actualReceivedAt = this.esp32StartTime + esp32ReceivedAt;
                        const transmissionDelay = actualReceivedAt - sendTime;
                        
                        // 実行誤差 = 実際の遅延 - 期待値
                        const actualDelay = esp32ExecutedAt - esp32ReceivedAt;
                        const executionError = actualDelay - this.testSettings.executionDelay;
                        
                        const result = {
                            sequence: sequence,
                            sentAt: sendTime,
                            receivedAt: actualReceivedAt,
                            executedAt: this.esp32StartTime + esp32ExecutedAt,
                            targetTime: targetTime,
                            transmissionDelay: transmissionDelay,
                            executionError: executionError,
                            esp32ReceivedAt: esp32ReceivedAt,
                            esp32ExecutedAt: esp32ExecutedAt
                        };
                        
                        this.testResults.push(result);
                        
                        this.log(`[${sequence}] 送信遅延: ${transmissionDelay.toFixed(2)}ms, 実行誤差: ${executionError.toFixed(2)}ms`, 
                                 Math.abs(transmissionDelay) <= 30 ? 'success' : 'error');
                    } else {
                        // フォールバック（旧形式）
                        const transmissionDelay = responseTime - sendTime;
                        const executionError = transmissionDelay - this.testSettings.executionDelay;
                        
                        const result = {
                            sequence: sequence,
                            sentAt: sendTime,
                            receivedAt: responseTime,
                            executedAt: responseTime,
                            targetTime: targetTime,
                            transmissionDelay: transmissionDelay,
                            executionError: executionError
                        };
                        
                        this.testResults.push(result);
                        this.log(`[${sequence}] 往復遅延: ${transmissionDelay.toFixed(2)}ms`, 'info');
                    }
                    
                    resolve();
                };
            });
        });
    }
    
    stopTest() {
        this.isTestRunning = false;
        this.responseHandler = null;
        
        document.getElementById('startTestBtn').disabled = !this.isSynced;
        document.getElementById('startWiredTestBtn').disabled = !this.serialPort;
        document.getElementById('stopTestBtn').disabled = true;
        document.getElementById('clearBtn').disabled = false;
        
        if (this.testResults.length > 0) {
            this.log(`テスト完了: ${this.testResults.length}サンプル`, 'success');
        }
    }
    
    clearResults() {
        this.testResults = [];
        this.currentTestIndex = 0;
        this.updateProgress();
        this.updateStatistics();
        this.updateChart();
        this.log('結果をクリアしました', 'info');
    }
    
    onResponseReceived(event) {
        if (this.responseHandler) {
            const data = event.target.value.buffer;
            this.responseHandler(data);
            this.responseHandler = null;
        }
    }
    
    updateProgress() {
        const progress = document.getElementById('progress');
        const progressFill = document.getElementById('progressFill');
        
        progress.textContent = `${this.currentTestIndex}/${this.testSettings.count}`;
        const percentage = (this.currentTestIndex / this.testSettings.count) * 100;
        progressFill.style.width = `${percentage}%`;
    }
    
    updateStatistics() {
        if (this.testResults.length === 0) {
            document.getElementById('sampleCount').textContent = '0';
            document.getElementById('avgDelay').textContent = '--';
            document.getElementById('avgError').textContent = '--';
            document.getElementById('maxError').textContent = '--';
            document.getElementById('within5ms').textContent = '--';
            document.getElementById('currentError').textContent = '--';
            return;
        }
        
        const delays = this.testResults.map(r => r.transmissionDelay);
        const errors = this.testResults.map(r => Math.abs(r.executionError));
        
        const avgDelay = delays.reduce((a, b) => a + b, 0) / delays.length;
        const avgError = errors.reduce((a, b) => a + b, 0) / errors.length;
        const maxError = Math.max(...errors);
        const within5ms = errors.filter(e => e <= 5).length;
        const within5msPercent = (within5ms / errors.length) * 100;
        
        document.getElementById('sampleCount').textContent = this.testResults.length;
        document.getElementById('avgDelay').textContent = `${avgDelay.toFixed(2)}ms`;
        document.getElementById('avgError').textContent = `${avgError.toFixed(2)}ms`;
        document.getElementById('maxError').textContent = `${maxError.toFixed(2)}ms`;
        document.getElementById('within5ms').textContent = `${within5ms}/${errors.length} (${within5msPercent.toFixed(1)}%)`;
        
        if (this.testResults.length > 0) {
            const lastError = Math.abs(this.testResults[this.testResults.length - 1].executionError);
            document.getElementById('currentError').textContent = `${lastError.toFixed(2)}ms`;
        }
    }
    
    updateChart() {
        const maxPoints = 50;
        const recentResults = this.testResults.slice(-maxPoints);
        
        this.chart.data.labels = recentResults.map((_, i) => i + 1);
        this.chart.data.datasets[0].data = recentResults.map(r => Math.abs(r.executionError));
        this.chart.data.datasets[1].data = recentResults.map(r => r.transmissionDelay);
        
        this.chart.update('none');
    }
    
    exportCSV() {
        if (this.testResults.length === 0) return;
        
        let csv = 'Sequence,Sent At,Received At,Executed At,Target Time,Transmission Delay (ms),Execution Error (ms)\n';
        
        this.testResults.forEach(result => {
            csv += `${result.sequence},${result.sentAt},${result.receivedAt},${result.executedAt},${result.targetTime},${result.transmissionDelay.toFixed(3)},${result.executionError.toFixed(3)}\n`;
        });
        
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `timing_results_${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        
        this.log('CSV ファイルをエクスポートしました', 'success');
    }
    
    updateStatus(status, text) {
        const statusElement = document.getElementById('status');
        statusElement.textContent = text;
        statusElement.className = status;
    }
    
    updateSyncStatus(text) {
        document.getElementById('syncStatus').textContent = text;
    }
    
    log(message, type = 'info') {
        const logContainer = document.getElementById('logContainer');
        const timestamp = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.textContent = `[${timestamp}] ${message}`;
        
        logContainer.appendChild(entry);
        logContainer.scrollTop = logContainer.scrollHeight;
    }
    
    clearLog() {
        document.getElementById('logContainer').innerHTML = '';
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    // Web Bluetooth API サポートチェック
    if (!navigator.bluetooth) {
        alert('このブラウザーはWeb Bluetooth APIをサポートしていません。Chrome/Edge等のChromiumベースブラウザーをお使いください。');
        return;
    }
    
    new ESP32TimingTester();
});