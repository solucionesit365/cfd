import { MongoClient, Db, Collection } from "mongodb";
import { execSync } from "child_process";
import { format } from "date-fns";
import { existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Configuración con tipos
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
  // Usar los binarios instalados en el sistema:
  MONGODUMP_BIN: "mongodump",
  MONGORESTORE_BIN: "mongorestore",
};

// Tipos para los documentos en MongoDB
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

  private ensureBackupDir(): void {
    if (!existsSync(this.config.HOST_BACKUP_DIR)) {
      mkdirSync(this.config.HOST_BACKUP_DIR, { recursive: true, mode: 0o700 });
      console.log(
        `Directorio de backups creado: ${this.config.HOST_BACKUP_DIR}`
      );
    }
  }

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

  public showDialog(): boolean {
    try {
      execSync(
        "zenity --question " +
          '--title="Verificación de sistema" ' +
          '--text="No se detectaron ventas en los últimos 5 minutos. ¿Está teniendo problemas con el sistema?" ' +
          "--width=300",
        { stdio: "inherit" }
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  // Función modificada para crear backup en modo archive (archivo .gz)
  public async createBackup(): Promise<void> {
    const timestamp = format(new Date(), "yyyyMMdd-HHmmss");
    const backupBasePath = join(
      this.config.HOST_BACKUP_DIR,
      `backup-${timestamp}`
    );
    const backupFile = `${backupBasePath}.gz`;

    try {
      console.log(`Creando backup en: ${backupFile}`);

      // Se crea el backup en modo archive con compresión gzip
      execSync(
        `"${this.config.MONGODUMP_BIN}" --uri="${this.config.MONGO_URI}" --archive="${backupFile}" --gzip`,
        { stdio: "inherit" }
      );

      // Registrar el backup en la colección de backups de MongoDB
      const client = new MongoClient(this.config.MONGO_URI);
      await client.connect();
      const collection: Collection<BackupRecord> = client
        .db()
        .collection(this.config.BACKUPS_COLLECTION);

      await collection.insertOne({
        path: backupFile,
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

  // Función modificada para restaurar desde un backup archive
  private async restoreFromLatestBackup(): Promise<void> {
    try {
      // Leer el directorio de backups y encontrar el archivo más reciente
      const backupFiles = readdirSync(this.config.HOST_BACKUP_DIR)
        .filter((file) => file.endsWith(".gz"))
        .sort()
        .reverse();

      if (backupFiles.length === 0) {
        throw new Error("No hay backups disponibles en el directorio");
      }

      const latestBackup = backupFiles[0];
      const backupPath = join(this.config.HOST_BACKUP_DIR, latestBackup);

      console.log(`Restaurando desde backup: ${backupPath}`);

      // Ejecutar mongorestore
      execSync(
        `"${this.config.MONGORESTORE_BIN}" --uri="${this.config.MONGO_URI}" --drop --archive="${backupPath}" --gzip`,
        { stdio: "inherit" }
      );

      // Opcional: Registrar la restauración en la base de datos (si es necesario)
      const client = new MongoClient(this.config.MONGO_URI);
      await client.connect();
      const collection = client
        .db()
        .collection<BackupRecord>(this.config.BACKUPS_COLLECTION);

      await collection.updateOne(
        { path: backupPath },
        { $set: { status: "restored" } },
        { upsert: true } // En caso de que el registro no exista
      );

      await client.close();

      console.log("♻️ Sistema restaurado desde el último backup.");
    } catch (error) {
      console.error("Error en restauración:", error);
      throw error;
    }
  }

  public async startMonitoring(): Promise<void> {
    console.log("Iniciando monitorización del sistema...");

    while (true) {
      try {
        const hasRecentSales = await this.checkRecentSales();

        if (!hasRecentSales) {
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
