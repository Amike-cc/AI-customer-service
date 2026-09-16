export const PRELOAD_TEMPLATE = `;(function () {
  var FP = __FINGERPRINT_DATA__;

  function defineGetter(obj, prop, value) {
    try {
      Object.defineProperty(obj, prop, {
        get: () => value,
        configurable: false,
        enumerable: true,
      });
    } catch (e) {}
  }

  // ===== navigator 属性覆盖 =====
  defineGetter(navigator, 'userAgent', FP.userAgent);
  defineGetter(navigator, 'appVersion', FP.userAgent.replace('Mozilla/', ''));
  defineGetter(navigator, 'platform', FP.platform);
  defineGetter(navigator, 'vendor', FP.vendor);
  defineGetter(navigator, 'language', FP.language);
  defineGetter(navigator, 'languages', FP.languages);
  defineGetter(navigator, 'hardwareConcurrency', FP.hardwareConcurrency);
  try { defineGetter(navigator, 'deviceMemory', FP.deviceMemory); } catch (e) {}
  defineGetter(navigator, 'webdriver', FP.webdriver);
  defineGetter(navigator, 'maxTouchPoints', FP.maxTouchPoints);

  // navigator.connection
  try {
    if (navigator.connection) {
      defineGetter(navigator.connection, 'effectiveType', FP.network.effectiveType);
      defineGetter(navigator.connection, 'rtt', FP.network.rtt);
      defineGetter(navigator.connection, 'downlink', FP.network.downlink);
      defineGetter(navigator.connection, 'saveData', FP.network.saveData);
    } else {
      var fakeConnection = {
        effectiveType: FP.network.effectiveType,
        rtt: FP.network.rtt,
        downlink: FP.network.downlink,
        saveData: FP.network.saveData,
        addEventListener: function () {},
        removeEventListener: function () {},
      };
      Object.defineProperty(navigator, 'connection', {
        get: function () { return fakeConnection; },
        configurable: false,
        enumerable: true,
      });
    }
  } catch (e) {}

  // ===== navigator.plugins（真实结构）=====
  try {
    var fakePlugins = FP.plugins.map(function (p) {
      var plugin = Object.create(Plugin.prototype);
      Object.defineProperties(plugin, {
        name: { get: function () { return p.name; } },
        filename: { get: function () { return p.filename; } },
        description: { get: function () { return p.description; } },
        length: { get: function () { return p.mimeTypes.length; } },
      });
      return plugin;
    });

    Object.defineProperty(navigator, 'plugins', {
      get: function () {
        var arr = fakePlugins;
        arr.item = function (i) { return arr[i] || null; };
        arr.namedItem = function (name) {
          for (var i = 0; i < arr.length; i++) { if (arr[i].name === name) return arr[i]; }
          return null;
        };
        return arr;
      },
      configurable: false,
      enumerable: true,
    });

    var allMimes = [];
    FP.plugins.forEach(function (p) {
      p.mimeTypes.forEach(function (mt) {
        if (allMimes.indexOf(mt) === -1) allMimes.push(mt);
      });
    });
    Object.defineProperty(navigator, 'mimeTypes', {
      get: function () {
        var arr = allMimes.map(function (mt) {
          var mtObj = Object.create(MimeType.prototype);
          Object.defineProperties(mtObj, {
            type: { get: function () { return mt; } },
            suffixes: { get: function () { return 'pdf'; } },
            description: { get: function () { return 'Portable Document Format'; } },
          });
          return mtObj;
        });
        arr.item = function (i) { return arr[i] || null; };
        arr.namedItem = function (name) {
          for (var i = 0; i < arr.length; i++) { if (arr[i].type === name) return arr[i]; }
          return null;
        };
        return arr;
      },
      configurable: false,
      enumerable: true,
    });
  } catch (e) {}

  // ===== navigator.userAgentData 覆盖 =====
  try {
    var uaData = {
      brands: FP.userAgentData.brands,
      mobile: FP.userAgentData.mobile,
      platform: FP.userAgentData.platform,
      getHighEntropyValues: function () {
        return Promise.resolve({
          brands: FP.userAgentData.brands,
          mobile: FP.userAgentData.mobile,
          platform: FP.userAgentData.platform,
          platformVersion: '15.0.0',
          architecture: 'x86',
          bitness: '64',
          model: '',
          uaFullVersion: FP.chromeFullVersion,
          fullVersionList: FP.userAgentData.brands.map(function (b) {
            return { brand: b.brand, version: b.brand === 'Not?A_Brand' ? '99.0.0.0' : FP.chromeFullVersion };
          }),
        });
      },
      toJSON: function () {
        return { brands: FP.userAgentData.brands, mobile: FP.userAgentData.mobile, platform: FP.userAgentData.platform };
      },
    };
    Object.defineProperty(navigator, 'userAgentData', {
      get: function () { return uaData; },
      configurable: false,
      enumerable: true,
    });
  } catch (e) {}

  // ===== screen 属性覆盖 =====
  try {
    defineGetter(screen, 'width', FP.screen.width);
    defineGetter(screen, 'height', FP.screen.height);
    defineGetter(screen, 'availWidth', FP.screen.availWidth);
    defineGetter(screen, 'availHeight', FP.screen.availHeight);
    defineGetter(screen, 'colorDepth', FP.screen.colorDepth);
    defineGetter(screen, 'pixelDepth', FP.screen.pixelDepth);
  } catch (e) {}

  // ===== window.devicePixelRatio =====
  try {
    Object.defineProperty(window, 'devicePixelRatio', {
      get: function () { return FP.devicePixelRatio; },
      configurable: false,
    });
  } catch (e) {}

  // ===== window.chrome 对象 =====
  try {
    if (!window.chrome) {
      window.chrome = {
        runtime: {
          onConnect: { addListener: function () {}, removeListener: function () {} },
          onMessage: { addListener: function () {}, removeListener: function () {} },
          connect: function () {},
          sendMessage: function () {},
        },
        loadTimes: function () {
          return {
            requestTime: Date.now() / 1000,
            startLoadTime: Date.now() / 1000,
            commitLoadTime: Date.now() / 1000,
            finishDocumentLoadTime: Date.now() / 1000,
            finishLoadTime: Date.now() / 1000,
            firstPaintTime: Date.now() / 1000,
            firstPaintAfterLoadTime: 0,
            navigationType: 'Other',
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true,
            npnNegotiatedProtocol: 'h2',
            wasAlternateProtocolAvailable: false,
            connectionInfo: 'h2',
          };
        },
        csi: function () {
          return { startE: Date.now(), onloadT: Date.now(), pageT: 0, tran: 15 };
        },
      };
    }
  } catch (e) {}

  // ===== WebGL 指纹覆盖 =====
  try {
    var originalGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      if (param === 0x9245) return FP.webgl.unmaskedVendor;
      if (param === 0x9246) return FP.webgl.unmaskedRenderer;
      if (param === 0x1F00) return FP.webgl.vendor;
      if (param === 0x1F01) return FP.webgl.renderer;
      return originalGetParameter.call(this, param);
    };
    if (typeof WebGL2RenderingContext !== 'undefined') {
      var originalGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (param) {
        if (param === 0x9245) return FP.webgl.unmaskedVendor;
        if (param === 0x9246) return FP.webgl.unmaskedRenderer;
        if (param === 0x1F00) return FP.webgl.vendor;
        if (param === 0x1F01) return FP.webgl.renderer;
        return originalGetParameter2.call(this, param);
      };
    }
  } catch (e) {}

  // ===== Canvas 指纹噪声 =====
  try {
    var canvasSeed = FP.canvasNoiseSeed;
    function noiseBit(index) {
      var x = (canvasSeed + index) & 0xff;
      return (x ^ (x >> 3) ^ (x >> 5)) & 0x1;
    }
    function applyCanvasNoise(sourceCanvas) {
      var tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = sourceCanvas.width;
      tmpCanvas.height = sourceCanvas.height;
      var tmpCtx = tmpCanvas.getContext('2d');
      tmpCtx.drawImage(sourceCanvas, 0, 0);
      var imageData = tmpCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
      var data = imageData.data;
      for (var i = 0; i < data.length; i += 4) { data[i] ^= noiseBit(i); }
      tmpCtx.putImageData(imageData, 0, 0);
      return tmpCanvas;
    }
    var originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function () {
      try {
        var ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          var tmpCanvas = applyCanvasNoise(this);
          return originalToDataURL.apply(tmpCanvas, arguments);
        }
      } catch (e) {}
      return originalToDataURL.apply(this, arguments);
    };
    var originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback) {
      try {
        var ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          var tmpCanvas = applyCanvasNoise(this);
          return originalToBlob.apply(tmpCanvas, arguments);
        }
      } catch (e) {}
      return originalToBlob.apply(this, arguments);
    };
  } catch (e) {}

  // ===== AudioContext 指纹噪声 =====
  try {
    var audioSeed = FP.audioNoiseSeed;
    var originalCreateAnalyser = AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser = function () {
      var analyser = originalCreateAnalyser.call(this);
      var originalGetFloatFrequencyData = analyser.getFloatFrequencyData.bind(analyser);
      analyser.getFloatFrequencyData = function (array) {
        originalGetFloatFrequencyData(array);
        for (var i = 0; i < array.length; i++) {
          array[i] += ((audioSeed + i) % 100) / 100000;
        }
      };
      return analyser;
    };
    if (typeof OfflineAudioContext !== 'undefined') {
      var originalOACCreateAnalyser = OfflineAudioContext.prototype.createAnalyser;
      OfflineAudioContext.prototype.createAnalyser = function () {
        var analyser = originalOACCreateAnalyser.call(this);
        var originalGetFloatFrequencyData = analyser.getFloatFrequencyData.bind(analyser);
        analyser.getFloatFrequencyData = function (array) {
          originalGetFloatFrequencyData(array);
          for (var i = 0; i < array.length; i++) {
            array[i] += ((audioSeed + i) % 100) / 100000;
          }
        };
        return analyser;
      };
    }
  } catch (e) {}

  // ===== Intl 时区覆盖 =====
  try {
    var originalDateTimeFormat = Intl.DateTimeFormat;
    var resolvedOptions = originalDateTimeFormat.prototype.resolvedOptions;
    originalDateTimeFormat.prototype.resolvedOptions = function () {
      var result = resolvedOptions.call(this);
      result.timeZone = FP.timezone;
      return result;
    };
  } catch (e) {}

  // ===== Notification.permission 覆盖 =====
  try {
    if (typeof Notification !== 'undefined') {
      defineGetter(Notification, 'permission', 'default');
    }
  } catch (e) {}

  // ===== RTCPeerConnection 防止 IP 泄漏 =====
  try {
    if (typeof RTCPeerConnection !== 'undefined') {
      var originalRTC = RTCPeerConnection;
      var RTCProxy = function (config, constraints) {
        if (config && config.iceServers) {
          config.iceServers = config.iceServers.map(function (server) {
            return { urls: server.urls };
          });
        }
        return new originalRTC(config, constraints);
      };
      RTCProxy.prototype = originalRTC.prototype;
      window.RTCPeerConnection = RTCProxy;
    }
  } catch (e) {}

  // ===== permissions API 覆盖 =====
  try {
    if (navigator.permissions && navigator.permissions.query) {
      var originalQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function (param) {
        if (param && param.name === 'notifications') {
          return Promise.resolve({ state: 'prompt', onchange: null });
        }
        return originalQuery(param);
      };
    }
  } catch (e) {}

})();
`;
