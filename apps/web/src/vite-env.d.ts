/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

interface ImportMetaEnv {
  readonly VITE_MOCK?: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface BarcodeDetectorResult {
  rawValue: string;
  format: string;
}
declare class BarcodeDetector {
  constructor(opts?: { formats: string[] });
  static getSupportedFormats(): Promise<string[]>;
  detect(source: CanvasImageSource | ImageBitmap | ImageData | Blob): Promise<BarcodeDetectorResult[]>;
}
