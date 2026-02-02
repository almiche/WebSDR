#!/bin/bash
# WebSDR SSL Setup Script
# Sets up websockify with Let's Encrypt certificates for secure WebSocket (WSS)
#
# Prerequisites:
# - A domain name pointing to your server's public IP
# - Port 80 and 443 open for Let's Encrypt verification
# - Port 8081 (or your chosen WSS port) open for WebSocket traffic

set -e

# Configuration - EDIT THESE
DOMAIN=""           # e.g., sdr.yourdomain.com
EMAIL=""            # Your email for Let's Encrypt notifications
WSS_PORT="8081"     # Port for secure WebSocket
RTL_TCP_PORT="8080" # Port where rtl_tcp is running

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=========================================="
echo "WebSDR SSL Setup Script"
echo -e "==========================================${NC}"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (sudo ./setup-ssl.sh)${NC}"
    exit 1
fi

# Prompt for domain if not set
if [ -z "$DOMAIN" ]; then
    read -p "Enter your domain name (e.g., sdr.yourdomain.com): " DOMAIN
fi

if [ -z "$EMAIL" ]; then
    read -p "Enter your email for Let's Encrypt: " EMAIL
fi

if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
    echo -e "${RED}Domain and email are required${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}Configuration:${NC}"
echo "  Domain: $DOMAIN"
echo "  Email: $EMAIL"
echo "  WSS Port: $WSS_PORT"
echo "  RTL-TCP Port: $RTL_TCP_PORT"
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
fi

# Install certbot
echo ""
echo -e "${GREEN}[1/5] Installing certbot...${NC}"
apt-get update
apt-get install -y certbot

# Obtain certificate
echo ""
echo -e "${GREEN}[2/5] Obtaining Let's Encrypt certificate...${NC}"
echo "Make sure port 80 is open and not in use by another service"
certbot certonly --standalone -d "$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive

CERT_PATH="/etc/letsencrypt/live/$DOMAIN"

# Verify certificate exists
if [ ! -f "$CERT_PATH/fullchain.pem" ]; then
    echo -e "${RED}Certificate not found at $CERT_PATH${NC}"
    echo "Please check certbot output for errors"
    exit 1
fi

echo -e "${GREEN}Certificate obtained successfully!${NC}"

# Create combined certificate for websockify
echo ""
echo -e "${GREEN}[3/5] Creating combined certificate for websockify...${NC}"
WEBSOCKIFY_CERT="/etc/ssl/websockify"
mkdir -p "$WEBSOCKIFY_CERT"

# Websockify needs a combined cert file
cat "$CERT_PATH/fullchain.pem" "$CERT_PATH/privkey.pem" > "$WEBSOCKIFY_CERT/websockify.pem"
chmod 600 "$WEBSOCKIFY_CERT/websockify.pem"

# Update systemd service for secure websockify
echo ""
echo -e "${GREEN}[4/5] Creating secure websockify service...${NC}"

cat > /etc/systemd/system/websockify-rtltcp-ssl.service <<EOF
[Unit]
Description=Secure WebSocket proxy for RTL-TCP (WSS)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/websockify --cert=$WEBSOCKIFY_CERT/websockify.pem $WSS_PORT localhost:$RTL_TCP_PORT
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Create certificate renewal hook
echo ""
echo -e "${GREEN}[5/5] Setting up automatic certificate renewal...${NC}"

cat > /etc/letsencrypt/renewal-hooks/post/websockify-ssl.sh <<EOF
#!/bin/bash
# Renewal hook to update websockify certificate
DOMAIN="$DOMAIN"
CERT_PATH="/etc/letsencrypt/live/\$DOMAIN"
WEBSOCKIFY_CERT="/etc/ssl/websockify"

cat "\$CERT_PATH/fullchain.pem" "\$CERT_PATH/privkey.pem" > "\$WEBSOCKIFY_CERT/websockify.pem"
chmod 600 "\$WEBSOCKIFY_CERT/websockify.pem"

# Restart websockify to pick up new certificate
systemctl restart websockify-rtltcp-ssl.service
EOF

chmod +x /etc/letsencrypt/renewal-hooks/post/websockify-ssl.sh

# Stop old insecure service if running
systemctl stop websockify-rtltcp.service 2>/dev/null || true
systemctl disable websockify-rtltcp.service 2>/dev/null || true

# Enable and start secure service
systemctl daemon-reload
systemctl enable websockify-rtltcp-ssl.service
systemctl start websockify-rtltcp-ssl.service

echo ""
echo -e "${GREEN}=========================================="
echo "SSL Setup Complete!"
echo -e "==========================================${NC}"
echo ""
echo -e "Service Status:"
systemctl status websockify-rtltcp-ssl.service --no-pager -l || true
echo ""
echo -e "${GREEN}=========================================="
echo "Configuration for WebSDR:"
echo -e "==========================================${NC}"
echo ""
echo "In the WebSDR interface, use these settings:"
echo "  WebSocket Host: $DOMAIN"
echo "  WS Port: $WSS_PORT"
echo "  Secure (WSS): [x] checked"
echo ""
echo "Or if hosting on GitHub Pages:"
echo "  https://almiche.github.io/WebSDR/"
echo "  Enter host: $DOMAIN"
echo "  Enter port: $WSS_PORT"
echo "  Check 'Secure (WSS)'"
echo ""
echo -e "${YELLOW}Don't forget:${NC}"
echo "  1. Make sure rtl_tcp is running: rtl_tcp -a 127.0.0.1 -p $RTL_TCP_PORT"
echo "  2. Open port $WSS_PORT in your firewall/router"
echo "  3. Certificate auto-renews via certbot timer"
echo ""
echo "To check logs:"
echo "  journalctl -u websockify-rtltcp-ssl -f"
echo ""
echo "To test renewal:"
echo "  certbot renew --dry-run"
echo ""
