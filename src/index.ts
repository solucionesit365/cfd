import { MongoClient, Db, Collection } from "mongodb";
import { execSync } from "child_process";
import { format } from "date-fns";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Configuración con tipos
interface Config {
  MONGO_URI: string;
  CHECK_INTERVAL: number;
  HOST_BACKUP_DIR: string;
  CONTAINER_BACKUP_DIR: string;
  SALES_COLLECTION: string;
  BACKUPS_COLLECTION: string;
  CONTAINER_NAME: string;
}

const CONFIG: Config = {
  MONGO_URI: "mongodb://localhost:27017/tocgame",
  CHECK_INTERVAL: 300000, // 5 minutos
  HOST_BACKUP_DIR: join(homedir(), "backups"),
  CONTAINER_BACKUP_DIR: "/tmp/mongobackups",
  SALES_COLLECTION: "sales",
  BACKUPS_COLLECTION: "backups",
  CONTAINER_NAME: "mongodb", // Verificar nombre del contenedor con 'docker ps'
};

// Tipos para los documentos de MongoDB
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
  private dbClient?: MongoClient;

  constructor(private config: Config) {
    this.ensureBackupDir();
  }

  private ensureBackupDir(): void {
    if (!existsSync(this.config.HOST_BACKUP_DIR)) {
      mkdirSync(this.config.HOST_BACKUP_DIR, { recursive: true, mode: 0o755 });
    }
  }

  public async checkRecentSales(): Promise<boolean> {
    this.dbClient = new MongoClient(this.config.MONGO_URI);

    try {
      await this.dbClient.connect();
      const database: Db = this.dbClient.db();
      const collection: Collection<Sale> = database.collection(
        this.config.SALES_COLLECTION
      );

      const fiveMinutesAgo = new Date(Date.now() - this.config.CHECK_INTERVAL);

      const count: number = await collection.countDocuments({
        createdAt: { $gte: fiveMinutesAgo },
      });

      return count > 0;
    } finally {
      await this.dbClient.close();
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

  public async createBackup(): Promise<void> {
    const timestamp = format(new Date(), "yyyyMMdd-HHmmss");
    const backupName = `backup-${timestamp}`;
    const containerBackupPath = join(
      this.config.CONTAINER_BACKUP_DIR,
      backupName
    );
    const hostBackupPath = join(this.config.HOST_BACKUP_DIR, backupName);

    try {
      // 1. Crear backup dentro del contenedor
      execSync(
        `docker exec ${this.config.CONTAINER_NAME} ` +
          `mongodump --uri="${this.config.MONGO_URI}" ` +
          `--out="${containerBackupPath}"`,
        { stdio: "inherit" }
      );

      // 2. Copiar desde contenedor a host
      execSync(
        `docker cp ${this.config.CONTAINER_NAME}:${containerBackupPath} ${this.config.HOST_BACKUP_DIR}`,
        { stdio: "inherit" }
      );

      // 3. Limpiar contenedor
      execSync(
        `docker exec ${this.config.CONTAINER_NAME} rm -rf ${containerBackupPath}`,
        { stdio: "inherit" }
      );

      // Registrar en MongoDB
      const client = new MongoClient(this.config.MONGO_URI);
      await client.connect();
      const collection = client
        .db()
        .collection<BackupRecord>(this.config.BACKUPS_COLLECTION);

      await collection.insertOne({
        path: hostBackupPath,
        createdAt: new Date(),
        type: "emergency",
        status: "created",
      });

      await client.close();
    } catch (error) {
      console.error("Error en creación de backup:", error);
      throw error;
    }
  }

  private async restoreFromLatestBackup(): Promise<void> {
    const client = new MongoClient(this.config.MONGO_URI);

    try {
      await client.connect();
      const collection = client
        .db()
        .collection<BackupRecord>(this.config.BACKUPS_COLLECTION);

      const latestBackup = await collection.findOne(
        { status: "created" },
        { sort: { createdAt: -1 } }
      );

      if (!latestBackup) {
        throw new Error("No hay backups disponibles para restaurar");
      }

      // Preparar rutas
      const backupDirName = latestBackup.path.split("/").pop() || "";
      const containerRestorePath = join(
        this.config.CONTAINER_BACKUP_DIR,
        "restore",
        backupDirName
      );

      // 1. Crear directorio temporal en contenedor
      execSync(
        `docker exec ${this.config.CONTAINER_NAME} mkdir -p ${containerRestorePath}`,
        { stdio: "inherit" }
      );

      // 2. Copiar backup al contenedor
      execSync(
        `docker cp "${latestBackup.path}" ${this.config.CONTAINER_NAME}:${containerRestorePath}`,
        { stdio: "inherit" }
      );

      // 3. Ejecutar restore
      execSync(
        `docker exec ${this.config.CONTAINER_NAME} ` +
          `mongorestore --uri="${this.config.MONGO_URI}" ` +
          `--dir="${containerRestorePath}" --drop`,
        { stdio: "inherit" }
      );

      // 4. Limpiar contenedor
      execSync(
        `docker exec ${this.config.CONTAINER_NAME} rm -rf ${join(
          this.config.CONTAINER_BACKUP_DIR,
          "restore"
        )}`,
        { stdio: "inherit" }
      );

      // Actualizar estado
      await collection.updateOne(
        { _id: latestBackup._id },
        { $set: { status: "restored" } }
      );
    } catch (error) {
      console.error("Error en restauración:", error);
      throw error;
    } finally {
      await client.close();
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
            console.log("✅ Backup preventivo creado correctamente");
          } else {
            await this.restoreFromLatestBackup();
            console.log("♻️ Sistema restaurado desde el último backup");
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
