#!/bin/bash
# WebSDR Deployment Script for Raspberry Pi
# Run this script on your Pi to set up the WebSocket proxy and file server

set -e

WEBSDR_DIR="$HOME/websdr"
PI_IP="192.168.1.126"

echo "=========================================="
echo "WebSDR Deployment Script"
echo "=========================================="

# Install dependencies
echo "[1/6] Installing dependencies..."
sudo apt-get update
sudo apt-get install -y python3 python3-pip websockify

# Create directory structure
echo "[2/6] Creating directory structure..."
mkdir -p "$WEBSDR_DIR"

# Copy web files (assuming they're in the current directory)
echo "[3/6] Copying web files..."
if [ -f "index.html" ]; then
    cp index.html sdr.js "$WEBSDR_DIR/"
else
    echo "Warning: Web files not found in current directory"
    echo "Please copy index.html and sdr.js to $WEBSDR_DIR"
fi

# Install websockify systemd service
echo "[4/6] Installing websockify service..."
sudo tee /etc/systemd/system/websockify-rtltcp.service > /dev/null <<EOF
[Unit]
Description=WebSocket proxy for RTL-TCP
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/websockify 8081 localhost:8080
Restart=always
RestartSec=5
User=$USER

[Install]
WantedBy=multi-user.target
EOF

# Install file server systemd service
echo "[5/6] Installing file server service..."
sudo tee /etc/systemd/system/websdr-fileserver.service > /dev/null <<EOF
[Unit]
Description=Web SDR File Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$WEBSDR_DIR
ExecStart=/usr/bin/python3 -m http.server 9090
Restart=always
RestartSec=5
User=$USER

[Install]
WantedBy=multi-user.target
EOF

# Enable and start services
echo "[6/6] Enabling and starting services..."
sudo systemctl daemon-reload
sudo systemctl enable websockify-rtltcp.service
sudo systemctl enable websdr-fileserver.service
sudo systemctl start websockify-rtltcp.service
sudo systemctl start websdr-fileserver.service

# Check status
echo ""
echo "=========================================="
echo "Deployment Complete!"
echo "=========================================="
echo ""
echo "Service Status:"
echo "---------------"
sudo systemctl status websockify-rtltcp.service --no-pager -l || true
echo ""
sudo systemctl status websdr-fileserver.service --no-pager -l || true
echo ""
echo "=========================================="
echo "Access URLs:"
echo "=========================================="
echo "Web SDR Interface: http://$PI_IP:9090"
echo "WebSocket Proxy:   ws://$PI_IP:8081"
echo ""
echo "Make sure rtl_tcp is running on port 8080:"
echo "  rtl_tcp -a 0.0.0.0 -p 8080"
echo ""
echo "To check logs:"
echo "  journalctl -u websockify-rtltcp -f"
echo "  journalctl -u websdr-fileserver -f"
echo ""
