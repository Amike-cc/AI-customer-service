import type { ShopFingerprint, PluginFingerprint, UserAgentData } from './types';

function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const CHROME_VERSIONS = [
  { major: 128, full: '128.0.6613.138' },
  { major: 129, full: '129.0.6668.100' },
  { major: 130, full: '130.0.6723.117' },
  { major: 131, full: '131.0.6778.205' },
];

const SCREEN_RESOLUTIONS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1680, height: 1050 },
];

const COLOR_DEPTHS = [24, 30];
const PIXEL_RATIOS = [1, 1.25, 1.5, 2];

const HARDWARE_CONCURRENCIES = [4, 8, 12, 16];
const DEVICE_MEMORIES = [4, 8, 16];

const WEBGL_CONFIGS = [
  {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    unmaskedVendor: 'Google Inc. (Intel)',
    unmaskedRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
    unmaskedVendor: 'Google Inc. (Intel)',
    unmaskedRenderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (AMD)',
    renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    unmaskedVendor: 'Google Inc. (AMD)',
    unmaskedRenderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    unmaskedVendor: 'Google Inc. (NVIDIA)',
    unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    unmaskedVendor: 'Google Inc. (NVIDIA)',
    unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
];

const NETWORK_CONFIGS = [
  { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false },
  { effectiveType: '4g', rtt: 100, downlink: 5, saveData: false },
  { effectiveType: '4g', rtt: 30, downlink: 15, saveData: false },
];

const REAL_PLUGINS: PluginFingerprint[] = [
  {
    name: 'PDF Viewer',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
    mimeTypes: ['application/pdf', 'text/pdf'],
  },
  {
    name: 'Chrome PDF Viewer',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
    mimeTypes: ['application/pdf', 'text/pdf'],
  },
  {
    name: 'Chromium PDF Viewer',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
    mimeTypes: ['application/pdf', 'text/pdf'],
  },
  {
    name: 'Microsoft Edge PDF Viewer',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
    mimeTypes: ['application/pdf', 'text/pdf'],
  },
  {
    name: 'WebKit built-in PDF',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
    mimeTypes: ['application/pdf', 'text/pdf'],
  },
];

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function generateFingerprint(shopId: string): ShopFingerprint {
  const rng = seededRandom(shopId);

  const chromeVer = pick(CHROME_VERSIONS, rng);
  const resolution = pick(SCREEN_RESOLUTIONS, rng);
  const colorDepth = pick(COLOR_DEPTHS, rng);
  const pixelRatio = pick(PIXEL_RATIOS, rng);
  const hwConcurrency = pick(HARDWARE_CONCURRENCIES, rng);
  const deviceMemory = pick(DEVICE_MEMORIES, rng);
  const webglConfig = pick(WEBGL_CONFIGS, rng);
  const networkConfig = pick(NETWORK_CONFIGS, rng);

  const availWidth = resolution.width;
  const availHeight = resolution.height - (resolution.height >= 1080 ? 40 : 30);

  const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer.full} Safari/537.36`;

  const secChUa = `"Chromium";v="${chromeVer.major}", "Google Chrome";v="${chromeVer.major}", "Not?A_Brand";v="99"`;

  const secChUaFullVersionList = `"Chromium";v="${chromeVer.full}", "Google Chrome";v="${chromeVer.full}", "Not?A_Brand";v="99.0.0.0"`;

  const userAgentData: UserAgentData = {
    brands: [
      { brand: 'Chromium', version: String(chromeVer.major) },
      { brand: 'Google Chrome', version: String(chromeVer.major) },
      { brand: 'Not?A_Brand', version: '99' },
    ],
    mobile: false,
    platform: 'Windows',
  };

  return {
    shopId,
    createdAt: Date.now(),
    userAgent,
    chromeVersion: chromeVer.major,
    chromeFullVersion: chromeVer.full,
    secChUa,
    secChUaPlatform: '"Windows"',
    platform: 'Win32',
    vendor: 'Google Inc.',
    language: 'zh-CN',
    languages: ['zh-CN', 'zh', 'en'],
    hardwareConcurrency: hwConcurrency,
    deviceMemory,
    maxTouchPoints: 0,
    webdriver: false,
    screen: {
      width: resolution.width,
      height: resolution.height,
      availWidth,
      availHeight,
      colorDepth,
      pixelDepth: colorDepth,
    },
    devicePixelRatio: pixelRatio,
    webgl: webglConfig,
    timezone: 'Asia/Shanghai',
    plugins: REAL_PLUGINS,
    network: networkConfig,
    userAgentData,
    secChUaFullVersionList,
    canvasNoiseSeed: Math.floor(rng() * 2147483647),
    audioNoiseSeed: Math.floor(rng() * 2147483647),
  };
}
