import { MongoClient, Db, Collection } from "mongodb";
import { execSync } from "child_process";
import { format } from "date-fns";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Definición de la configuración
interface Config {
  MONGO_URI: string;
  CHECK_INTERVAL: number;
  HOST_BACKUP_DIR: string;
  SALES_COLLECTION: string;
  BACKUPS_COLLECTION: string;
  MONGODUMP_BIN: string;
  MONGORESTORE_BIN: string;
}

const CONFIG: Config = {
  MONGO_URI: "mongodb://localhost:27017/tocgame",
  CHECK_INTERVAL: 300000, // 5 minutos
  HOST_BACKUP_DIR: join(homedir(), "backups", "tocgamedb"),
  SALES_COLLECTION: "sales",
  BACKUPS_COLLECTION: "backups",
  // Usamos los binarios instalados en el sistema:
  MONGODUMP_BIN: "mongodump",
  MONGORESTORE_BIN: "mongorestore",
};

// Tipos para documentos en MongoDB
interface Sale {
  _id: string;
  createdAt: Date;
}

interface BackupRecord {
  path: string;
  createdAt: Date;
  type: "emergency" | "scheduled";
  status: "created" | "failed" | "restored";
}

class DisasterRecoveryManager {
  constructor(private config: Config) {
    this.ensureBackupDir();
  }

  // Se asegura que exista el directorio de backups en el host
  private ensureBackupDir(): void {
    if (!existsSync(this.config.HOST_BACKUP_DIR)) {
      mkdirSync(this.config.HOST_BACKUP_DIR, { recursive: true, mode: 0o700 });
      console.log(
        `Directorio de backups creado: ${this.config.HOST_BACKUP_DIR}`
      );
    }
  }

  // Verifica en MongoDB si existen ventas en los últimos 5 minutos
  public async checkRecentSales(): Promise<boolean> {
    const client = new MongoClient(this.config.MONGO_URI);
    try {
      await client.connect();
      const database: Db = client.db();
      const collection: Collection<Sale> = database.collection(
        this.config.SALES_COLLECTION
      );
      const fiveMinutesAgo = new Date(Date.now() - this.config.CHECK_INTERVAL);
      const count: number = await collection.countDocuments({
        createdAt: { $gte: fiveMinutesAgo },
      });
      return count > 0;
    } finally {
      await client.close();
    }
  }

  // Muestra un diálogo Zenity y devuelve true si el usuario indica que hay problemas
  public showDialog(): boolean {
    try {
      execSync(
        "zenity --question " +
          '--title="Verificación de sistema" ' +
          '--text="No se detectaron ventas en los últimos 5 minutos. ¿Está teniendo problemas con el sistema?" ' +
          "--width=300",
        { stdio: "inherit" }
      );
      // Si el usuario acepta (clic en Aceptar), se entiende que SÍ hay problemas
      return true;
    } catch (error) {
      // Si cancela o cierra el diálogo, se interpreta como "no hay problemas"
      return false;
    }
  }

  // Crea un backup utilizando el binario local mongodump
  public async createBackup(): Promise<void> {
    const timestamp = format(new Date(), "yyyyMMdd-HHmmss");
    const backupName = `backup-${timestamp}`;
    const hostBackupPath = join(this.config.HOST_BACKUP_DIR, backupName);

    try {
      console.log(`Creando backup en: ${hostBackupPath}`);

      // Ejecutar mongodump
      execSync(
        `"${this.config.MONGODUMP_BIN}" --uri="${this.config.MONGO_URI}" --out="${hostBackupPath}"`,
        { stdio: "inherit" }
      );

      // Registrar el backup en la colección de backups de MongoDB
      const client = new MongoClient(this.config.MONGO_URI);
      await client.connect();
      const collection: Collection<BackupRecord> = client
        .db()
        .collection(this.config.BACKUPS_COLLECTION);

      await collection.insertOne({
        path: hostBackupPath,
        createdAt: new Date(),
        type: "emergency",
        status: "created",
      });

      await client.close();
      console.log("✅ Backup preventivo creado correctamente.");
    } catch (error) {
      console.error("Error en creación de backup:", error);
      throw error;
    }
  }

  // Restaura el sistema usando el último backup registrado
  private async restoreFromLatestBackup(): Promise<void> {
    const client = new MongoClient(this.config.MONGO_URI);

    try {
      await client.connect();
      const collection: Collection<BackupRecord> = client
        .db()
        .collection(this.config.BACKUPS_COLLECTION);

      const latestBackup = await collection.findOne(
        { status: "created" },
        { sort: { createdAt: -1 } }
      );

      if (!latestBackup) {
        throw new Error("No hay backups disponibles para restaurar");
      }

      console.log(`Restaurando desde backup: ${latestBackup.path}`);

      // Ejecutar mongorestore para restaurar la base de datos
      execSync(
        `"${this.config.MONGORESTORE_BIN}" --uri="${this.config.MONGO_URI}" --drop --dir="${latestBackup.path}"`,
        { stdio: "inherit" }
      );

      // Actualizar el estado del backup a "restored"
      await collection.updateOne(
        { _id: latestBackup._id },
        { $set: { status: "restored" } }
      );

      console.log("♻️ Sistema restaurado desde el último backup.");
    } catch (error) {
      console.error("Error en restauración:", error);
      throw error;
    } finally {
      await client.close();
    }
  }

  // Inicia el ciclo de monitorización
  public async startMonitoring(): Promise<void> {
    console.log("Iniciando monitorización del sistema...");

    while (true) {
      try {
        const hasRecentSales = await this.checkRecentSales();

        if (!hasRecentSales) {
          // Si no hay ventas recientes, se pregunta al usuario
          const hasProblems = this.showDialog();

          if (!hasProblems) {
            await this.createBackup();
          } else {
            await this.restoreFromLatestBackup();
          }
        }
      } catch (error) {
        console.error("⚠️ Error en monitorización:", error);
      }

      // Espera el intervalo configurado antes de volver a comprobar
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.CHECK_INTERVAL)
      );
    }
  }
}

// Ejecución principal
(async () => {
  try {
    const manager = new DisasterRecoveryManager(CONFIG);
    await manager.startMonitoring();
  } catch (error) {
    console.error("🔥 Error crítico:", error);
    process.exit(1);
  }
})();
