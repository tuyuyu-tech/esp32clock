class ESP32PeriodicTester {
    constructor() {
        this.device = null;
        this.commandCharacteristic = null;
        this.responseCharacteristic = null;
        this.responseHandler = null;
        this.isConnected = false;
        this.isTestRunning = false;
        this.currentSignalIndex = 0;
        this.testResults = [];
        this.periodicSettings = {
            count: 100,
            period: 75, // 75ms固定
            maxDeviation: 10 // 最大許容ずれ
        };
        this.sendTimes = [];
        this.periodicTimer = null;
        
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
        document.getElementById('startPeriodicTestBtn').addEventListener('click', () => this.startPeriodicTest());
        document.getElementById('stopTestBtn').addEventListener('click', () => this.stopTest());
        document.getElementById('clearBtn').addEventListener('click', () => this.clearResults());
        document.getElementById('exportBtn').addEventListener('click', () => this.exportCSV());
        document.getElementById('clearLogBtn').addEventListener('click', () => this.clearLog());
        
        // テスト設定
        document.getElementById('testCount').addEventListener('change', (e) => {
            this.periodicSettings.count = parseInt(e.target.value);
        });
        document.getElementById('maxDeviation').addEventListener('change', (e) => {
            this.periodicSettings.maxDeviation = parseInt(e.target.value);
        });
        
        // 初期状態
        this.updateStatus('disconnected', '未接続');
        this.log('ESP32周期精度テスター - 75ms周期測定', 'info');
    }
    
    initializeChart() {
        const ctx = document.getElementById('errorChart').getContext('2d');
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: '75ms周期からのずれ (ms)',
                    data: [],
                    borderColor: '#3498db',
                    backgroundColor: 'rgba(52, 152, 219, 0.1)',
                    borderWidth: 2,
                    tension: 0.4,
                    pointRadius: 3,
                    fill: false
                }, {
                    label: '許容範囲外の値 (ms)',
                    data: [],
                    borderColor: '#e74c3c',
                    backgroundColor: 'rgba(231, 76, 60, 0.2)',
                    borderWidth: 2,
                    tension: 0.4,
                    pointRadius: 2,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        title: {
                            display: true,
                            text: 'ずれ (ms)'
                        }
                    },
                    x: {
                        title: {
                            display: true,
                            text: '信号番号'
                        }
                    }
                },
                plugins: {
                    title: {
                        display: true,
                        text: '75ms周期精度測定結果'
                    },
                    legend: {
                        display: true
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
            
            this.isConnected = true;
            this.updateStatus('connected', '接続済み');
            this.log(`デバイス "${this.device.name}" に接続しました`, 'success');
            
            // UI更新
            document.getElementById('connectBtn').disabled = true;
            document.getElementById('disconnectBtn').disabled = false;
            document.getElementById('startPeriodicTestBtn').disabled = false;
            
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
        this.isConnected = false;
        
        // UI更新
        document.getElementById('connectBtn').disabled = false;
        document.getElementById('disconnectBtn').disabled = true;
        document.getElementById('startPeriodicTestBtn').disabled = true;
        
        this.updateStatus('disconnected', '未接続');
        this.log('デバイスから切断されました', 'info');
        
        if (this.isTestRunning) {
            this.stopTest();
        }
    }
    
    async startPeriodicTest() {
        if (!this.isConnected || this.isTestRunning) return;
        
        try {
            this.isTestRunning = true;
            this.currentSignalIndex = 0;
            this.sendTimes = [];
            this.testResults = [];
            
            document.getElementById('startPeriodicTestBtn').disabled = true;
            document.getElementById('stopTestBtn').disabled = false;
            
            this.log(`75ms周期テスト開始: ${this.periodicSettings.count}回送信`, 'info');
            
            // ESP32にテスト開始を通知
            await this.sendTestStartCommand();
            
            // 最初の信号をすぐに送信
            this.sendFirstSignal();
            
        } catch (error) {
            this.log(`テスト開始エラー: ${error.message}`, 'error');
            this.stopTest();
        }
    }
    
    async sendTestStartCommand() {
        const command = new ArrayBuffer(5);
        const view = new DataView(command);
        view.setUint8(0, 0x03); // PERIODIC_TEST_START
        view.setUint16(1, this.periodicSettings.count, true);
        view.setUint16(3, this.periodicSettings.period, true);
        
        await this.commandCharacteristic.writeValue(command);
    }
    
    async sendFirstSignal() {
        this.testStartTime = performance.now();
        await this.sendPeriodicSignal();
        
        // 次の信号をスケジュール
        this.scheduleNextSignal();
    }
    
    async sendPeriodicSignal() {
        const currentTime = Date.now();
        const sequence = this.currentSignalIndex;
        
        this.sendTimes.push({
            sequence: sequence,
            sendTime: currentTime,
            performanceTime: performance.now()
        });
        
        const command = new ArrayBuffer(11);
        const view = new DataView(command);
        view.setUint8(0, 0x04); // PERIODIC_SIGNAL
        view.setUint16(1, sequence, true);
        view.setBigUint64(3, BigInt(currentTime), true);
        
        await this.commandCharacteristic.writeValue(command);
        
        this.currentSignalIndex++;
        this.updateProgress();
        
        this.log(`信号送信 [${sequence + 1}/${this.periodicSettings.count}]`, 'info');
    }
    
    scheduleNextSignal() {
        if (!this.isTestRunning || this.currentSignalIndex >= this.periodicSettings.count) {
            // 全信号送信完了
            this.finishSending();
            return;
        }
        
        // 次の送信タイミングを計算
        const nextSendTime = this.testStartTime + (this.currentSignalIndex * this.periodicSettings.period);
        const currentTime = performance.now();
        const delay = Math.max(0, nextSendTime - currentTime);
        
        this.periodicTimer = setTimeout(() => {
            if (this.isTestRunning) {
                this.sendPeriodicSignal();
                this.scheduleNextSignal();
            }
        }, delay);
    }
    
    async finishSending() {
        this.log('全信号送信完了 - 結果データ取得中...', 'info');
        
        // 少し待ってからESP32に結果を要求
        await this.sleep(100);
        await this.getResults();
    }
    
    async getResults() {
        return new Promise((resolve) => {
            // 結果取得コマンド
            const command = new ArrayBuffer(1);
            const view = new DataView(command);
            view.setUint8(0, 0x05); // GET_RESULTS
            
            let responseTimer = setTimeout(() => {
                this.responseHandler = null;
                this.log('結果データ取得タイムアウト', 'error');
                resolve();
            }, 5000);
            
            this.responseHandler = (data) => {
                clearTimeout(responseTimer);
                this.processResults(data);
                resolve();
            };
            
            this.commandCharacteristic.writeValue(command);
        });
    }
    
    processResults(data) {
        if (data.byteLength < 2) {
            this.log('結果データが不正です', 'error');
            return;
        }
        
        const view = new DataView(data);
        const numResults = view.getUint16(0, true);
        
        if (data.byteLength < 2 + numResults * 2) {
            this.log('結果データサイズが不正です', 'error');
            return;
        }
        
        this.testResults = [];
        for (let i = 0; i < numResults; i++) {
            const deviation = view.getInt16(2 + i * 2, true);
            this.testResults.push({
                sequence: i,
                deviation: deviation,
                withinTolerance: Math.abs(deviation) <= this.periodicSettings.maxDeviation
            });
        }
        
        this.log(`結果データ取得完了: ${this.testResults.length}サンプル`, 'success');
        this.updateStats();
        this.updateChart();
        this.stopTest();
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
        
        // タイマーをクリア
        if (this.periodicTimer) {
            clearTimeout(this.periodicTimer);
            this.periodicTimer = null;
        }
        
        document.getElementById('startPeriodicTestBtn').disabled = !this.isConnected;
        document.getElementById('stopTestBtn').disabled = true;
        
        if (this.testResults.length > 0) {
            this.log(`テスト完了: ${this.testResults.length}サンプル`, 'success');
        } else if (this.currentSignalIndex > 0) {
            this.log(`テスト中断: ${this.currentSignalIndex}信号送信済み`, 'info');
        }
    }
    
    updateProgress() {
        const progress = Math.round((this.currentSignalIndex / this.periodicSettings.count) * 100);
        document.getElementById('progress').textContent = `${this.currentSignalIndex}/${this.periodicSettings.count}`;
        document.getElementById('progressFill').style.width = `${progress}%`;
    }
    
    updateStats() {
        const results = this.testResults;
        if (results.length === 0) return;
        
        const deviations = results.map(r => r.deviation);
        const absDeviations = deviations.map(d => Math.abs(d));
        
        // 統計計算
        const avgDeviation = deviations.reduce((a, b) => a + b, 0) / results.length;
        const avgAbsDeviation = absDeviations.reduce((a, b) => a + b, 0) / results.length;
        const maxDeviation = Math.max(...absDeviations);
        const withinTolerance = results.filter(r => r.withinTolerance).length;
        const tolerancePercent = (withinTolerance / results.length) * 100;
        
        // 標準偏差計算
        const variance = deviations.reduce((sum, d) => sum + Math.pow(d - avgDeviation, 2), 0) / results.length;
        const stdDeviation = Math.sqrt(variance);
        
        // UI更新
        document.getElementById('sampleCount').textContent = results.length;
        document.getElementById('avgDeviation').textContent = `${avgDeviation.toFixed(2)}ms`;
        document.getElementById('avgAbsDeviation').textContent = `${avgAbsDeviation.toFixed(2)}ms`;
        document.getElementById('maxDeviation').textContent = `${maxDeviation.toFixed(2)}ms`;
        document.getElementById('stdDeviation').textContent = `${stdDeviation.toFixed(2)}ms`;
        document.getElementById('withinTolerance').textContent = `${tolerancePercent.toFixed(1)}%`;
        
        // 最新の結果を表示
        if (results.length > 0) {
            const lastResult = results[results.length - 1];
            document.getElementById('currentDeviation').textContent = `${lastResult.deviation.toFixed(2)}ms`;
        }
    }
    
    updateChart() {
        const results = this.testResults;
        if (results.length === 0) return;
        
        // チャートデータをクリア
        this.chart.data.labels = [];
        this.chart.data.datasets[0].data = [];
        this.chart.data.datasets[1].data = [];
        
        // 新しいデータを追加
        results.forEach((result, index) => {
            this.chart.data.labels.push(index + 1);
            this.chart.data.datasets[0].data.push(result.deviation);
            
            // 許容範囲の表示用（正の値で許容範囲内なら0、範囲外なら偏差の絶対値）
            const toleranceIndicator = result.withinTolerance ? 0 : Math.abs(result.deviation);
            this.chart.data.datasets[1].data.push(toleranceIndicator);
        });
        
        this.chart.update();
    }
    
    clearResults() {
        this.testResults = [];
        this.sendTimes = [];
        this.currentSignalIndex = 0;
        
        this.chart.data.labels = [];
        this.chart.data.datasets[0].data = [];
        this.chart.data.datasets[1].data = [];
        this.chart.update();
        
        document.getElementById('sampleCount').textContent = '0';
        document.getElementById('avgDeviation').textContent = '--';
        document.getElementById('avgAbsDeviation').textContent = '--';
        document.getElementById('maxDeviation').textContent = '--';
        document.getElementById('stdDeviation').textContent = '--';
        document.getElementById('withinTolerance').textContent = '--';
        document.getElementById('currentDeviation').textContent = '--';
        
        document.getElementById('progress').textContent = '0/0';
        document.getElementById('progressFill').style.width = '0%';
        
        this.log('結果をクリアしました', 'info');
    }
    
    exportCSV() {
        if (this.testResults.length === 0) {
            this.log('エクスポートするデータがありません', 'error');
            return;
        }
        
        const headers = ['Sequence', 'Deviation_ms', 'Within_Tolerance', 'Expected_Time', 'Actual_Offset'];
        const csvContent = [
            headers.join(','),
            ...this.testResults.map((result, index) => [
                result.sequence + 1,
                result.deviation.toFixed(3),
                result.withinTolerance ? 'YES' : 'NO',
                (index * this.periodicSettings.period).toFixed(0), // 期待タイミング
                ((index * this.periodicSettings.period) + result.deviation).toFixed(3) // 実際のオフセット
            ].join(','))
        ].join('\n');
        
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `esp32_periodic_test_75ms_${new Date().toISOString().slice(0, 10)}.csv`;
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
    new ESP32PeriodicTester();
});