# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is an ESP32 BLE timing precision tester that measures motor control signal accuracy using Web Bluetooth API. The system achieves sub-5ms timing precision through time synchronization protocols and high-precision ESP32 timers. The web interface runs on GitHub Pages and communicates directly with ESP32 via Bluetooth Low Energy.

## Common Development Commands

### ESP32 Development (PlatformIO)
```bash
# Build ESP32 firmware
pio run

# Upload to ESP32
pio run -t upload

# Monitor serial output (timing logs)
pio device monitor

# Build and upload in one command
pio run -t upload && pio device monitor

# Build for specific environment
pio run -e esp32dev-wifi

# Clean build files
pio run --target clean
```

### Web Development (GitHub Pages)
```bash
# Local development server (HTTPS required for Web Bluetooth)
python -m http.server 8000
# OR
npx serve .

# Test Web Bluetooth (Chrome/Edge only)
# Navigate to https://localhost:8000 or GitHub Pages URL
```

### Testing and Validation
```bash
# Monitor ESP32 timing statistics
pio device monitor --baud 115200

# Generate timing test data
# Use web interface to run 50-100 test cycles
# Export CSV for detailed analysis
```

## Architecture Overview

### Project Structure
```
esp32clock/
├── index.html             # Web Bluetooth UI (GitHub Pages)
├── style.css              # Web interface styling
├── app.js                 # Web Bluetooth API implementation
├── platformio.ini         # PlatformIO configuration
├── src/
│   └── main.cpp          # ESP32 BLE server and timing control
├── README.md              # Project documentation
└── CLAUDE.md             # Development guide
```

### Key Architectural Patterns

**Web-to-ESP32 Communication**: Web Bluetooth API enables direct browser-to-ESP32 communication without intermediate servers or native apps.

**Time Synchronization Protocol**: NTP-inspired 4-timestamp protocol (T1-T4) compensates for BLE transmission delays and achieves sub-5ms accuracy.

**High-Precision Timing**: ESP32's `esp_timer` API provides microsecond-resolution timing for motor control signals.

**Real-time Data Visualization**: Chart.js displays timing errors in real-time, with statistical analysis and CSV export capabilities.

## Core Dependencies

### ESP32 Platform
- **Platform**: espressif32
- **Framework**: arduino
- **Board**: esp32dev (or ESP32-S3 for advanced features)

### Web Technologies
- **Web Bluetooth API**: Direct browser-to-ESP32 communication
- **Chart.js**: Real-time data visualization
- **Vanilla JavaScript**: No framework dependencies for GitHub Pages compatibility

### ESP32 Libraries
- **BLEDevice**: Built-in ESP32 BLE stack
- **esp_timer**: High-precision microsecond timing
- **WiFi** (optional): NTP time synchronization for improved accuracy

## Hardware Configuration

### Pin Assignments
```cpp
#define MOTOR_PIN 26    // Motor control signal output
#define LED_PIN 2       // Status LED (onboard)
```

### BLE Service Configuration
```cpp
Service UUID:        12345678-1234-1234-1234-123456789abc
Command Char UUID:   12345678-1234-1234-1234-123456789abd  (Write)
Response Char UUID:  12345678-1234-1234-1234-123456789abe  (Notify)
```

### Timing Specifications
- **Target Precision**: ±5ms execution accuracy
- **Timer Resolution**: 1µs (ESP32 esp_timer)
- **BLE Connection Interval**: 7.5ms minimum (configurable)
- **Time Sync Accuracy**: ±1-3ms (with NTP)

## Development Notes

### Web Bluetooth Requirements
- **Browser Support**: Chromium-based only (Chrome, Edge, Opera)
- **HTTPS Requirement**: Web Bluetooth API requires secure context
- **Connection Limit**: ESP32 supports single BLE connection

### Timing Measurement Process
1. **Initial Sync**: 20-sample NTP-style time synchronization
2. **Command Transmission**: Timestamp-tagged BLE commands
3. **Precision Execution**: ESP32 high-resolution timer scheduling
4. **Error Calculation**: Statistical analysis of execution vs. target timing
5. **Real-time Feedback**: Live charting and CSV export

### Performance Optimization
- **Connection Parameters**: Minimize BLE connection interval (7.5ms)
- **Predictive Transmission**: Account for measured BLE delays
- **Statistical Filtering**: Use median/trimmed mean for robust sync
- **ISR-based Execution**: Timer callbacks for precise motor control