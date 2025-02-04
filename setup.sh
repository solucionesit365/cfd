#!/bin/bash
# setup.sh: Configuración del entorno para el sistema de backup y recuperación

# Definir el directorio donde se almacenarán los backups
BACKUP_DIR="$HOME/backups/tocgamedb"

echo "=== Configuración de directorio de backups ==="
# 1. Crear el directorio de backups sin necesidad de sudo
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
echo "Directorio de backups configurado en: $BACKUP_DIR"

echo "=== Verificando la instalación de mongodb-org-tools ==="
if ! command -v mongodump &> /dev/null; then
    echo "mongodump no encontrado. Se procederá a instalar mongodb-org-tools."
    # Agregar la clave pública del repositorio oficial de MongoDB
    wget -qO - https://www.mongodb.org/static/pgp/server-6.0.asc | sudo apt-key add -
    # Agregar el repositorio oficial de MongoDB (ajustando la distribución actual)
    echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu $(lsb_release -sc)/mongodb-org/6.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-6.0.list
    # Actualizar la lista de paquetes e instalar mongodb-org-tools
    sudo apt-get update
    sudo apt-get install -y mongodb-org-tools
else
    echo "mongodump ya está instalado en el sistema."
fi

echo "=== Configuración de Docker ==="
# 2. Configurar permisos de Docker (evitar usar sudo)
sudo groupadd docker 2>/dev/null  # Ignorar si ya existe
sudo usermod -aG docker "$USER"

echo "=== Configuración de sudoers para Docker ==="
# 3. Configuración segura en sudoers para ejecutar 'docker exec' sin contraseña
SUDOERS_FILE="/etc/sudoers.d/disaster-recovery"
echo "Defaults:$USER !requiretty" | sudo tee "$SUDOERS_FILE" >/dev/null
echo "$USER ALL=(root) NOPASSWD: /usr/bin/docker exec *" | sudo tee -a "$SUDOERS_FILE" >/dev/null
sudo chmod 0440 "$SUDOERS_FILE"

echo "=== Configuración de política SELinux (si aplica) ==="
# 4. Configurar SELinux si la herramienta sestatus está disponible
if command -v sestatus &> /dev/null; then
    sudo setenforce 0
    sudo semanage fcontext -a -t container_file_t "$BACKUP_DIR(/.*)?"
    sudo restorecon -Rv "$BACKUP_DIR"
fi

echo "=== Aplicando cambios de grupo ==="
# 5. Aplicar cambios de grupo (esto reinicia la sesión de grupo para el usuario actual)
newgrp docker <<EONG
echo "Configuración completada:"
echo " - Directorio de backups: $BACKUP_DIR"
echo " - Usuario $USER agregado al grupo docker"
EONG
