'use strict';

/**
 * 插件初始化入口：用于在应用启动前，动态覆盖 wechat 配置。
 *
 * 用法：在宿主项目的 config/config.*.js 中提供：
 *
 * exports.wechat = {
 *   // ...原有配置
 *   // init 可同步或异步，返回要覆盖/补充的配置对象
 *   init: async (app) => ({ componentAppId: 'wx...', componentAppSecret: '...' }),
 * };
 *
 * @param {import('egg').Application} app Egg Application
 */
module.exports = app => {
  app.beforeStart(async () => {
    const baseConfig = app.config.wechat || {};

    const normalizeRuntimeCfg = (cfg) => {
      if (!cfg || typeof cfg !== 'object') return null;
      const next = Object.assign({}, cfg);
      Object.keys(next).forEach(k => {
        const v = next[k];
        if (typeof v === 'string') next[k] = v.trim();
        if (next[k] === undefined || next[k] === null || String(next[k]).trim() === '') {
          delete next[k];
        }
      });
      return Object.keys(next).length > 0 ? next : null;
    };

    const override = baseConfig.override && typeof baseConfig.override === 'object'
      ? baseConfig.override
      : null;

    const init = baseConfig.init;

    let initResult = null;
    if (typeof init === 'function') {
      try {
        initResult = await init(app);
      } catch (err) {
        app.logger && app.logger.error && app.logger.error('[egg-wechat] wechat.init failed', err);
      }
    }

    const finalOverride = initResult && typeof initResult === 'object' ? initResult : override;
    if (finalOverride) {
      // 就地合并，保证所有 service 都能读到更新后的值
      Object.assign(baseConfig, finalOverride);
      app.config.wechat = baseConfig;
    }

    const shouldEnableProvider = typeof baseConfig.getConfig === 'function';

    const loadFromProvider = async () => {
      if (!shouldEnableProvider) return null;

      const ctx = app.createAnonymousContext();
      try {
        const cfg = await baseConfig.getConfig(ctx);
        return normalizeRuntimeCfg(cfg);
      } catch (err) {
        app.logger && app.logger.warn && app.logger.warn('[egg-wechat] wechat.getConfig(ctx) failed', err);
        return null;
      }
    };

    const shouldEnableUnifiedConfig = (() => {
      if (baseConfig.useUnifiedConfig === true) return true;
      if (String(baseConfig.configSource || '').toLowerCase() === 'unified') return true;
      // 自动兜底：当 component 配置缺失时尝试从统一配置读取（避免宿主必须写死 secret）
      const hasStaticComponent = Boolean(baseConfig.componentAppId) && Boolean(baseConfig.componentAppSecret);
      return !hasStaticComponent;
    })();

    const refreshIntervalMsRaw = baseConfig.unifiedConfigRefreshIntervalMs;
    const refreshIntervalMs = Number.isFinite(Number(refreshIntervalMsRaw))
      ? Math.max(Number(refreshIntervalMsRaw), 1000)
      : 30 * 1000;

    const loadFromUnifiedConfig = async () => {
      // 在宿主没有 unifiedConfig service 时，静默跳过
      const ctx = app.createAnonymousContext();
      const unified = ctx?.service?.config?.unifiedConfig;
      if (!unified || typeof unified.get !== 'function') return null;

      // 统一配置键（以 ddn-hub 的 wechat_platform.* 为准）
      const keys = {
        appId: 'wechat_platform.app_id',
        appSecret: 'wechat_platform.app_secret',
        componentAppId: 'wechat_platform.component.app_id',
        componentAppSecret: 'wechat_platform.component.app_secret',
        componentToken: 'wechat_platform.component.token',
        componentEncodingAESKey: 'wechat_platform.component.encoding_aes_key',
        publicBaseUrl: 'wechat_platform.public_base_url',
      };

      const entries = await Promise.all(
        Object.entries(keys).map(async ([k, key]) => {
          try {
            const v = await unified.get(key);
            return [k, typeof v === 'string' ? v.trim() : v];
          } catch (e) {
            return [k, undefined];
          }
        })
      );

      const cfg = Object.fromEntries(entries);

      return normalizeRuntimeCfg(cfg);
    };

    const applyRuntimeWechatConfig = (runtimeCfg) => {
      if (!runtimeCfg || typeof runtimeCfg !== 'object') return;

      // 仅在内存中合并：同时写到 app.wechatRuntimeConfig 与 app.config.wechat
      // 目的：
      // - service 读取 app.config.wechat 的代码无需大改
      // - 运行时刷新能覆盖所有模块
      app.wechatRuntimeConfig = Object.assign({}, app.wechatRuntimeConfig || {}, runtimeCfg);
      app.config.wechat = Object.assign({}, app.config.wechat || {}, app.wechatRuntimeConfig);
    };

    // 对宿主/测试暴露一个手动刷新入口，避免等待定时器
    app.wechatRefreshProviderConfig = async () => {
      if (!shouldEnableProvider) return { enabled: false };
      const cfg = await loadFromProvider();
      if (cfg) applyRuntimeWechatConfig(cfg);
      return { enabled: true, applied: Boolean(cfg) };
    };

    app.wechatRefreshUnifiedConfig = async () => {
      if (!shouldEnableUnifiedConfig) return { enabled: false };
      const cfg = await loadFromUnifiedConfig();
      if (cfg) applyRuntimeWechatConfig(cfg);
      return { enabled: true, applied: Boolean(cfg) };
    };

    if (shouldEnableProvider) {
      try {
        const cfg = await loadFromProvider();
        if (cfg) applyRuntimeWechatConfig(cfg);
      } catch (err) {
        app.logger && app.logger.warn && app.logger.warn('[egg-wechat] provider initial load failed', err);
      }

      // 周期刷新 provider：避免进程长期持有过期配置
      setInterval(async () => {
        try {
          const cfg = await loadFromProvider();
          if (cfg) applyRuntimeWechatConfig(cfg);
        } catch (err) {
          app.logger && app.logger.warn && app.logger.warn('[egg-wechat] provider refresh failed', err);
        }
      }, refreshIntervalMs).unref();
    }

    if (shouldEnableUnifiedConfig) {
      try {
        const cfg = await loadFromUnifiedConfig();
        if (cfg) applyRuntimeWechatConfig(cfg);
      } catch (err) {
        app.logger && app.logger.warn && app.logger.warn('[egg-wechat] unifiedConfig initial load failed', err);
      }

      // 周期刷新：在不重启进程的情况下感知统一配置变更
      // 若宿主不需要，可显式设置 useUnifiedConfig=false 并提供静态配置
      setInterval(async () => {
        try {
          const cfg = await loadFromUnifiedConfig();
          if (cfg) applyRuntimeWechatConfig(cfg);
        } catch (err) {
          app.logger && app.logger.warn && app.logger.warn('[egg-wechat] unifiedConfig refresh failed', err);
        }
      }, refreshIntervalMs).unref();
    }

    // 仅输出字段存在性，避免泄露敏感值
    const finalConfig = app.config.wechat || {};
    if (app.logger && app.logger.info) {
      app.logger.info('[egg-wechat] wechat config initialized', {
        providerEnabled: Boolean(shouldEnableProvider),
        useUnifiedConfig: Boolean(shouldEnableUnifiedConfig),
        unifiedConfigRefreshIntervalMs: refreshIntervalMs,
        appIdPresent: Boolean(finalConfig.appId),
        appSecretPresent: Boolean(finalConfig.appSecret),
        componentAppIdPresent: Boolean(finalConfig.componentAppId),
        componentAppSecretPresent: Boolean(finalConfig.componentAppSecret),
        componentTokenPresent: Boolean(finalConfig.componentToken),
        componentEncodingAESKeyPresent: Boolean(finalConfig.componentEncodingAESKey),
        publicBaseUrlPresent: Boolean(finalConfig.publicBaseUrl),
      });
    }
  });
};
