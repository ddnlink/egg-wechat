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

    const primaryKey = this._getKeyComponentVerifyTicket(componentAppId);
    const ticket = await app.redis.get(primaryKey);
    if (ticket) return ticket;

    // 兼容旧 key（历史项目可能写入该 key）
    const legacyCompat = await app.redis.get('wechat:component:ticket');
    if (legacyCompat) return legacyCompat;

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

    const ticket = await this.getComponentVerifyTicket();

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
    const preAuthCode = await this.getPreAuthCode();
    const encodedRedirectUri = encodeURIComponent(redirectUri);

    const url = `https://mp.weixin.qq.com/cgi-bin/componentloginpage?component_appid=${componentAppId}&pre_auth_code=${preAuthCode}&redirect_uri=${encodedRedirectUri}&auth_type=${authType}`;
    if (this.authUrlReturnObject) {
      return { pc: url, mobile: url };
    }
    return url;
  }
}

module.exports = ComponentService;
