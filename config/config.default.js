'use strict';

/**
 * 微信公众平台的相关配置
 * @member Config Egg配置
 * @property {String}  appId - 应用号
 * @property {number}  appSecret  - 应用密钥
 * @property {number}  mchId  - 商户平台商家编号
 * @property {number}  apiKey  - 商户支付接口密钥
 * @property {number}  notifyUrl  - 支付结果回调地址
 */
exports.wechat = {
  appId: '',
  appSecret: '',
  mchId: '',
  apiKey: '',
  notifyUrl: '',
  // 开放平台第三方平台配置
  componentAppId: '',
  componentAppSecret: '',
  componentToken: '',
  componentEncodingAESKey: '',

  // 可选：动态注入/覆盖配置（覆盖所有模块）
  // init: async (app) => ({ componentAppId: 'wx...', componentAppSecret: '...' }),
  // override: { componentAppId: 'wx...', componentAppSecret: '...' },

  // 可选：运行时从统一配置读取并周期刷新（需要宿主提供 ctx.service.config.unifiedConfig.get）
  // useUnifiedConfig: true,
  // unifiedConfigRefreshIntervalMs: 30000,
};
