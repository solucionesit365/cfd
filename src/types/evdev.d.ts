declare module "evdev" {
    export interface DeviceOptions {
        raw: string;
    }

    export default class Device {
        // Permite pasar directamente la ruta como string o un objeto con la propiedad raw.
        constructor(options: string | DeviceOptions);
        on(event: string, callback: (...args: any[]) => void): void;
        // Agrega otros métodos/properties según necesites.
    }
}