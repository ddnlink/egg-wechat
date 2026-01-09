'use strict';

const Service = require('egg').Service;
const crypto = require('crypto');
const WXBizMsgCrypt = require('wechat-crypto');

function sha1(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex');
}

function calcPlainSignature(token, timestamp, nonce) {
  const list = [ String(token || ''), String(timestamp || ''), String(nonce || '') ].sort();
  return sha1(list.join(''));
}

function getRawXmlBody(ctx) {
  const body = ctx.request && ctx.request.body;
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');

  const rawBody = ctx.request && ctx.request.rawBody;
  if (typeof rawBody === 'string') return rawBody;
  if (Buffer.isBuffer(rawBody)) return rawBody.toString('utf8');

  return '';
}

function safeSlice(input, n = 180) {
  const v = String(input || '');
  return v.length > n ? v.slice(0, n) : v;
}

class WechatPlatformHttpService extends Service {
  get wechatConfig() {
    return this.app.config.wechat || {};
  }

  // ===== 多租户参数名收敛（可配置） =====
  // 背景：宿主不一定使用 daoId 作为租户标识参数名（可能叫 tenantId/orgId/spaceId 等）。
  // 约定：
  // - wechat.tenantIdParamName: 生成 redirect_uri/callbackUrl 时使用的参数名（默认 daoId）
  // - wechat.tenantIdQueryKeys: 读取请求时允许的参数名列表（默认包含 tenantIdParamName + daoId + dao_id）
  _getTenantIdParamName() {
    const configured = this.wechatConfig.tenantIdParamName;
    const v = String(configured || '').trim();
    return v || 'daoId';
  }

  _getTenantIdQueryKeys() {
    const configured = this.wechatConfig.tenantIdQueryKeys;
    const keys = [];

    const push = (k) => {
      const v = String(k || '').trim();
      if (!v) return;
      if (!keys.includes(v)) keys.push(v);
    };

    if (Array.isArray(configured)) {
      configured.forEach(push);
    } else if (typeof configured === 'string') {
      configured.split(',').map(s => s.trim()).forEach(push);
    }

    // 默认兼容：daoId/dao_id
    push(this._getTenantIdParamName());
    push('daoId');
    push('dao_id');

    return keys;
  }

  _resolveTenantIdFromRequest() {
    const { ctx } = this;

    // 1) 优先从 query 中按配置 key 读取
    const query = ctx && ctx.query ? ctx.query : {};
    const keys = this._getTenantIdQueryKeys();
    for (const k of keys) {
      const val = query && Object.prototype.hasOwnProperty.call(query, k) ? query[k] : undefined;
      const v = String(val || '').trim();
      if (v) return v;
    }

    // 2) 兜底：如果宿主有域名/多租户中间件，可能挂在 ctx.daoContext/ctx.dao
    const ctxDaoId = ctx?.daoContext?.daoId || ctx?.dao?.id;
    const ctxDaoIdStr = String(ctxDaoId || '').trim();
    if (ctxDaoIdStr) return ctxDaoIdStr;

    return '';
  }

  get mockMode() {
    const v = this.wechatConfig.mockMode;
    if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true';
    return Boolean(v);
  }

  logStep(step, expected, actual, extra = {}) {
    this.ctx.logger.debug('WECHAT_DEBUG_STEP', {
      step,
      expected,
      actual,
      ...extra,
    });
  }

  async _ensureComponentCryptoConfig() {
    const { app } = this;

    const hasEnough = () => {
      const c = app.config.wechat || {};
      return Boolean(String(c.componentToken || '').trim())
        && Boolean(String(c.componentEncodingAESKey || '').trim())
        && Boolean(String(c.componentAppId || '').trim());
    };

    if (hasEnough()) return;

    if (typeof app.wechatRefreshProviderConfig === 'function') {
      await app.wechatRefreshProviderConfig();
      if (hasEnough()) return;
    }

    if (typeof app.wechatRefreshUnifiedConfig === 'function') {
      await app.wechatRefreshUnifiedConfig();
      if (hasEnough()) return;
    }

    // 最后兜底：当宿主有 unifiedConfig service 时直接读一次
    try {
      const ctx = app.createAnonymousContext();
      const unified = ctx?.service?.config?.unifiedConfig;
      if (unified && typeof unified.get === 'function') {
        const [ token, aesKey, appId ] = await Promise.all([
          unified.get('wechat_platform.component.token'),
          unified.get('wechat_platform.component.encoding_aes_key'),
          unified.get('wechat_platform.component.app_id'),
        ]);
        app.config.wechat = Object.assign({}, app.config.wechat || {}, {
          componentToken: typeof token === 'string' ? token.trim() : token,
          componentEncodingAESKey: typeof aesKey === 'string' ? aesKey.trim() : aesKey,
          componentAppId: typeof appId === 'string' ? appId.trim() : appId,
        });
      }
    } catch (e) {
      // ignore
    }
  }

  _parseXml(xml) {
    if (!xml || typeof xml !== 'string') return null;
    try {
      // 依赖插件扩展的 helper.xml2json
      if (this.ctx.helper && typeof this.ctx.helper.xml2json === 'function') {
        return this.ctx.helper.xml2json(xml);
      }
    } catch (e) {
      // ignore
    }

    return null;
  }

  _getEncryptFromBody() {
    const { ctx } = this;
    const body = ctx.request && ctx.request.body;
    if (body && typeof body === 'object') {
      return body.Encrypt || body.encrypt || body?.xml?.Encrypt || body?.xml?.encrypt || null;
    }
    return null;
  }

  async notify() {
    const { ctx } = this;

    await this._ensureComponentCryptoConfig();

    const componentToken = String(this.wechatConfig.componentToken || '').trim();
    const componentEncodingAESKey = String(this.wechatConfig.componentEncodingAESKey || '').trim();
    const componentAppId = String(this.wechatConfig.componentAppId || '').trim();

    try {
      const { msg_signature, timestamp, nonce } = ctx.query;

      this.logStep(
        'COMPONENT_NOTIFY_1_CONFIG',
        { tokenPresent: true, encodingAesKeyPresent: true, componentAppIdPresent: true },
        {
          tokenPresent: Boolean(componentToken),
          encodingAesKeyPresent: Boolean(componentEncodingAESKey),
          componentAppIdPresent: Boolean(componentAppId),
          componentAppId,
        }
      );

      this.logStep(
        'COMPONENT_NOTIFY_2_QUERY',
        { hasSignatureParams: true },
        {
          hasMsgSignature: Boolean(msg_signature),
          hasTimestamp: Boolean(timestamp),
          hasNonce: Boolean(nonce),
        }
      );

      const xml = getRawXmlBody(ctx);
      if (!xml && (!ctx.request.body || typeof ctx.request.body !== 'object')) {
        this.logStep(
          'COMPONENT_NOTIFY_3_BODY',
          { bodyNotEmpty: true },
          { bodyNotEmpty: false, contentType: ctx.get('Content-Type') }
        );
        ctx.body = 'success';
        return;
      }

      const cryptor = new WXBizMsgCrypt(componentToken, componentEncodingAESKey, componentAppId);

      let encrypt = this._getEncryptFromBody();
      if (!encrypt) {
        const parsed = this._parseXml(xml);
        encrypt = parsed?.Encrypt;
      }

      if (!encrypt) {
        this.logStep(
          'COMPONENT_NOTIFY_4_ENCRYPT',
          { encryptPresent: true },
          { encryptPresent: false, bodyType: typeof ctx.request.body }
        );
        ctx.body = 'success';
        return;
      }

      this.logStep(
        'COMPONENT_NOTIFY_4_ENCRYPT',
        { encryptPresent: true },
        { encryptPresent: true }
      );

      if (msg_signature && timestamp && nonce) {
        const expected = cryptor.getSignature(timestamp, nonce, encrypt);
        if (expected !== msg_signature) {
          this.logStep(
            'COMPONENT_NOTIFY_5_SIGNATURE',
            { signatureMatches: true },
            { signatureMatches: false }
          );
          ctx.body = 'success';
          return;
        }
      }

      this.logStep(
        'COMPONENT_NOTIFY_5_SIGNATURE',
        { signatureMatches: true },
        { signatureMatches: true }
      );

      const decrypted = cryptor.decrypt(encrypt);
      const message = decrypted && decrypted.message;
      const info = this._parseXml(message);

      this.logStep(
        'COMPONENT_NOTIFY_6_DECRYPTED',
        { infoTypePresent: true },
        {
          infoTypePresent: Boolean(info?.InfoType),
          infoType: info?.InfoType,
          hasTicket: Boolean(info?.ComponentVerifyTicket),
          ticketSample: info?.ComponentVerifyTicket ? String(info.ComponentVerifyTicket).slice(0, 12) + '***' : undefined,
        }
      );

      if (info && info.InfoType === 'component_verify_ticket') {
        this.logStep(
          'COMPONENT_NOTIFY_7_SAVE_TICKET',
          { willSaveTicket: true },
          { willSaveTicket: true, ticketPresent: Boolean(info.ComponentVerifyTicket) }
        );

        const ticket = info.ComponentVerifyTicket;

        // 优先走宿主的业务 service（ddn-hub 会做更多记录/兼容）
        if (ctx.service?.third?.wechatPlatform && typeof ctx.service.third.wechatPlatform.saveComponentVerifyTicket === 'function') {
          await ctx.service.third.wechatPlatform.saveComponentVerifyTicket(ticket);
        } else {
          await ctx.service.wechat.component.saveComponentVerifyTicket(ticket);
        }
      }

      ctx.body = 'success';
    } catch (err) {
      this.logStep(
        'COMPONENT_NOTIFY_999_ERROR',
        { ok: true },
        { ok: false, message: err?.message }
      );
      ctx.body = 'success';
    }
  }

  async getAuthUrl() {
    const { ctx } = this;
    const tenantId = this._resolveTenantIdFromRequest();
    const tenantKey = this._getTenantIdParamName();

    if (!tenantId) {
      ctx.throw(400, `Missing tenant id (${tenantKey})`);
    }

    this.logStep(
      'COMPONENT_AUTH_URL_1_INPUT',
      { daoIdPresent: true },
      { daoIdPresent: true, daoId: tenantId, tenantKey }
    );

    // 规则：授权入口页域名与回调页域名必须一致，并且与第三方平台配置的“登录授权的发起页域名”一致。
    // mockMode 下优先使用配置域名，避免本地端口 origin 干扰。
    const normalizePublicBaseUrl = (raw) => {
      let v = String(raw || '').trim();
      if (!v) return '';
      if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
      try {
        const u = new URL(v);
        return u.origin;
      } catch (e) {
        return v.replace(/\/$/, '');
      }
    };

    const publicBaseUrlConfig = normalizePublicBaseUrl(this.wechatConfig.publicBaseUrl);
    const requestOrigin = normalizePublicBaseUrl(ctx.origin);

    const publicBaseUrl = this.mockMode
      ? (publicBaseUrlConfig || requestOrigin)
      : (requestOrigin || publicBaseUrlConfig);

    this.logStep(
      'COMPONENT_AUTH_URL_2_BASE_URL',
      { publicBaseUrlResolved: true },
      {
        requestOrigin,
        configPublicBaseUrl: publicBaseUrlConfig,
        isMockMode: this.mockMode,
        publicBaseUrl,
      }
    );

    if (!publicBaseUrl) {
      ctx.throw(500, 'Failed to determine publicBaseUrl (wechat.publicBaseUrl / request origin)');
    }

    const callbackUrl = `${publicBaseUrl}/api/v1/wechat/component/auth_callback?${encodeURIComponent(tenantKey)}=${encodeURIComponent(tenantId)}`;

    this.logStep(
      'COMPONENT_AUTH_URL_3_CALLBACK',
      { callbackUrlNonEmpty: true },
      { callbackUrlSample: safeSlice(callbackUrl, 180) }
    );

    const urls = await ctx.service.wechat.component.getAuthUrl(callbackUrl, 3);

    const pcUrl = typeof urls === 'string' ? urls : (urls?.pc || urls?.url);
    const mobileUrl = typeof urls === 'string' ? undefined : (urls?.mobile || urls?.mobileUrl);
    const finalUrl = pcUrl || mobileUrl;

    this.logStep(
      'COMPONENT_AUTH_URL_4_RESULT',
      { finalUrlNonEmpty: true, shouldContainOpenWeixin: true },
      {
        finalUrlNonEmpty: Boolean(finalUrl),
        containsOpenWeixin: finalUrl ? String(finalUrl).includes('open.weixin.qq.com') : false,
        finalUrlMasked: finalUrl ? String(finalUrl).replace(/([?&]pre_auth_code=)([^&]+)/, '$1***') : '',
        urlsType: typeof urls,
      }
    );

    if (!finalUrl) {
      ctx.throw(500, 'Failed to generate auth url: empty url');
    }

    return { url: finalUrl, mobileUrl };
  }

  async authCallback() {
    const { ctx } = this;
    const { auth_code } = ctx.query;
    const tenantId = this._resolveTenantIdFromRequest();
    const tenantKey = this._getTenantIdParamName();

    if (!auth_code || !tenantId) {
      ctx.throw(400, `Missing auth_code or ${tenantKey}`);
    }

    this.logStep(
      'COMPONENT_AUTH_CALLBACK_1_INPUT',
      { authCodePresent: true, daoIdPresent: true },
      {
        authCodePresent: Boolean(auth_code),
        daoIdPresent: Boolean(tenantId),
        daoId: tenantId,
        tenantKey,
        authCodeMasked: auth_code ? String(auth_code).slice(0, 8) + '***' : '',
      }
    );

    try {
      if (ctx.service?.third?.wechatPlatform && typeof ctx.service.third.wechatPlatform.handleAuthCallback === 'function') {
        await ctx.service.third.wechatPlatform.handleAuthCallback(auth_code, tenantId);
      } else {
        ctx.throw(500, 'Missing host handler: ctx.service.third.wechatPlatform.handleAuthCallback');
      }

      this.logStep(
        'COMPONENT_AUTH_CALLBACK_2_HANDLE',
        { handleSuccess: true },
        { handleSuccess: true }
      );

      ctx.set('Content-Type', 'text/html; charset=utf-8');
      ctx.body = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>微信授权成功</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;padding:24px;background:#f7f8fa;}
    .card{max-width:520px;margin:48px auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 4px 14px rgba(0,0,0,.06);}
    h1{font-size:18px;margin:0 0 12px;}
    p{margin:0;color:#666;line-height:1.6;}
    .ok{color:#1a7f37;font-weight:600;}
  </style>
</head>
<body>
  <div class="card">
    <h1 class="ok">授权成功</h1>
    <p>你可以关闭本页面，返回管理后台继续操作。</p>
  </div>
  <script>
    try {
      window.opener && window.opener.postMessage('wechat_auth_success', '*');
    } catch (e) {}
    try {
      window.parent && window.parent.postMessage('wechat_auth_success', '*');
    } catch (e) {}
    setTimeout(function(){ try{ window.close(); } catch(e){} }, 200);
  </script>
</body>
</html>`;
    } catch (err) {
      this.logStep(
        'COMPONENT_AUTH_CALLBACK_999_ERROR',
        { ok: true },
        { ok: false, message: err?.message }
      );

      ctx.set('Content-Type', 'text/html; charset=utf-8');
      const msg = String(err?.message || '授权失败');
      ctx.body = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>微信授权失败</title>
</head>
<body>
  <p>授权失败：${msg.replace(/</g, '&lt;')}</p>
</body>
</html>`;
    }
  }

  async mockAuthorize() {
    const { ctx } = this;

    if (!this.mockMode) {
      ctx.throw(404);
    }

    const { redirect_uri, auth_type } = ctx.query;

    this.logStep(
      'COMPONENT_MOCK_AUTHORIZE_1_INPUT',
      { redirectUriPresent: true },
      {
        redirectUriPresent: Boolean(redirect_uri),
        redirectUriSample: redirect_uri ? safeSlice(redirect_uri, 180) : undefined,
        authType: auth_type,
      }
    );

    if (!redirect_uri) {
      ctx.throw(400, 'Missing redirect_uri');
    }

    let target = null;
    try {
      const u = new URL(String(redirect_uri));
      const allowedHostsRaw = this.wechatConfig.mockAuthorizeAllowedHosts;
      const allowedHosts = new Set(
        String(allowedHostsRaw || '')
          .split(',')
          .map(s => s.trim().toLowerCase())
          .filter(Boolean)
      );

      if (allowedHosts.size === 0) {
        // 默认：仅允许当前 Host（更安全）
        const host = String(ctx.host || '').trim().toLowerCase();
        if (host) allowedHosts.add(host);
      }

      const redirectHost = String(u.hostname || '').trim().toLowerCase();
      if (!allowedHosts.has(redirectHost)) {
        ctx.throw(400, 'Invalid redirect_uri_host');
      }

      if (![ 'http:', 'https:' ].includes(String(u.protocol || '').toLowerCase())) {
        ctx.throw(400, 'Invalid redirect_uri_protocol');
      }

      if (u.pathname !== '/api/v1/wechat/component/auth_callback') {
        ctx.throw(400, 'Invalid redirect_uri path');
      }

      const authCode = `mock_auth_code_${Date.now()}`;
      u.searchParams.set('auth_code', authCode);
      u.searchParams.set('expires_in', '3600');
      if (auth_type) u.searchParams.set('auth_type', auth_type);

      // 使用相对路径重定向，避免 egg-security safe_redirect 拦截绝对 URL
      target = `${u.pathname}?${u.searchParams.toString()}`;

      this.logStep(
        'COMPONENT_MOCK_AUTHORIZE_2_REDIRECT',
        { ok: true },
        { ok: true, targetSample: safeSlice(target, 180), authCodeMasked: authCode.slice(0, 8) + '***' }
      );
    } catch (e) {
      ctx.throw(400, 'Invalid redirect_uri');
    }

    ctx.redirect(target);
  }

  async callback() {
    const { ctx } = this;

    await this._ensureComponentCryptoConfig();

    const componentToken = String(this.wechatConfig.componentToken || '').trim();
    const componentEncodingAESKey = String(this.wechatConfig.componentEncodingAESKey || '').trim();
    const componentAppId = String(this.wechatConfig.componentAppId || '').trim();

    const { appid } = ctx.params;
    const { msg_signature, signature, timestamp, nonce, echostr } = ctx.query;
    let encryptType = String(ctx.query.encrypt_type || '').toLowerCase();

    if (ctx.method === 'GET') {
      try {
        if (!echostr) {
          ctx.body = '';
          return;
        }

        const isEncrypted = encryptType === 'aes' || !!msg_signature;
        if (isEncrypted) {
          const cryptor = new WXBizMsgCrypt(componentToken, componentEncodingAESKey, componentAppId);
          if (msg_signature && timestamp && nonce) {
            const expected = cryptor.getSignature(timestamp, nonce, echostr);
            if (expected !== msg_signature) {
              ctx.logger.error('WeChat Callback VerifyURL signature mismatch (aes mode)', { appid, expected, msg_signature });
              ctx.status = 403;
              ctx.body = '';
              return;
            }
          }

          const decrypted = cryptor.decrypt(echostr);
          ctx.body = decrypted.message;
          return;
        }

        if (signature && timestamp && nonce) {
          const expected = calcPlainSignature(componentToken, timestamp, nonce);
          if (expected !== signature) {
            ctx.logger.error('WeChat Callback VerifyURL signature mismatch (raw mode)', { appid, expected, signature });
            ctx.status = 403;
            ctx.body = '';
            return;
          }
        }

        ctx.body = echostr;
        return;
      } catch (err) {
        ctx.logger.error(`WeChat Callback VerifyURL Error for ${appid}`, err);
        ctx.status = 500;
        ctx.body = '';
        return;
      }
    }

    // ===== POST：消息/事件回调 =====

    const xml = getRawXmlBody(ctx);

    try {
      const cryptor = new WXBizMsgCrypt(componentToken, componentEncodingAESKey, componentAppId);

      const sendReplyXml = replyXml => {
        ctx.set('Content-Type', 'application/xml');
        ctx.body = replyXml;
      };

      const sendEncryptedReply = replyXml => {
        const ts = String(Math.floor(Date.now() / 1000));
        const nonceToSend = crypto.randomBytes(8).toString('hex');
        const encrypted = cryptor.encrypt(replyXml);
        const signatureToSend = cryptor.getSignature(ts, nonceToSend, encrypted);

        const wrappedXml = `<xml>
<Encrypt><![CDATA[${encrypted}]]></Encrypt>
<MsgSignature><![CDATA[${signatureToSend}]]></MsgSignature>
<TimeStamp>${ts}</TimeStamp>
<Nonce><![CDATA[${nonceToSend}]]></Nonce>
</xml>`;

        sendReplyXml(wrappedXml.trim());
      };

      const parseIncomingPlainMessage = async () => {
        if (ctx.request.body && typeof ctx.request.body === 'object') {
          const maybeXml = ctx.request.body.xml || ctx.request.body;
          if (maybeXml && (maybeXml.MsgType || maybeXml.ToUserName || maybeXml.FromUserName)) return maybeXml;
        }
        return this._parseXml(xml);
      };

      let encrypt = this._getEncryptFromBody();
      if (!encrypt) {
        const parsed = this._parseXml(xml);
        encrypt = parsed?.Encrypt;
      }

      if (!encryptType && encrypt) encryptType = 'aes';
      const isEncrypted = encryptType === 'aes';

      let msg = null;
      if (isEncrypted) {
        if (!encrypt) {
          ctx.logger.error('WeChat Callback missing Encrypt field (aes mode)', {
            appid,
            contentType: ctx.get('Content-Type'),
            query: ctx.query,
            bodyType: typeof ctx.request.body,
          });
          ctx.status = 400;
          ctx.body = '';
          return;
        }

        if (msg_signature && timestamp && nonce) {
          const expected = cryptor.getSignature(timestamp, nonce, encrypt);
          if (expected !== msg_signature) {
            ctx.logger.error('WeChat Callback signature mismatch (aes mode)', { appid, expected, msg_signature });
            ctx.status = 403;
            ctx.body = '';
            return;
          }
        }

        const decrypted = cryptor.decrypt(encrypt);
        msg = this._parseXml(decrypted.message);
      } else {
        if (signature && timestamp && nonce) {
          const expected = calcPlainSignature(componentToken, timestamp, nonce);
          if (expected !== signature) {
            ctx.logger.error('WeChat Callback signature mismatch (raw mode)', { appid, expected, signature });
            ctx.status = 403;
            ctx.body = '';
            return;
          }
        }

        msg = await parseIncomingPlainMessage();
      }

      ctx.logger.info(`Received Callback for ${appid}:`, msg);

      if (!msg) {
        ctx.body = 'success';
        return;
      }

      // 可选：宿主的媒体安全检测回调
      if (
        msg.MsgType === 'event' &&
        String(msg.Event || '').toLowerCase() === 'wxa_media_check' &&
        ctx.service?.ai?.review &&
        typeof ctx.service.ai.review.handleWechatMediaCheckCallback === 'function'
      ) {
        await ctx.service.ai.review.handleWechatMediaCheckCallback(appid, msg);
        ctx.body = 'success';
        return;
      }

      const buildReplyXml = (reply, incoming) => {
        if (!reply || !incoming) return null;

        const toUser = incoming.FromUserName;
        const fromUser = incoming.ToUserName;
        const createTime = Math.floor(Date.now() / 1000);

        if (reply.type === 'text') {
          return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${createTime}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${reply.content || ''}]]></Content>
</xml>`;
        }

        if (reply.type === 'image') {
          return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${createTime}</CreateTime>
<MsgType><![CDATA[image]]></MsgType>
<Image><MediaId><![CDATA[${reply.mediaId || ''}]]></MediaId></Image>
</xml>`;
        }

        if (reply.type === 'news') {
          const articles = Array.isArray(reply.content) ? reply.content : [];
          const itemsXml = articles.map(a => `<item>
<Title><![CDATA[${a.title || ''}]]></Title>
<Description><![CDATA[${a.description || ''}]]></Description>
<PicUrl><![CDATA[${a.picUrl || ''}]]></PicUrl>
<Url><![CDATA[${a.url || ''}]]></Url>
</item>`).join('\n');

          return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${createTime}</CreateTime>
<MsgType><![CDATA[news]]></MsgType>
<ArticleCount>${articles.length}</ArticleCount>
<Articles>
${itemsXml}
</Articles>
</xml>`;
        }

        return null;
      };

      // 全网发布自动化测试专用逻辑
      if (msg.MsgType === 'text') {
        if (msg.Content === 'TESTCOMPONENT_MSG_TYPE_TEXT') {
          const replyContent = 'TESTCOMPONENT_MSG_TYPE_TEXT_callback';
          const replyXml = `<xml>
<ToUserName><![CDATA[${msg.FromUserName}]]></ToUserName>
<FromUserName><![CDATA[${msg.ToUserName}]]></FromUserName>
<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${replyContent}]]></Content>
</xml>`;

          if (isEncrypted) {
            sendEncryptedReply(replyXml);
          } else {
            sendReplyXml(replyXml);
          }
          return;
        }

        if (typeof msg.Content === 'string' && msg.Content.startsWith('QUERY_AUTH_CODE:')) {
          const queryAuthCode = msg.Content.replace('QUERY_AUTH_CODE:', '');
          ctx.body = '';

          ctx.runInBackground(async () => {
            try {
              if (ctx.service?.third?.wechatPlatform && typeof ctx.service.third.wechatPlatform.handleTestAuthCode === 'function') {
                await ctx.service.third.wechatPlatform.handleTestAuthCode(queryAuthCode, msg.FromUserName);
              }
            } catch (e) {
              ctx.logger.error('Handle Test Auth Code Error:', e);
            }
          });
          return;
        }
      }

      // 非全网发布测试消息：交给宿主的消息处理 service（若不存在则直接 success）
      if (ctx.service?.third?.wechatMessage && typeof ctx.service.third.wechatMessage.handleMessage === 'function') {
        const reply = await ctx.service.third.wechatMessage.handleMessage(appid, msg);
        const replyXml = buildReplyXml(reply, msg);
        if (replyXml) {
          if (isEncrypted) {
            sendEncryptedReply(replyXml);
          } else {
            sendReplyXml(replyXml);
          }
          return;
        }
      }

      ctx.body = 'success';
    } catch (err) {
      ctx.logger.error('Callback Error:', err);
      ctx.body = 'success';
    }
  }
}

module.exports = WechatPlatformHttpService;
