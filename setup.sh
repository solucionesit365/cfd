#!/bin/bash
# setup.sh: Configuración del entorno para el sistema de backup y recuperación

# Definir el directorio donde se almacenarán los backups
BACKUP_DIR="$HOME/backups/tocgamedb"

echo "=== Configuración de directorio de backups ==="
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
echo "Directorio de backups configurado en: $BACKUP_DIR"

echo "=== Verificando la instalación de mongodb-org-tools ==="
if ! command -v mongodump &> /dev/null; then
    echo "mongodump no encontrado. Se procederá a instalar mongodb-org-tools."
    wget -qO - https://www.mongodb.org/static/pgp/server-6.0.asc | sudo apt-key add -
    echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu $(lsb_release -sc)/mongodb-org/6.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-6.0.list
    sudo apt-get update
    sudo apt-get install -y mongodb-org-tools
else
    echo "mongodump ya está instalado en el sistema."
fi

echo "=== Configuración de Docker ==="
sudo groupadd docker 2>/dev/null  # Ignorar si ya existe
sudo usermod -aG docker "$USER"

echo "=== Configuración de sudoers para Docker ==="
SUDOERS_FILE="/etc/sudoers.d/disaster-recovery"
echo "Defaults:$USER !requiretty" | sudo tee "$SUDOERS_FILE" >/dev/null
echo "$USER ALL=(root) NOPASSWD: /usr/bin/docker exec *" | sudo tee -a "$SUDOERS_FILE" >/dev/null
sudo chmod 0440 "$SUDOERS_FILE"

echo "=== Configuración de permisos para dispositivos de entrada ==="
if groups "$USER" | grep -q "\binput\b"; then
    echo "El usuario $USER ya pertenece al grupo 'input'."
else
    echo "Añadiendo usuario $USER al grupo 'input' para acceder al dispositivo táctil."
    sudo usermod -aG input "$USER"
    echo "Por favor, cierra la sesión y vuelve a iniciarla para que los cambios tengan efecto."
fi

echo "=== Verificación de dispositivo táctil ==="
if [ -e /dev/input/event8 ]; then
    echo "El dispositivo /dev/input/event8 existe. Permisos actuales:"
    ls -l /dev/input/event8
else
    echo "Advertencia: /dev/input/event8 no existe. Asegúrate de que el dispositivo táctil está conectado y utiliza el nombre correcto."
fi

echo "=== Configuración de política SELinux (si aplica) ==="
if command -v sestatus &> /dev/null; then
    sudo setenforce 0
    sudo semanage fcontext -a -t container_file_t "$BACKUP_DIR(/.*)?"
    sudo restorecon -Rv "$BACKUP_DIR"
fi

echo "=== Configuración de GNOME (desactivar bloqueo y establecer tiempo de salvapantallas a 30 segundos) ==="
if [ -n "$SUDO_USER" ]; then
    sudo -u "$SUDO_USER" gsettings set org.gnome.desktop.screensaver lock-enabled false
    sudo -u "$SUDO_USER" gsettings set org.gnome.desktop.session idle-delay 30
else
    gsettings set org.gnome.desktop.screensaver lock-enabled false
    gsettings set org.gnome.desktop.session idle-delay 30
fi

echo "=== Aplicando cambios de grupo ==="
newgrp docker <<EONG
echo "Configuración completada:"
echo " - Directorio de backups: $BACKUP_DIR"
echo " - Usuario $USER agregado al grupo docker"
EONG
