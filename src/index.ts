// main.ts
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
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

/**
 * Muestra un prompt modal personalizado para solicitar la contraseña.
 * Retorna una Promise que se resuelve con la contraseña (string) o null si se cancela.
 */
async function showPasswordPrompt(parentWindow: BrowserWindow): Promise<string | null> {
  return new Promise((resolve) => {
    const promptWindow = new BrowserWindow({
      width: 400,
      height: 200,
      resizable: false,
      parent: parentWindow,
      modal: true,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    // Contenido HTML simple para solicitar la contraseña
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Confirmación requerida</title>
        <style>
          body { font-family: sans-serif; text-align: center; margin: 20px; }
          input { width: 80%; padding: 8px; font-size: 16px; }
          button { padding: 8px 16px; font-size: 16px; margin: 10px; }
        </style>
      </head>
      <body>
        <h3>Ingresa la contraseña para continuar:</h3>
        <form id="prompt-form">
          <input id="password" type="password" autofocus />
          <br>
          <button type="submit">OK</button>
          <button type="button" id="cancel">Cancelar</button>
        </form>
        <script>
          const { ipcRenderer } = require('electron');
          const form = document.getElementById('prompt-form');
          const cancelButton = document.getElementById('cancel');
          form.addEventListener('submit', (e) => {
            e.preventDefault();
            const password = document.getElementById('password').value;
            ipcRenderer.send('password-submitted', password);
          });
          cancelButton.addEventListener('click', () => {
            ipcRenderer.send('password-cancelled');
          });
        </script>
      </body>
      </html>
    `;

    promptWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent));

    promptWindow.once('ready-to-show', () => {
      promptWindow.show();
    });

    ipcMain.once('password-submitted', (event, password) => {
      resolve(password);
      promptWindow.close();
    });
    ipcMain.once('password-cancelled', () => {
      resolve(null);
      promptWindow.close();
    });

    promptWindow.on('closed', () => {
      resolve(null);
    });
  });
}

/**
 * Muestra una ventana de alerta personalizada con botones organizados:
 * - Centro: Botón grande y verde "No tengo ningún problema"
 * - Abajo a la izquierda: Botón rojo "Sí, tengo problemas"
 *
 * Retorna una Promise que se resuelve con el string:
 * - 'no-problem' si se elige "No tengo ningún problema"
 * - 'has-problem' si se elige "Sí, tengo problemas"
 */
async function showCustomAlert(parentWindow: BrowserWindow): Promise<string> {
  return new Promise((resolve) => {
    const alertWindow = new BrowserWindow({
      width: 500,
      height: 300,
      resizable: false,
      parent: parentWindow,
      modal: true,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Verificación de sistema</title>
        <link rel="stylesheet" href="https://stackpath.bootstrapcdn.com/bootstrap/4.3.1/css/bootstrap.min.css">
        <style>
          body { margin: 20px; }
          .btn-large {
             font-size: 24px;
             padding: 20px;
             width: 100%;
          }
          .container {
             display: flex;
             flex-direction: column;
             height: 100%;
             justify-content: center;
             align-items: center;
          }
          .footer {
             position: absolute;
             bottom: 20px;
             left: 20px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h4 class="text-center">El salvapantallas se ha activado.<br>¿Está teniendo problemas con el sistema?</h4>
          <div style="margin-top: 40px; width: 100%;">
             <button id="noProblemBtn" class="btn btn-success btn-large">No tengo ningún problema</button>
          </div>
        </div>
        <div class="footer">
          <button id="hasProblemBtn" class="btn btn-danger">Sí, tengo problemas</button>
        </div>
        <script>
          const { ipcRenderer } = require('electron');
          document.getElementById('noProblemBtn').addEventListener('click', () => {
             ipcRenderer.send('custom-alert-response', 'no-problem');
          });
          document.getElementById('hasProblemBtn').addEventListener('click', () => {
             ipcRenderer.send('custom-alert-response', 'has-problem');
          });
        </script>
      </body>
      </html>
    `;

    alertWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent));

    alertWindow.once('ready-to-show', () => {
      alertWindow.show();
    });

    ipcMain.once('custom-alert-response', (event, response) => {
      resolve(response);
      alertWindow.close();
    });

    alertWindow.on('closed', () => {
      resolve('closed');
    });
  });
}

class DisasterRecoveryManager {
  // Se usará para evitar disparar múltiples veces la acción
  private alertTriggered: boolean = false;
  private mainWindow: BrowserWindow;

  constructor(private config: Config, mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
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
   * Muestra el diálogo personalizado y, según la respuesta, crea un backup o restaura el sistema.
   */
  private async onInactivityDetected(): Promise<void> {
    if (this.alertTriggered) return;
    this.alertTriggered = true;

    const hasProblems = await this.showDialog();
    if (!hasProblems) {
      await this.createBackup();
    } else {
      await this.restoreFromLatestBackup();
    }

    // Reinicia la bandera para permitir futuros disparos
    this.alertTriggered = false;
  }

  /**
   * Muestra el diálogo personalizado de verificación.
   * - Si el usuario elige "No tengo ningún problema" se retorna false (para crear backup).
   * - Si elige "Sí, tengo problemas" se solicita la contraseña; si es correcta ("yosi"),
   *   se retorna true (para restaurar el backup).
   */
  public async showDialog(): Promise<boolean> {
    try {
      // Cerrar procesos anteriores
      try {
        execSync("killall lanzadera2.sh lanzaderaVisor.sh firefox chrome || true", { stdio: "ignore" });
      } catch (e) { /* Ignorar errores */ }

      while (true) {
        const response = await showCustomAlert(this.mainWindow);
        if (response === 'no-problem') {
          // Usuario elige "No tengo ningún problema"
          return false;
        } else if (response === 'has-problem') {
          // Usuario elige "Sí, tengo problemas": se solicita contraseña
          while (true) {
            const password = await showPasswordPrompt(this.mainWindow);
            if (password === null) {
              // Si se cancela, se vuelve al diálogo principal
              break;
            }
            if (password === 'yosi') {
              return true;
            } else {
              await dialog.showMessageBox(this.mainWindow, {
                type: 'error',
                title: 'Error',
                message: 'Contraseña incorrecta. Inténtalo de nuevo.',
                buttons: ['OK']
              });
              // Se vuelve a solicitar la contraseña
            }
          }
        }
        // Si se cancela el prompt personalizado, se repite el ciclo
      }
    } catch (error) {
      console.error("Error en showDialog:", error);
      // Si ocurre un error, se asume que hay problemas y se retorna true para restaurar
      return true;
    }
  }

  /**
   * Crea un backup utilizando mongodump y registra el backup en la colección correspondiente.
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
   * Restaura el sistema a partir del backup más reciente.
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
    return new Promise(() => { });
  }
}

// --- Ejecución principal de la aplicación Electron ---
app.on('ready', async () => {
  // Crear una ventana oculta (necesaria para los diálogos modales)
  const mainWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  try {
    const manager = new DisasterRecoveryManager(CONFIG, mainWindow);
    await manager.startMonitoring();
  } catch (error) {
    console.error("🔥 Error crítico:", error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
