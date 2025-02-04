#!/bin/bash

# Directorio donde se almacenarán los backups
BACKUP_DIR="$HOME/backups/tocgamedb"

# 1. Crear el directorio de backups sin necesidad de sudo
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

echo "Configuración completada:"
echo " - Directorio de backups: $BACKUP_DIR"
