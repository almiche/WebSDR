# WebSDR - RTL-TCP Web Client

A full-featured, browser-based SDR application that interfaces with RTL-TCP servers via WebSocket.

## Features

- **Direct WebSocket connection** to RTL-TCP (via websockify proxy)
- **Multiple demodulation modes**: WFM, NFM, AM
- **Real-time visualization**: Waterfall display and waveform
- **Adjustable controls**: Gain, Squelch, Filter bandwidth
- **Click-to-tune** on waterfall
- **Responsive design** for mobile and desktop
- **Pure frontend** - no backend server required (except websockify proxy)

## Architecture

```
┌─────────────┐     ┌───────────────┐     ┌──────────┐
│   Browser   │────▶│   websockify  │────▶│  rtl_tcp │
│  (WebSDR)   │ WS  │   (port 8081) │ TCP │ (port    │
│             │◀────│               │◀────│  8080)   │
└─────────────┘     └───────────────┘     └──────────┘
```

## Quick Setup on Raspberry Pi

### Prerequisites
- Raspberry Pi with RTL-SDR dongle
- rtl_tcp running on port 8080

### Deployment

1. Copy all files to your Pi:
```bash
scp index.html sdr.js deploy.sh mchat@192.168.1.126:~/
```

2. SSH into the Pi and run the deployment script:
```bash
ssh mchat@192.168.1.126
chmod +x deploy.sh
./deploy.sh
```

3. Make sure rtl_tcp is running:
```bash
rtl_tcp -a 0.0.0.0 -p 8080
```

4. Access the web interface at: `http://192.168.1.126:9090`

## Manual Setup

### 1. Install websockify
```bash
sudo apt-get install websockify
```

### 2. Start the WebSocket proxy
```bash
websockify 8081 localhost:8080
```

### 3. Serve the web files
```bash
cd /path/to/websdr
python3 -m http.server 9090
```

### 4. Start rtl_tcp
```bash
rtl_tcp -a 0.0.0.0 -p 8080
```

## Systemd Services

Two systemd service files are included:

- `websockify-rtltcp.service` - WebSocket proxy
- `websdr-fileserver.service` - Static file server

To manage services:
```bash
# Start
sudo systemctl start websockify-rtltcp
sudo systemctl start websdr-fileserver

# Stop
sudo systemctl stop websockify-rtltcp
sudo systemctl stop websdr-fileserver

# View logs
journalctl -u websockify-rtltcp -f
journalctl -u websdr-fileserver -f
```

## Usage

1. Open the web interface in your browser
2. Verify the WebSocket host/port (default: 192.168.1.126:8081)
3. Click **Connect**
4. Set your desired frequency (in MHz)
5. Select demodulation mode (WFM/NFM/AM)
6. Click the **Play** button to hear audio
7. Adjust gain, squelch, and filter as needed
8. Click on the waterfall to tune to that frequency

## Controls

| Control | Description |
|---------|-------------|
| Frequency | Center frequency in MHz (24-1766 MHz typical) |
| Sample Rate | RTL-SDR sample rate (affects bandwidth) |
| Gain | 0=Auto, 1-50 dB manual gain |
| Squelch | Mute audio below signal threshold |
| Filter BW | Demodulator filter bandwidth |
| Mode | WFM (broadcast), NFM (narrow FM), AM |

## Troubleshooting

### Connection Failed
- Verify rtl_tcp is running: `pgrep rtl_tcp`
- Verify websockify is running: `pgrep websockify`
- Check firewall allows ports 8080, 8081, 9090

### No Audio
- Click the play button
- Check browser audio permissions
- Increase volume slider
- Verify there's a signal (check waterfall)

### Poor Audio Quality
- Adjust gain (try Auto first)
- Increase squelch to reduce noise
- Adjust filter bandwidth for your signal

## Browser Compatibility

- Chrome/Chromium ✓
- Firefox ✓
- Safari ✓
- Edge ✓
- Mobile browsers ✓

## Technical Details

### RTL-TCP Protocol
The app sends RTL-TCP commands over WebSocket:
- 0x01: Set frequency
- 0x02: Set sample rate
- 0x03: Set gain mode
- 0x04: Set gain value
- 0x08: Set AGC mode

### DSP Pipeline
```
IQ Data → Low-pass Filter → Demodulator → Decimation → Audio
                              ↓
                           FM/AM detection
```

### Demodulation
- **WFM**: Quadrature demodulation with de-emphasis (75µs)
- **NFM**: Quadrature demodulation without de-emphasis
- **AM**: Envelope detection (magnitude)

## License

MIT License - Feel free to use and modify!
