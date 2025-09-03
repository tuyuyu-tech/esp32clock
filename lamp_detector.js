class LampDetector {
    constructor() {
        this.video = document.getElementById('videoElement');
        this.canvas = document.getElementById('canvasOutput');
        this.ctx = this.canvas.getContext('2d');
        this.stream = null;
        this.isDetecting = false;
        this.detectedLamps = [];
        this.processingTime = 0;
        
        this.initializeControls();
        this.waitForOpenCV();
    }
    
    waitForOpenCV() {
        if (typeof cv === 'undefined') {
            setTimeout(() => this.waitForOpenCV(), 100);
            return;
        }
        
        console.log('OpenCV.js loaded successfully');
        this.updateStatus('OpenCV.js読み込み完了', 'success');
    }
    
    initializeControls() {
        // カメラ制御
        document.getElementById('startCamera').addEventListener('click', () => this.startCamera());
        document.getElementById('stopCamera').addEventListener('click', () => this.stopCamera());
        document.getElementById('detectLamp').addEventListener('click', () => this.startDetection());
        document.getElementById('stopDetection').addEventListener('click', () => this.stopDetection());
        
        // 色設定スライダー
        const sliders = ['hMin', 'sMin', 'vMin', 'hMax', 'sMax', 'vMax'];
        sliders.forEach(id => {
            const slider = document.getElementById(id);
            const valueSpan = document.getElementById(id + 'Value');
            slider.addEventListener('input', () => {
                valueSpan.textContent = slider.value;
                this.updateColorSettings();
            });
        });
        
        // チェックボックス
        document.getElementById('showMask').addEventListener('change', () => this.updateDisplaySettings());
        document.getElementById('showContours').addEventListener('change', () => this.updateDisplaySettings());
        document.getElementById('minArea').addEventListener('input', () => this.updateColorSettings());
    }
    
    async startCamera() {
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: 640,
                    height: 480,
                    facingMode: 'environment'
                }
            });
            
            this.video.srcObject = this.stream;
            this.video.onloadedmetadata = () => {
                this.canvas.width = this.video.videoWidth;
                this.canvas.height = this.video.videoHeight;
                
                this.updateStatus('カメラ開始完了', 'success');
                document.getElementById('startCamera').disabled = true;
                document.getElementById('stopCamera').disabled = false;
                document.getElementById('detectLamp').disabled = false;
            };
            
        } catch (error) {
            this.updateStatus(`カメラエラー: ${error.message}`, 'error');
            console.error('Camera error:', error);
        }
    }
    
    stopCamera() {
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        
        this.stopDetection();
        this.updateStatus('カメラ停止', '');
        document.getElementById('startCamera').disabled = false;
        document.getElementById('stopCamera').disabled = true;
        document.getElementById('detectLamp').disabled = true;
    }
    
    startDetection() {
        if (!this.stream) return;
        
        this.isDetecting = true;
        this.updateStatus('ランプ検出中...', 'success');
        document.getElementById('detectLamp').disabled = true;
        document.getElementById('stopDetection').disabled = false;
        
        this.detectLoop();
    }
    
    stopDetection() {
        this.isDetecting = false;
        this.updateStatus('検出停止', '');
        document.getElementById('detectLamp').disabled = false;
        document.getElementById('stopDetection').disabled = true;
        
        // キャンバスをクリア
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    
    detectLoop() {
        if (!this.isDetecting) return;
        
        const startTime = performance.now();
        
        try {
            this.processFrame();
        } catch (error) {
            console.error('Detection error:', error);
        }
        
        this.processingTime = performance.now() - startTime;
        this.updateDetectionInfo();
        
        requestAnimationFrame(() => this.detectLoop());
    }
    
    processFrame() {
        if (this.video.readyState < 2) return;
        
        // OpenCV mat作成
        const src = new cv.Mat(this.video.videoHeight, this.video.videoWidth, cv.CV_8UC4);
        const cap = new cv.VideoCapture(this.video);
        cap.read(src);
        
        // BGR to HSV変換
        const hsv = new cv.Mat();
        cv.cvtColor(src, hsv, cv.COLOR_RGB2HSV);
        
        // 色範囲でマスク作成
        const colorSettings = this.getColorSettings();
        const lowerBound = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), 
            [colorSettings.hMin, colorSettings.sMin, colorSettings.vMin, 0]);
        const upperBound = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), 
            [colorSettings.hMax, colorSettings.sMax, colorSettings.vMax, 255]);
        
        const mask = new cv.Mat();
        cv.inRange(hsv, lowerBound, upperBound, mask);
        
        // モルフォロジー処理でノイズ除去
        const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
        const cleaned = new cv.Mat();
        cv.morphologyEx(mask, cleaned, cv.MORPH_OPEN, kernel);
        cv.morphologyEx(cleaned, cleaned, cv.MORPH_CLOSE, kernel);
        
        // 輪郭検出
        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(cleaned, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        
        // 結果を描画
        this.drawResults(src, mask, contours, colorSettings);
        
        // メモリ解放
        src.delete(); hsv.delete(); lowerBound.delete(); upperBound.delete();
        mask.delete(); kernel.delete(); cleaned.delete();
        contours.delete(); hierarchy.delete();
    }
    
    drawResults(src, mask, contours, colorSettings) {
        // 元画像をキャンバスに描画
        cv.imshow('canvasOutput', src);
        
        const showMask = document.getElementById('showMask').checked;
        const showContours = document.getElementById('showContours').checked;
        
        if (showMask) {
            // マスクをオーバーレイ表示
            const maskCanvas = document.createElement('canvas');
            maskCanvas.width = this.canvas.width;
            maskCanvas.height = this.canvas.height;
            cv.imshow(maskCanvas, mask);
            
            this.ctx.globalAlpha = 0.3;
            this.ctx.drawImage(maskCanvas, 0, 0);
            this.ctx.globalAlpha = 1.0;
        }
        
        if (showContours) {
            this.detectedLamps = [];
            
            // 輪郭とランプ位置を描画
            this.ctx.strokeStyle = '#00ff00';
            this.ctx.lineWidth = 2;
            this.ctx.fillStyle = '#ff0000';
            this.ctx.font = '14px Arial';
            
            for (let i = 0; i < contours.size(); i++) {
                const contour = contours.get(i);
                const area = cv.contourArea(contour);
                
                if (area > colorSettings.minArea) {
                    // 外接矩形を取得
                    const rect = cv.boundingRect(contour);
                    
                    // 中心座標
                    const centerX = rect.x + rect.width / 2;
                    const centerY = rect.y + rect.height / 2;
                    
                    // 円形度計算
                    const perimeter = cv.arcLength(contour, true);
                    const circularity = 4 * Math.PI * area / (perimeter * perimeter);
                    
                    // ランプ候補として記録
                    this.detectedLamps.push({
                        x: Math.round(centerX),
                        y: Math.round(centerY),
                        area: Math.round(area),
                        circularity: circularity.toFixed(3),
                        width: rect.width,
                        height: rect.height
                    });
                    
                    // 矩形を描画
                    this.ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
                    
                    // 中心点を描画
                    this.ctx.beginPath();
                    this.ctx.arc(centerX, centerY, 3, 0, 2 * Math.PI);
                    this.ctx.fill();
                    
                    // 情報を表示
                    this.ctx.fillStyle = '#00ff00';
                    this.ctx.fillText(
                        `(${Math.round(centerX)}, ${Math.round(centerY)})`,
                        rect.x, rect.y - 5
                    );
                    this.ctx.fillText(
                        `Area: ${Math.round(area)}`,
                        rect.x, rect.y + rect.height + 15
                    );
                    this.ctx.fillStyle = '#ff0000';
                }
                
                contour.delete();
            }
        }
    }
    
    getColorSettings() {
        return {
            hMin: parseInt(document.getElementById('hMin').value),
            sMin: parseInt(document.getElementById('sMin').value),
            vMin: parseInt(document.getElementById('vMin').value),
            hMax: parseInt(document.getElementById('hMax').value),
            sMax: parseInt(document.getElementById('sMax').value),
            vMax: parseInt(document.getElementById('vMax').value),
            minArea: parseInt(document.getElementById('minArea').value)
        };
    }
    
    updateColorSettings() {
        // リアルタイム設定更新（検出中の場合）
        if (this.isDetecting) {
            // 必要に応じてパラメータ調整の効果を即座に反映
        }
    }
    
    updateDisplaySettings() {
        // 表示設定の更新
    }
    
    updateStatus(text, type = '') {
        const statusEl = document.getElementById('status');
        statusEl.textContent = text;
        statusEl.className = `status ${type}`;
    }
    
    updateDetectionInfo() {
        const infoEl = document.getElementById('detectionInfo');
        
        let info = `処理時間: ${this.processingTime.toFixed(1)}ms\n`;
        info += `検出されたランプ: ${this.detectedLamps.length}個\n\n`;
        
        this.detectedLamps.forEach((lamp, index) => {
            info += `ランプ ${index + 1}:\n`;
            info += `  位置: (${lamp.x}, ${lamp.y})\n`;
            info += `  面積: ${lamp.area}px²\n`;
            info += `  円形度: ${lamp.circularity}\n`;
            info += `  サイズ: ${lamp.width}×${lamp.height}\n\n`;
        });
        
        if (this.detectedLamps.length > 0) {
            const bestLamp = this.detectedLamps.reduce((best, current) => 
                current.area > best.area ? current : best
            );
            info += `最有力候補: (${bestLamp.x}, ${bestLamp.y}) - 面積: ${bestLamp.area}px²`;
        }
        
        infoEl.textContent = info;
    }
}

// アプリケーション初期化
document.addEventListener('DOMContentLoaded', () => {
    new LampDetector();
});