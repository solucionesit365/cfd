#!/bin/bash

# Configuración segura de permisos y directorios
BACKUP_DIR="$HOME/backups/tocgamedb"

# 1. Crear directorio de backups sin sudo
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# 2. Configurar permisos de Docker (evitar usar sudo)
sudo groupadd docker 2>/dev/null  # Ignorar si ya existe
sudo usermod -aG docker $USER

# 3. Configuración sudoers segura
SUDOERS_FILE="/etc/sudoers.d/disaster-recovery"
echo "Defaults:$USER !requiretty" | sudo tee "$SUDOERS_FILE" >/dev/null
echo "$USER ALL=(root) NOPASSWD: /usr/bin/docker exec *" | sudo tee -a "$SUDOERS_FILE" >/dev/null
sudo chmod 0440 "$SUDOERS_FILE"

# 4. Configurar política SELinux (si aplica)
if command -v sestatus &> /dev/null; then
    sudo setenforce 0
    sudo semanage fcontext -a -t container_file_t "$BACKUP_DIR(/.*)?"
    sudo restorecon -Rv "$BACKUP_DIR"
fi

# 5. Aplicar cambios de grupos
newgrp docker <<EONG
echo "Configuración completada:"
echo " - Directorio de backups: $BACKUP_DIR"
echo " - Usuario $USER agregado al grupo docker"
EONG