class ESP32TimingTester {
    constructor() {
        this.device = null;
        this.commandCharacteristic = null;
        this.responseCharacteristic = null;
        this.responseHandler = null;
        this.timeOffset = 0;
        this.lastSyncTime = null;
        this.isSynced = false;
        this.isTestRunning = false;
        this.currentTestIndex = 0;
        this.testResults = [];
        this.esp32StartTime = null;
        this.testSettings = {
            interval: 500,
            executionDelay: 50,
            count: 50
        };
        
        this.initializeUI();
        this.initializeChart();
    }
    
    // BLE UUIDs
    static get SERVICE_UUID() { return '12345678-1234-1234-1234-123456789abc'; }
    static get COMMAND_CHARACTERISTIC_UUID() { return '12345678-1234-1234-1234-123456789abd'; }
    static get RESPONSE_CHARACTERISTIC_UUID() { return '12345678-1234-1234-1234-123456789abe'; }
    
    initializeUI() {
        // ボタンイベント
        document.getElementById('connectBtn').addEventListener('click', () => this.connect());
        document.getElementById('disconnectBtn').addEventListener('click', () => this.disconnect());
        document.getElementById('syncTimeBtn').addEventListener('click', () => this.syncTime());
        document.getElementById('startTestBtn').addEventListener('click', () => this.startTest());
        document.getElementById('startDirectTestBtn').addEventListener('click', () => this.startDirectTest());
        document.getElementById('stopTestBtn').addEventListener('click', () => this.stopTest());
        document.getElementById('clearBtn').addEventListener('click', () => this.clearResults());
        document.getElementById('exportBtn').addEventListener('click', () => this.exportCSV());
        document.getElementById('clearLogBtn').addEventListener('click', () => this.clearLog());
        
        // テスト設定
        document.getElementById('testInterval').addEventListener('change', (e) => {
            this.testSettings.interval = parseInt(e.target.value);
        });
        document.getElementById('executionDelay').addEventListener('change', (e) => {
            this.testSettings.executionDelay = parseInt(e.target.value);
        });
        document.getElementById('testCount').addEventListener('change', (e) => {
            this.testSettings.count = parseInt(e.target.value);
        });
        
        // 初期状態
        this.updateStatus('disconnected', '未接続');
        this.updateSyncStatus('BLE接続後に同期開始');
        document.getElementById('syncTimeBtn').disabled = true;
    }
    
    initializeChart() {
        const ctx = document.getElementById('errorChart').getContext('2d');
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: '送信遅延 (ms)',
                    data: [],
                    borderColor: '#3498db',
                    backgroundColor: 'rgba(52, 152, 219, 0.1)',
                    borderWidth: 2,
                    tension: 0.4,
                    pointRadius: 2
                }, {
                    label: '遅延誤差 (ms)',
                    data: [],
                    borderColor: '#e74c3c',
                    backgroundColor: 'rgba(231, 76, 60, 0.1)',
                    borderWidth: 2,
                    tension: 0.4,
                    pointRadius: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: '誤差 (ms)'
                        }
                    },
                    x: {
                        title: {
                            display: true,
                            text: 'サンプル番号'
                        }
                    }
                },
                plugins: {
                    title: {
                        display: true,
                        text: 'リアルタイム送信遅延と誤差'
                    }
                }
            }
        });
    }
    
    async connect() {
        try {
            this.updateStatus('connecting', '接続中...');
            this.log('BLEデバイスを検索中...', 'info');
            
            this.device = await navigator.bluetooth.requestDevice({
                filters: [{ name: 'ESP32-Timer' }],
                optionalServices: [ESP32TimingTester.SERVICE_UUID]
            });
            
            this.device.addEventListener('gattserverdisconnected', () => {
                this.onDisconnected();
            });
            
            const server = await this.device.gatt.connect();
            const service = await server.getPrimaryService(ESP32TimingTester.SERVICE_UUID);
            
            this.commandCharacteristic = await service.getCharacteristic(ESP32TimingTester.COMMAND_CHARACTERISTIC_UUID);
            this.responseCharacteristic = await service.getCharacteristic(ESP32TimingTester.RESPONSE_CHARACTERISTIC_UUID);
            
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
    
    disconnect() {
        if (this.device && this.device.gatt.connected) {
            this.device.gatt.disconnect();
        }
        this.onDisconnected();
    }
    
    onDisconnected() {
        this.device = null;
        this.commandCharacteristic = null;
        this.responseCharacteristic = null;
        this.responseHandler = null;
        
        // UI更新
        document.getElementById('connectBtn').disabled = false;
        document.getElementById('disconnectBtn').disabled = true;
        document.getElementById('syncTimeBtn').disabled = true;
        document.getElementById('startTestBtn').disabled = true;
        document.getElementById('startDirectTestBtn').disabled = true;
        
        this.updateStatus('disconnected', '未接続');
        this.log('デバイスから切断されました', 'info');
        
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
            document.getElementById('startDirectTestBtn').disabled = false;
            document.getElementById('timeOffset').textContent = this.timeOffset.toFixed(2);
            document.getElementById('lastSync').textContent = this.lastSyncTime.toLocaleTimeString();
            
            this.log(`BLE時刻同期完了: オフセット ${this.timeOffset.toFixed(2)}ms`, 'success');
            this.log(`送信遅延: 平均 ${avgDelay.toFixed(2)}ms (${minDelay.toFixed(2)}-${maxDelay.toFixed(2)}ms)`, 'info');
            this.log(`測定サンプル: ${samples.length}/${numSamples}`, 'info');
            
        } catch (error) {
            this.updateSyncStatus('BLE同期失敗');
            this.log(`BLE同期エラー: ${error.message}`, 'error');
        }
    }
    
    async performTimeSync() {
        return new Promise((resolve) => {
            const t1 = Date.now();
            
            const command = new ArrayBuffer(9);
            const view = new DataView(command);
            view.setUint8(0, 0x01); // TIME_SYNC command
            view.setBigInt64(1, BigInt(t1), true);
            
            let responseTimer = setTimeout(() => {
                this.responseHandler = null;
                resolve(null);
            }, 1000);
            
            this.responseHandler = (data) => {
                clearTimeout(responseTimer);
                const t4 = Date.now();
                
                if (data.byteLength >= 25) {
                    const responseView = new DataView(data);
                    const receivedT1 = Number(responseView.getBigInt64(1, true));
                    const t2 = Number(responseView.getBigInt64(9, true));
                    const t3 = Number(responseView.getBigInt64(17, true));
                    
                    const roundTrip = t4 - t1;
                    const delay = roundTrip / 2;
                    
                    // ESP32のmillis()は相対時間なので、遅延のみ計算
                    // オフセットは送信遅延として扱う
                    const offset = delay;
                    
                    resolve({ t1, t2, t3, t4, roundTrip, delay, offset });
                } else {
                    resolve(null);
                }
            };
            
            this.commandCharacteristic.writeValue(command);
        });
    }
    
    async startTest() {
        if (!this.isSynced || this.isTestRunning) return;
        
        this.isTestRunning = true;
        this.currentTestIndex = 0;
        this.testResults = [];
        
        document.getElementById('startTestBtn').disabled = true;
        document.getElementById('stopTestBtn').disabled = false;
        
        this.log(`テスト開始: ${this.testSettings.count}回`, 'info');
        
        while (this.isTestRunning && this.currentTestIndex < this.testSettings.count) {
            await this.performTest();
            this.currentTestIndex++;
            this.updateProgress();
            
            if (this.isTestRunning && this.currentTestIndex < this.testSettings.count) {
                await this.sleep(this.testSettings.interval);
            }
        }
        
        this.stopTest();
    }
    
    async startDirectTest() {
        if (!this.isSynced || this.isTestRunning) return;
        
        this.isTestRunning = true;
        this.currentTestIndex = 0;
        this.testResults = [];
        
        document.getElementById('startTestBtn').disabled = true;
        document.getElementById('startDirectTestBtn').disabled = true;
        document.getElementById('stopTestBtn').disabled = false;
        
        this.log(`即送信テスト開始: ${this.testSettings.count}回`, 'info');
        
        while (this.isTestRunning && this.currentTestIndex < this.testSettings.count) {
            await this.performDirectTest();
            this.currentTestIndex++;
            this.updateProgress();
            
            if (this.isTestRunning && this.currentTestIndex < this.testSettings.count) {
                await this.sleep(this.testSettings.interval);
            }
        }
        
        this.stopTest();
    }
    
    async performDirectTest() {
        const sequence = this.currentTestIndex + 1;
        const sendTime = Date.now();
        
        return new Promise((resolve) => {
            // 遅延なしのコマンド（実行遅延=0）
            const command = new ArrayBuffer(20);
            const view = new DataView(command);
            view.setUint8(0, 0x02); // MOTOR_CMD command
            view.setUint8(1, 0x01); // motor command
            view.setBigUint64(2, BigInt(sendTime), true);
            view.setBigUint64(10, BigInt(0), true); // 遅延なし
            view.setUint16(18, sequence, true);
            
            this.commandCharacteristic.writeValue(command).then(() => {
                let responseTimer = setTimeout(() => {
                    this.responseHandler = null;
                    resolve();
                }, 2000);
                
                this.responseHandler = (data) => {
                    clearTimeout(responseTimer);
                    const responseTime = Date.now();
                    
                    if (data.byteLength >= 12) {
                        const responseView = new DataView(data);
                        const esp32ReceivedAt = responseView.getUint32(2, true);
                        const esp32ExecutedAt = responseView.getUint32(6, true);
                        
                        // ESP32起動時刻を推定（初回のみ）
                        if (!this.esp32StartTime) {
                            this.esp32StartTime = sendTime - esp32ReceivedAt;
                        }
                        
                        // ESP32時刻をUnix時刻に変換
                        const esp32ReceivedAtUnix = this.esp32StartTime + esp32ReceivedAt;
                        const esp32ExecutedAtUnix = this.esp32StartTime + esp32ExecutedAt;
                        
                        const transmissionDelay = esp32ReceivedAtUnix - sendTime;
                        const processingDelay = esp32ExecutedAt - esp32ReceivedAt; // ESP32内の処理時間
                        
                        const testResult = {
                            sequence: sequence,
                            sendTime: sendTime,
                            esp32ReceivedAt: esp32ReceivedAtUnix,
                            esp32ExecutedAt: esp32ExecutedAtUnix,
                            responseTime: responseTime,
                            transmissionDelay: transmissionDelay,
                            executionError: Math.abs(processingDelay),
                            rawExecutionError: processingDelay
                        };
                        
                        this.testResults.push(testResult);
                        this.updateStats();
                        this.addToChart(testResult.transmissionDelay);
                        
                        // 送信遅延誤差を計算（平均からの差）
                        const transmissionDelays = this.testResults.map(r => r.transmissionDelay);
                        const avgDelay = transmissionDelays.reduce((a, b) => a + b, 0) / transmissionDelays.length;
                        const delayError = avgDelay - testResult.transmissionDelay;
                        
                        document.getElementById('currentError').textContent = 
                            `${delayError.toFixed(2)}ms`;
                        
                        this.log(`[${sequence}] 即送信: ${transmissionDelay.toFixed(2)}ms, 処理: ${processingDelay.toFixed(2)}ms`, 
                                Math.abs(delayError) <= 5 ? 'success' : 'error');
                    }
                    
                    resolve();
                };
            });
        });
    }
    
    async performTest() {
        const sequence = this.currentTestIndex + 1;
        const sendTime = Date.now();
        
        return new Promise((resolve) => {
            const command = new ArrayBuffer(20);
            const view = new DataView(command);
            view.setUint8(0, 0x02); // MOTOR_CMD command
            view.setUint8(1, 0x01); // motor command
            view.setBigUint64(2, BigInt(sendTime), true);
            view.setBigUint64(10, BigInt(this.testSettings.executionDelay), true);
            view.setUint16(18, sequence, true);
            
            this.commandCharacteristic.writeValue(command).then(() => {
                let responseTimer = setTimeout(() => {
                    this.responseHandler = null;
                    resolve();
                }, 2000);
                
                this.responseHandler = (data) => {
                    clearTimeout(responseTimer);
                    const responseTime = Date.now();
                    
                    if (data.byteLength >= 12) {
                        const responseView = new DataView(data);
                        const esp32ReceivedAt = responseView.getUint32(2, true);
                        const esp32ExecutedAt = responseView.getUint32(6, true);
                        
                        // ESP32起動時刻を推定（初回のみ）
                        if (!this.esp32StartTime) {
                            this.esp32StartTime = sendTime - esp32ReceivedAt;
                        }
                        
                        // ESP32時刻をUnix時刻に変換
                        const esp32ReceivedAtUnix = this.esp32StartTime + esp32ReceivedAt;
                        const esp32ExecutedAtUnix = this.esp32StartTime + esp32ExecutedAt;
                        
                        const transmissionDelay = esp32ReceivedAtUnix - sendTime;
                        const executionError = (esp32ExecutedAt - esp32ReceivedAt) - this.testSettings.executionDelay;
                        
                        const testResult = {
                            sequence: sequence,
                            sendTime: sendTime,
                            esp32ReceivedAt: esp32ReceivedAtUnix,
                            esp32ExecutedAt: esp32ExecutedAtUnix,
                            responseTime: responseTime,
                            transmissionDelay: transmissionDelay,
                            executionError: Math.abs(executionError),
                            rawExecutionError: executionError
                        };
                        
                        this.testResults.push(testResult);
                        this.updateStats();
                        this.addToChart(testResult.transmissionDelay);
                        
                        // 送信遅延誤差を計算（平均からの差）
                        const transmissionDelays = this.testResults.map(r => r.transmissionDelay);
                        const avgDelay = transmissionDelays.reduce((a, b) => a + b, 0) / transmissionDelays.length;
                        const delayError = avgDelay - testResult.transmissionDelay;
                        
                        document.getElementById('currentError').textContent = 
                            `${delayError.toFixed(2)}ms`;
                        
                        this.log(`[${sequence}] 送信遅延: ${transmissionDelay.toFixed(2)}ms, 誤差: ${delayError.toFixed(2)}ms`, 
                                Math.abs(delayError) <= 5 ? 'success' : 'error');
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
        document.getElementById('startDirectTestBtn').disabled = !this.isSynced;
        document.getElementById('stopTestBtn').disabled = true;
        
        if (this.testResults.length > 0) {
            this.log(`テスト完了: ${this.testResults.length}サンプル`, 'success');
        }
    }
    
    updateProgress() {
        const progress = Math.round((this.currentTestIndex / this.testSettings.count) * 100);
        document.getElementById('progress').textContent = `${this.currentTestIndex}/${this.testSettings.count}`;
        document.getElementById('progressFill').style.width = `${progress}%`;
    }
    
    updateStats() {
        const results = this.testResults;
        if (results.length === 0) return;
        
        const transmissionDelays = results.map(r => r.transmissionDelay);
        const avgDelay = transmissionDelays.reduce((a, b) => a + b, 0) / results.length;
        
        // 送信遅延誤差を計算（平均からの差の絶対値）
        const delayErrors = transmissionDelays.map(delay => Math.abs(avgDelay - delay));
        const avgDelayError = delayErrors.reduce((a, b) => a + b, 0) / delayErrors.length;
        const maxDelayError = Math.max(...delayErrors);
        const within5ms = delayErrors.filter(error => error <= 5).length;
        const within5msPercent = (within5ms / delayErrors.length) * 100;
        
        document.getElementById('sampleCount').textContent = results.length;
        document.getElementById('avgDelay').textContent = `${avgDelay.toFixed(2)}ms`;
        document.getElementById('avgError').textContent = `${avgDelayError.toFixed(2)}ms`;
        document.getElementById('maxError').textContent = `${maxDelayError.toFixed(2)}ms`;
        document.getElementById('within5ms').textContent = `${within5msPercent.toFixed(1)}%`;
    }
    
    addToChart(transmissionDelay) {
        const results = this.testResults;
        const transmissionDelays = results.map(r => r.transmissionDelay);
        const avgDelay = transmissionDelays.reduce((a, b) => a + b, 0) / results.length;
        
        // 誤差 = 平均送信遅延 - 今回の送信遅延
        const delayError = avgDelay - transmissionDelay;
        
        this.chart.data.labels.push(this.testResults.length);
        this.chart.data.datasets[0].data.push(transmissionDelay); // 送信遅延
        this.chart.data.datasets[1].data.push(delayError);        // 遅延誤差
        
        // 最新50回分のみ表示
        if (this.chart.data.labels.length > 50) {
            this.chart.data.labels.shift();
            this.chart.data.datasets[0].data.shift();
            this.chart.data.datasets[1].data.shift();
        }
        
        this.chart.update('none');
    }
    
    clearResults() {
        this.testResults = [];
        this.chart.data.labels = [];
        this.chart.data.datasets[0].data = [];
        this.chart.data.datasets[1].data = [];
        this.chart.update();
        
        document.getElementById('sampleCount').textContent = '0';
        document.getElementById('avgDelay').textContent = '--';
        document.getElementById('avgError').textContent = '--';
        document.getElementById('maxError').textContent = '--';
        document.getElementById('within5ms').textContent = '--';
        document.getElementById('currentError').textContent = '--';
        
        document.getElementById('progress').textContent = '0/0';
        document.getElementById('progressFill').style.width = '0%';
        
        this.log('結果をクリアしました', 'info');
    }
    
    exportCSV() {
        if (this.testResults.length === 0) {
            this.log('エクスポートするデータがありません', 'error');
            return;
        }
        
        const headers = ['Sequence', 'Send Time', 'ESP32 Received', 'ESP32 Executed', 'Response Time', 'Transmission Delay', 'Execution Error'];
        const csvContent = [
            headers.join(','),
            ...this.testResults.map(result => [
                result.sequence,
                result.sendTime,
                result.esp32ReceivedAt,
                result.esp32ExecutedAt,
                result.responseTime,
                result.transmissionDelay.toFixed(3),
                result.rawExecutionError.toFixed(3)
            ].join(','))
        ].join('\n');
        
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `esp32_timing_test_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        this.log(`${this.testResults.length}サンプルをCSVエクスポートしました`, 'success');
    }
    
    onResponseReceived(event) {
        if (this.responseHandler) {
            const data = event.target.value.buffer;
            this.responseHandler(data);
        }
    }
    
    log(message, type = 'info') {
        const logContainer = document.getElementById('logContainer');
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        logContainer.appendChild(logEntry);
        logContainer.scrollTop = logContainer.scrollHeight;
    }
    
    clearLog() {
        document.getElementById('logContainer').innerHTML = '';
    }
    
    updateStatus(type, text) {
        const statusEl = document.getElementById('status');
        statusEl.textContent = text;
        statusEl.className = `status ${type}`;
    }
    
    updateSyncStatus(text) {
        document.getElementById('syncStatus').textContent = text;
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// アプリケーション開始
document.addEventListener('DOMContentLoaded', () => {
    new ESP32TimingTester();
});