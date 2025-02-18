import { MongoClient, Collection } from "mongodb";
import { execSync } from "child_process";
import { format } from "date-fns";
import { existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { sessionBus } from "dbus-next";

// Configuración con tipos
interface Config {
  MONGO_URI: string;
  CHECK_INTERVAL: number; // No se utiliza, pero se conserva por compatibilidad
  HOST_BACKUP_DIR: string;
  SALES_COLLECTION: string;
  BACKUPS_COLLECTION: string;
  MONGODUMP_BIN: string;
  MONGORESTORE_BIN: string;
}

const CONFIG: Config = {
  MONGO_URI: "mongodb://localhost:27017/tocgame",
  CHECK_INTERVAL: 300000, // 5 minutos (no se utiliza en este ejemplo)
  HOST_BACKUP_DIR: join(homedir(), "backups", "tocgamedb"),
  SALES_COLLECTION: "sales",
  BACKUPS_COLLECTION: "backups",
  MONGODUMP_BIN: "mongodump",
  MONGORESTORE_BIN: "mongorestore",
};

class DisasterRecoveryManager {
  // Se usará para evitar disparar múltiples veces la acción
  private alertTriggered: boolean = false;

  constructor(private config: Config) {
    this.ensureBackupDir();
  }

  private ensureBackupDir(): void {
    if (!existsSync(this.config.HOST_BACKUP_DIR)) {
      mkdirSync(this.config.HOST_BACKUP_DIR, { recursive: true, mode: 0o700 });
      console.log(`Directorio de backups creado: ${this.config.HOST_BACKUP_DIR}`);
    }
  }

  /**
   * Se suscribe al evento "ActiveChanged" del salvapantallas de GNOME vía DBus.
   * Cuando se activa (active=true), se asume inactividad y se dispara la lógica.
   */
  private async startScreenSaverMonitoring(): Promise<void> {
    const bus = sessionBus();
    try {
      const proxyObject = await bus.getProxyObject(
        "org.gnome.ScreenSaver",
        "/org/gnome/ScreenSaver"
      );
      const screensaver = proxyObject.getInterface("org.gnome.ScreenSaver");

      // Cuando se activa el salvapantallas (inactividad detectada)
      screensaver.on("ActiveChanged", (active: boolean) => {
        if (active) {
          console.log("⚠️ Salvapantallas activado (inactividad detectada).");
          this.onInactivityDetected();
        } else {
          console.log("Salvapantallas desactivado, actividad detectada.");
        }
      });

      console.log("Monitoreando el estado del salvapantallas...");
    } catch (error) {
      console.error("Error al suscribirse al salvapantallas:", error);
    }
  }

  /**
   * Se ejecuta cuando se detecta inactividad (salvapantallas activado).
   * Muestra un diálogo y, según la respuesta, crea un backup o restaura el sistema.
   */
  private async onInactivityDetected(): Promise<void> {
    if (this.alertTriggered) return;
    this.alertTriggered = true;

    const hasProblems = this.showDialog();
    if (!hasProblems) {
      await this.createBackup();
    } else {
      await this.restoreFromLatestBackup();
    }

    // Reinicia la bandera para permitir futuros disparos
    this.alertTriggered = false;
  }

  /**
   * Muestra un diálogo de alerta usando zenity.
   * Retorna true si el usuario indica que hay problemas; de lo contrario, false.
   */
  public showDialog(): boolean {
    try {
      execSync(
        'zenity --question --title="Verificación de sistema" ' +
        '--text="El salvapantallas se ha activado. ¿Está teniendo problemas con el sistema?" ' +
        "--width=300",
        { stdio: "inherit" }
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Crea un backup del sistema utilizando mongodump en modo archive (.gz)
   * y registra el backup en la colección correspondiente.
   */
  public async createBackup(): Promise<void> {
    const timestamp = format(new Date(), "yyyyMMdd-HHmmss");
    const backupBasePath = join(this.config.HOST_BACKUP_DIR, `backup-${timestamp}`);
    const backupFile = `${backupBasePath}.gz`;

    try {
      console.log(`Creando backup en: ${backupFile}`);
      execSync(
        `"${this.config.MONGODUMP_BIN}" --uri="${this.config.MONGO_URI}" --archive="${backupFile}" --gzip`,
        { stdio: "inherit" }
      );

      const client = new MongoClient(this.config.MONGO_URI);
      await client.connect();
      const collection: Collection<any> = client
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

  /**
   * Restaura el sistema a partir del backup archive más reciente.
   */
  private async restoreFromLatestBackup(): Promise<void> {
    try {
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
      execSync(
        `"${this.config.MONGORESTORE_BIN}" --uri="${this.config.MONGO_URI}" --drop --archive="${backupPath}" --gzip`,
        { stdio: "inherit" }
      );

      const client = new MongoClient(this.config.MONGO_URI);
      await client.connect();
      const collection = client
        .db()
        .collection(this.config.BACKUPS_COLLECTION);

      await collection.updateOne(
        { path: backupPath },
        { $set: { status: "restored" } },
        { upsert: true }
      );

      await client.close();
      console.log("♻️ Sistema restaurado desde el último backup.");
    } catch (error) {
      console.error("Error en restauración:", error);
      throw error;
    }
  }

  /**
   * Inicia la monitorización del salvapantallas.
   * Mantiene el proceso en ejecución indefinidamente.
   */
  public async startMonitoring(): Promise<void> {
    await this.startScreenSaverMonitoring();
    console.log("Iniciando monitorización basada en el salvapantallas...");
    // Mantener el proceso vivo
    return new Promise(() => { });
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
