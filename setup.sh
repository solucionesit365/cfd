#!/bin/bash
# setup.sh: Configuración del entorno para backup y restauración

# Directorios de backups y logs
BACKUP_DIR="$HOME/backups/tocgamedb"
LOG_DIR="$PWD/logs"

# 1. Crear directorios y asignar permisos
mkdir -p "$BACKUP_DIR" "$LOG_DIR"
chmod 755 "$BACKUP_DIR" "$LOG_DIR"

# 2. Instalar dependencias necesarias
sudo apt-get update
sudo apt-get install -y mongodb-org-tools zenity docker.io

# 3. Configurar grupo docker y añadir al usuario actual
sudo groupadd docker 2>/dev/null
sudo usermod -aG docker $USER

echo "Configuración completada."
echo "Directorios creados:"
echo " - Backups: $BACKUP_DIR"
echo " - Logs: $LOG_DIR"
echo ""
echo "Asegúrate de tener Node.js instalado."
echo "Luego, instala las dependencias del programa con:"
echo "   npm install"
echo ""
echo "Para ejecutar el programa, usa:"
echo "   node backup-restore.js"
