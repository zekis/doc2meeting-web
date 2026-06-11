#!/usr/bin/env bash
# setup-swap.sh — Add 2GB swap to a production server.
# Run as root on the target server.
set -euo pipefail

SWAPFILE="/swapfile"
SWAP_SIZE="2G"
SWAPPINESS=10

if swapon --show | grep -q "$SWAPFILE"; then
    echo "[swap] $SWAPFILE already active — skipping creation."
    swapon --show
    exit 0
fi

echo "[swap] Creating ${SWAP_SIZE} swap file at ${SWAPFILE}..."
fallocate -l "$SWAP_SIZE" "$SWAPFILE"
chmod 600 "$SWAPFILE"
mkswap "$SWAPFILE"
swapon "$SWAPFILE"

# Make persistent across reboots
if ! grep -q "$SWAPFILE" /etc/fstab; then
    echo "${SWAPFILE} none swap sw 0 0" >> /etc/fstab
    echo "[swap] Added fstab entry."
fi

# Set swappiness (only use swap under memory pressure)
sysctl vm.swappiness="$SWAPPINESS"
if ! grep -q "vm.swappiness" /etc/sysctl.conf; then
    echo "vm.swappiness=${SWAPPINESS}" >> /etc/sysctl.conf
    echo "[swap] Set vm.swappiness=${SWAPPINESS} (persistent)."
fi

echo "[swap] Done."
swapon --show
free -h
