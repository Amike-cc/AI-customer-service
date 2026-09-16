export interface ScreenFingerprint {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  colorDepth: number;
  pixelDepth: number;
}

export interface WebGLFingerprint {
  vendor: string;
  renderer: string;
  unmaskedVendor: string;
  unmaskedRenderer: string;
}

export interface PluginFingerprint {
  name: string;
  filename: string;
  description: string;
  mimeTypes: string[];
}

export interface NetworkInfo {
  effectiveType: string;
  rtt: number;
  downlink: number;
  saveData: boolean;
}

export interface UserAgentDataBrand {
  brand: string;
  version: string;
}

export interface UserAgentData {
  brands: UserAgentDataBrand[];
  mobile: boolean;
  platform: string;
}

export interface ShopFingerprint {
  shopId: string;
  createdAt: number;
  userAgent: string;
  chromeVersion: number;
  chromeFullVersion: string;
  secChUa: string;
  secChUaPlatform: string;
  platform: string;
  vendor: string;
  language: string;
  languages: string[];
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  webdriver: boolean;
  screen: ScreenFingerprint;
  devicePixelRatio: number;
  webgl: WebGLFingerprint;
  timezone: string;
  plugins: PluginFingerprint[];
  network: NetworkInfo;
  userAgentData: UserAgentData;
  secChUaFullVersionList: string;
  canvasNoiseSeed: number;
  audioNoiseSeed: number;
}
