#!/bin/bash
set -e

echo "================================================"
echo "Docker Engine Setup for WSL2 Ubuntu"
echo "================================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. Remove old versions
echo -e "${YELLOW}Step 1/8: Removing old Docker versions...${NC}"
sudo apt-get remove -y docker docker-engine docker.io containerd runc 2>/dev/null || true
echo -e "${GREEN}✓ Done${NC}"
echo ""

# 2. Update package index
echo -e "${YELLOW}Step 2/8: Updating package index...${NC}"
sudo apt-get update
echo -e "${GREEN}✓ Done${NC}"
echo ""

# 3. Install prerequisites
echo -e "${YELLOW}Step 3/8: Installing prerequisites...${NC}"
sudo apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    lsb-release
echo -e "${GREEN}✓ Done${NC}"
echo ""

# 4. Add Docker's official GPG key
echo -e "${YELLOW}Step 4/8: Adding Docker GPG key...${NC}"
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo -e "${GREEN}✓ Done${NC}"
echo ""

# 5. Set up the repository
echo -e "${YELLOW}Step 5/8: Adding Docker repository...${NC}"
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
echo -e "${GREEN}✓ Done${NC}"
echo ""

# 6. Install Docker Engine
echo -e "${YELLOW}Step 6/8: Installing Docker Engine...${NC}"
sudo apt-get update
sudo apt-get install -y \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin
echo -e "${GREEN}✓ Done${NC}"
echo ""

# 7. Start Docker daemon
echo -e "${YELLOW}Step 7/8: Starting Docker daemon...${NC}"
sudo service docker start
echo -e "${GREEN}✓ Done${NC}"
echo ""

# 8. Add user to docker group
echo -e "${YELLOW}Step 8/8: Adding user to docker group...${NC}"
sudo usermod -aG docker $USER
echo -e "${GREEN}✓ Done${NC}"
echo ""

echo "================================================"
echo -e "${GREEN}Docker Engine installation complete!${NC}"
echo "================================================"
echo ""
echo "Next steps:"
echo "1. Close this terminal and open a new one (to apply group changes)"
echo "2. Verify installation with: docker --version"
echo "3. Test Docker: docker run hello-world"
echo ""
echo "Note: You may need to restart the Docker daemon after opening a new terminal:"
echo "  sudo service docker start"
echo ""
