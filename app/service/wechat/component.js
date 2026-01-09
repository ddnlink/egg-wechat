'use strict';

const Service = require('egg').Service;

class ComponentService extends Service {

  get wechatConfig() {
    return this.app.config.wechat || {};
  }

  /**
   * Redis Key 策略：
   * - scoped（默认）：key 中包含 componentAppId，适合多应用隔离
   * - legacy：兼容历史项目（如 ddn-hub）使用的固定 key
   */
  get redisKeyStrategy() {
    return this.wechatConfig.redisKeyStrategy || 'scoped';
  }

  get authUrlReturnObject() {
    return Boolean(this.wechatConfig.authUrlReturnObject);
  }

  get mockMode() {
    const v = this.wechatConfig.mockMode;
    if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true';
    return Boolean(v);
  }

  _assertComponentConfig() {
    const { componentAppId, componentAppSecret } = this.wechatConfig;
    if (!componentAppId || !componentAppSecret) {
      throw new Error('未配置微信开放平台 Component AppID 或 Secret');
    }
  }

  _getKeyComponentAccessToken(componentAppId) {
    if (this.redisKeyStrategy === 'legacy') return 'wechat:component:access_token';
    return `wechat:component_access_token:${componentAppId}`;
  }

  _getKeyComponentVerifyTicket(componentAppId) {
    if (this.redisKeyStrategy === 'legacy') return 'wechat:component:verify_ticket';
    return `wechat:component_verify_ticket:${componentAppId}`;
  }

  _getKeyPreAuthCode(componentAppId) {
    if (this.redisKeyStrategy === 'legacy') return 'wechat:component:pre_auth_code';
    return `wechat:component_preauth_code:${componentAppId}`;
  }

  _getKeyAuthorizerAccessToken(authorizerAppId) {
    if (this.redisKeyStrategy === 'legacy') return `wechat:authorizer:${authorizerAppId}:access_token`;
    return `wechat:authorizer_access_token:${authorizerAppId}`;
  }

  async getComponentVerifyTicket() {
    const { app } = this;
    const { componentAppId } = this.wechatConfig;
    this._assertComponentConfig();

    const logger = app.logger || app.coreLogger;

    const primaryKey = this._getKeyComponentVerifyTicket(componentAppId);
    const ticket = await app.redis.get(primaryKey);
    if (ticket) {
      if (logger && logger.info) logger.info('[egg-wechat] component_verify_ticket hit', {
        redisKeyStrategy: this.redisKeyStrategy,
        componentAppId,
        key: primaryKey,
        ticketLength: String(ticket).length,
        ticketPrefix: String(ticket).slice(0, 8) + '***',
      });
      return ticket;
    }

    // 兼容旧 key（历史项目可能写入该 key）
    const legacyCompat = await app.redis.get('wechat:component:ticket');
    if (legacyCompat) {
      if (logger && logger.info) logger.info('[egg-wechat] component_verify_ticket hit (legacy compat)', {
        redisKeyStrategy: this.redisKeyStrategy,
        componentAppId,
        key: 'wechat:component:ticket',
        ticketLength: String(legacyCompat).length,
        ticketPrefix: String(legacyCompat).slice(0, 8) + '***',
      });
      return legacyCompat;
    }

    if (logger && logger.info) logger.info('[egg-wechat] component_verify_ticket miss', {
      redisKeyStrategy: this.redisKeyStrategy,
      componentAppId,
      triedKeys: [ primaryKey, 'wechat:component:ticket' ],
    });

    throw new Error('未收到微信推送的 Component Verify Ticket，请等待微信服务器推送');
  }

  /**
   * 获取 Component Access Token
   * 优先从 Redis 获取，过期则刷新
   */
  async getComponentAccessToken() {
    const { ctx, app } = this;
    const { componentAppId, componentAppSecret } = this.wechatConfig;

    this._assertComponentConfig();

    const logger = app.logger || app.coreLogger;

    const cacheKey = this._getKeyComponentAccessToken(componentAppId);
    let token = await app.redis.get(cacheKey);

    // 兼容策略切换：当从 scoped 切到 legacy（或反向）时，兜底尝试另一个 key
    if (!token) {
      const fallbackKey = this.redisKeyStrategy === 'legacy'
        ? `wechat:component_access_token:${componentAppId}`
        : 'wechat:component:access_token';
      token = await app.redis.get(fallbackKey);
    }

    if (token) {
      return token;
    }

    // 纯本地伪联调：不请求真实微信接口，直接返回 mock token 并缓存
    if (this.mockMode) {
      token = `mock_component_access_token_${componentAppId}_${Date.now()}`;
      const ttl = 7200;
      await app.redis.set(cacheKey, token, 'EX', ttl);
      if (this.redisKeyStrategy === 'legacy') {
        await app.redis.set(`wechat:component_access_token:${componentAppId}`, token, 'EX', ttl);
      } else {
        await app.redis.set('wechat:component:access_token', token, 'EX', ttl);
      }
      if (logger && logger.info) {
        logger.info('[egg-wechat] mockMode enabled: return mocked component_access_token', {
          componentAppId,
          redisKeyStrategy: this.redisKeyStrategy,
          ttl,
        });
      }
      return token;
    }

    const ticket = await this.getComponentVerifyTicket();

    // 本地伪联调常用 mock ticket，但微信开放平台会直接判无效（errcode=61006）。
    // 非 mockMode 时提前失败，提示如何拿到真实 ticket。
    if (!this.mockMode && typeof ticket === 'string' && ticket.startsWith('mock_')) {
      if (logger && logger.warn) {
        logger.warn('[egg-wechat] component_verify_ticket looks like mock, abort calling wechat api', {
          componentAppId,
          ticketLength: ticket.length,
          ticketPrefix: ticket.slice(0, 8) + '***',
        });
      }
      throw new Error(
        '当前使用 mock component_verify_ticket，无法向微信开放平台换取 component_access_token。' +
        '请配置开放平台“授权事件接收 URL”可被微信公网访问，并等待微信推送真实 ticket 后再试。'
      );
    }

    if (logger && logger.info) logger.info('[egg-wechat] component_access_token refreshing', {
      redisKeyStrategy: this.redisKeyStrategy,
      componentAppId,
      ticketLength: String(ticket).length,
      ticketPrefix: String(ticket).slice(0, 8) + '***',
    });

    // 请求微信接口获取 Token
    const url = 'https://api.weixin.qq.com/cgi-bin/component/api_component_token';
    const result = await ctx.curl(url, {
      method: 'POST',
      contentType: 'json',
      dataType: 'json',
      data: {
        component_appid: componentAppId,
        component_appsecret: componentAppSecret,
        component_verify_ticket: ticket,
      },
    });

    if (result.data.errcode) {
      if (logger && logger.warn) logger.warn('[egg-wechat] api_component_token failed', {
        componentAppId,
        errcode: result.data.errcode,
        errmsg: result.data.errmsg,
      });
      throw new Error(`获取 Component Access Token 失败: ${result.data.errmsg}`);
    }

    token = result.data.component_access_token;
    const expiresIn = result.data.expires_in;

    // 缓存 Token (提前 5 分钟过期)
    const ttl = Math.max(Number(expiresIn || 7200) - 300, 60);
    await app.redis.set(cacheKey, token, 'EX', ttl);

    // legacy / scoped 兼容：同时写入兼容 key，避免灰度期间读取不到
    if (this.redisKeyStrategy === 'legacy') {
      await app.redis.set(`wechat:component_access_token:${componentAppId}`, token, 'EX', ttl);
    } else {
      await app.redis.set('wechat:component:access_token', token, 'EX', ttl);
    }

    return token;
  }

  /**
   * 保存 Component Verify Ticket
   * @param {string} ticket 微信推送的 Ticket
   */
  async saveComponentVerifyTicket(ticket) {
    const { app } = this;
    const { componentAppId } = this.wechatConfig;

    if (!componentAppId) return;

    const key = this._getKeyComponentVerifyTicket(componentAppId);
    // Ticket 有效期通常为 12 小时，这里设置 12 小时过期
    await app.redis.set(key, ticket, 'EX', 12 * 3600);

    // 兼容旧的 Redis Key
    await app.redis.set('wechat:component:ticket', ticket, 'EX', 12 * 3600);

    // legacy / scoped 兼容：同时写入兼容 key，避免灰度期间读取不到
    if (this.redisKeyStrategy === 'legacy') {
      await app.redis.set(`wechat:component_verify_ticket:${componentAppId}`, ticket, 'EX', 12 * 3600);
    } else {
      await app.redis.set('wechat:component:verify_ticket', ticket, 'EX', 12 * 3600);
    }
  }

  /**
   * 获取预授权码 (Pre-Auth Code)
   */
  async getPreAuthCode() {
    const { ctx, app } = this;
    const { componentAppId } = this.wechatConfig;

    const cacheKey = this._getKeyPreAuthCode(componentAppId);
    let cached = await app.redis.get(cacheKey);
    if (!cached) {
      const fallbackKey = this.redisKeyStrategy === 'legacy'
        ? `wechat:component_preauth_code:${componentAppId}`
        : 'wechat:component:pre_auth_code';
      cached = await app.redis.get(fallbackKey);
    }
    if (cached) return cached;

    const token = await this.getComponentAccessToken();

    const url = `https://api.weixin.qq.com/cgi-bin/component/api_create_preauthcode?component_access_token=${token}`;
    const result = await ctx.curl(url, {
      method: 'POST',
      contentType: 'json',
      dataType: 'json',
      data: {
        component_appid: componentAppId,
      },
    });

    if (result.data.errcode) {
      throw new Error(`获取预授权码失败: ${result.data.errmsg}`);
    }

    const preAuthCode = result.data.pre_auth_code;
    const expiresIn = Number(result.data.expires_in || 600);
    const ttl = Math.max(expiresIn - 30, 60);

    await app.redis.set(cacheKey, preAuthCode, 'EX', ttl);

    // legacy / scoped 兼容：同时写入兼容 key
    if (this.redisKeyStrategy === 'legacy') {
      await app.redis.set(`wechat:component_preauth_code:${componentAppId}`, preAuthCode, 'EX', ttl);
    } else {
      await app.redis.set('wechat:component:pre_auth_code', preAuthCode, 'EX', ttl);
    }

    return preAuthCode;
  }

  /**
   * 获取授权方 authorizer_access_token（缓存）
   * https://developers.weixin.qq.com/doc/oplatform/Third-party_Platforms/api/api_authorizer_token.html
   */
  async getAuthorizerAccessToken(authorizerAppId, authorizerRefreshToken) {
    const { ctx, app } = this;
    this._assertComponentConfig();

    if (!authorizerAppId) {
      throw new Error('authorizerAppId is required');
    }
    if (!authorizerRefreshToken) {
      throw new Error('authorizerRefreshToken is required');
    }

    const cacheKey = this._getKeyAuthorizerAccessToken(authorizerAppId);
    let cached = await app.redis.get(cacheKey);
    if (!cached) {
      const fallbackKey = this.redisKeyStrategy === 'legacy'
        ? `wechat:authorizer_access_token:${authorizerAppId}`
        : `wechat:authorizer:${authorizerAppId}:access_token`;
      cached = await app.redis.get(fallbackKey);
    }
    if (cached) {
      return { authorizer_access_token: cached, from_cache: true };
    }

    const { componentAppId } = this.wechatConfig;
    const componentAccessToken = await this.getComponentAccessToken();
    const url = `https://api.weixin.qq.com/cgi-bin/component/api_authorizer_token?component_access_token=${encodeURIComponent(componentAccessToken)}`;

    const result = await ctx.curl(url, {
      method: 'POST',
      contentType: 'json',
      dataType: 'json',
      data: {
        component_appid: componentAppId,
        authorizer_appid: authorizerAppId,
        authorizer_refresh_token: authorizerRefreshToken,
      },
    });

    const data = result.data || {};
    if (data.errcode) {
      throw new Error(`获取 authorizer_access_token 失败: ${data.errmsg}`);
    }

    const token = data.authorizer_access_token;
    const expiresIn = Number(data.expires_in || 7200);
    const ttl = Math.max(expiresIn - 300, 60);

    if (token) {
      await app.redis.set(cacheKey, token, 'EX', ttl);
      // legacy / scoped 兼容：同时写入兼容 key
      if (this.redisKeyStrategy === 'legacy') {
        await app.redis.set(`wechat:authorizer_access_token:${authorizerAppId}`, token, 'EX', ttl);
      } else {
        await app.redis.set(`wechat:authorizer:${authorizerAppId}:access_token`, token, 'EX', ttl);
      }
    }

    return data;
  }

  /**
   * 使用授权码换取公众号/小程序的接口调用凭据和授权信息
   * @param {string} authCode 授权码
   */
  async queryAuth(authCode) {
    const { ctx, app } = this;
    const { componentAppId } = app.config.wechat;

    if (this.mockMode) {
      const logger = app.logger || app.coreLogger;
      const authorizationInfo = {
        authorizer_appid: 'mock_authorizer_appid',
        authorizer_access_token: `mock_authorizer_access_token_${Date.now()}`,
        expires_in: 7200,
        authorizer_refresh_token: `mock_authorizer_refresh_token_${Date.now()}`,
        func_info: [],
      };
      if (logger && logger.info) {
        logger.info('[egg-wechat] mockMode enabled: return mocked authorization_info', {
          componentAppId,
          authCodeMasked: authCode ? String(authCode).slice(0, 8) + '***' : '',
          authorizerAppid: authorizationInfo.authorizer_appid,
        });
      }
      return authorizationInfo;
    }

    const token = await this.getComponentAccessToken();
    const url = `https://api.weixin.qq.com/cgi-bin/component/api_query_auth?component_access_token=${token}`;

    const result = await ctx.curl(url, {
      method: 'POST',
      contentType: 'json',
      dataType: 'json',
      data: {
        component_appid: componentAppId,
        authorization_code: authCode,
      },
    });

    if (result.data.errcode) {
      throw new Error(`换取授权信息失败: ${result.data.errmsg}`);
    }

    return result.data.authorization_info;
  }

  /**
   * 获取授权方的帐号基本信息
   * @param {string} authorizerAppId 授权方AppID
   */
  async getAuthorizerInfo(authorizerAppId) {
    const { ctx, app } = this;
    const { componentAppId } = app.config.wechat;

    if (this.mockMode) {
      const logger = app.logger || app.coreLogger;
      const data = {
        authorizer_info: {
          nick_name: 'Mock公众号',
          head_img: '',
          service_type_info: { id: 2 },
          verify_type_info: { id: 0 },
          user_name: 'gh_mock',
          principal_name: 'Mock Principal',
          alias: 'mock',
          signature: 'mock signature',
          business_info: {},
        },
        qrcode_url: '',
        authorization_info: {
          authorizer_appid: authorizerAppId,
          func_info: [],
        },
      };
      if (logger && logger.info) {
        logger.info('[egg-wechat] mockMode enabled: return mocked authorizer_info', {
          componentAppId,
          authorizerAppId,
        });
      }
      return data;
    }

    const token = await this.getComponentAccessToken();
    const url = `https://api.weixin.qq.com/cgi-bin/component/api_get_authorizer_info?component_access_token=${token}`;

    const result = await ctx.curl(url, {
      method: 'POST',
      contentType: 'json',
      dataType: 'json',
      data: {
        component_appid: componentAppId,
        authorizer_appid: authorizerAppId,
      },
    });

    if (result.data.errcode) {
      throw new Error(`获取授权方基本信息失败: ${result.data.errmsg}`);
    }

    return result.data;
  }

  /**
   * 发送客服消息 (文本)
   * @param {string} accessToken 授权方接口调用凭据
   * @param {string} toUser 接收者OpenID
   * @param {string} content 文本内容
   */
  async sendCustomMessage(accessToken, toUser, content) {
    const { ctx } = this;
    const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${accessToken}`;

    const result = await ctx.curl(url, {
      method: 'POST',
      contentType: 'json',
      dataType: 'json',
      data: {
        touser: toUser,
        msgtype: 'text',
        text: {
          content,
        },
      },
    });

    return result.data;
  }

  /**
   * 生成代公众号发起网页授权的链接
   * @param {string} appid 公众号AppID
   * @param {string} redirectUri 回调地址
   * @param {string} scope 作用域
   * @param {string} state 状态参数
   */
  getOAuthDomainUrl(appid, redirectUri, scope = 'snsapi_userinfo', state = 'STATE') {
    const { app } = this;
    const { componentAppId } = app.config.wechat;
    const encodedRedirectUri = encodeURIComponent(redirectUri);
    return `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${appid}&redirect_uri=${encodedRedirectUri}&response_type=code&scope=${scope}&state=${state}&component_appid=${componentAppId}#wechat_redirect`;
  }

  /**
   * 获取授权页 URL (用于公众号/小程序管理员授权给第三方平台)
   * @param {string} redirectUri 回调地址
   * @param {number} authType 授权类型 (1: 公众号, 2: 小程序, 3: 两者都可)
   */
  async getAuthUrl(redirectUri, authType = 3) {
    const { componentAppId } = this.wechatConfig;
    const encodedRedirectUri = encodeURIComponent(redirectUri);

    // 纯本地伪联调：返回本地 mock 授权页，打开后会重定向回 redirectUri 并携带 auth_code
    if (this.mockMode) {
      let base = String(this.wechatConfig.publicBaseUrl || '').trim();
      try {
        if (!base) base = new URL(String(redirectUri)).origin;
      } catch (e) {
        // ignore
      }
      if (!base) base = 'http://localhost:7001';
      if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
      base = base.replace(/\/$/, '');

      const url = `${base}/api/v1/wechat/component/mock_authorize?redirect_uri=${encodedRedirectUri}&auth_type=${encodeURIComponent(String(authType))}`;
      if (this.authUrlReturnObject) return { pc: url, mobile: url };
      return url;
    }

    const preAuthCode = await this.getPreAuthCode();
    const url = `https://mp.weixin.qq.com/cgi-bin/componentloginpage?component_appid=${componentAppId}&pre_auth_code=${preAuthCode}&redirect_uri=${encodedRedirectUri}&auth_type=${authType}`;
    if (this.authUrlReturnObject) {
      return { pc: url, mobile: url };
    }
    return url;
  }
}

module.exports = ComponentService;
