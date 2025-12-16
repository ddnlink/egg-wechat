'use strict';

const Service = require('egg').Service;

const MSG_SEC_CHECK_URL = 'https://api.weixin.qq.com/wxa/msg_sec_check';
const MEDIA_CHECK_ASYNC_URL = 'https://api.weixin.qq.com/wxa/media_check_async';

class SecurityService extends Service {

  async _getAccessToken(providedAccessToken) {
    if (providedAccessToken) return providedAccessToken;

    const tokenRes = await this.ctx.service.wechat.mp.getToken();
    const accessToken = tokenRes && tokenRes.access_token;
    if (!accessToken) {
      const errMsg = tokenRes && tokenRes.errmsg ? tokenRes.errmsg : 'missing access_token';
      throw new Error(`wechat getToken failed: ${errMsg}`);
    }
    return accessToken;
  }

  /**
   * 文本内容安全识别（2.0）
   * @param {Object} params
   * @param {string} params.content 需检测的文本内容（<=2500字）
   * @param {number} params.version 固定为 2
   * @param {number} params.scene 场景（1资料；2评论；3论坛；4社交日志）
   * @param {string} params.openid 用户 openid（近两小时访问过小程序）
   * @param {string} [params.title] 文本标题
   * @param {string} [params.nickname] 用户昵称
   * @param {string} [params.signature] 个性签名（仅 scene=1）
   * @param {Object} [options]
   * @param {string} [options.accessToken] access_token 或 authorizer_access_token
   */
  async msgSecCheck(params, options = {}) {
    const {
      content,
      openid,
      version = 2,
      scene = 2,
      title,
      nickname,
      signature,
    } = params || {};

    if (!content || typeof content !== 'string') throw new Error('content is required');
    if (!openid || typeof openid !== 'string') throw new Error('openid is required');

    const accessToken = await this._getAccessToken(options.accessToken);

    const data = {
      content,
      version,
      scene,
      openid,
    };
    if (title) data.title = title;
    if (nickname) data.nickname = nickname;
    if (signature) data.signature = signature;

    const res = await this.ctx.curl(`${MSG_SEC_CHECK_URL}?access_token=${accessToken}`, {
      method: 'POST',
      contentType: 'json',
      dataType: 'json',
      data,
    });

    return res.data;
  }

  /**
   * 多媒体内容安全识别（异步，2.0）
   * @param {Object} params
   * @param {string} params.mediaUrl 要检测的媒体 URL
   * @param {number} params.mediaType 1:音频 2:图片
   * @param {number} params.version 固定为 2
   * @param {number} params.scene 场景（1资料；2评论；3论坛；4社交日志）
   * @param {string} params.openid 用户 openid（近两小时访问过小程序）
   * @param {Object} [options]
   * @param {string} [options.accessToken] access_token 或 authorizer_access_token
   */
  async mediaCheckAsync(params, options = {}) {
    const {
      mediaUrl,
      mediaType,
      openid,
      version = 2,
      scene = 2,
    } = params || {};

    if (!mediaUrl || typeof mediaUrl !== 'string') throw new Error('mediaUrl is required');
    if (mediaType !== 1 && mediaType !== 2) throw new Error('mediaType must be 1 or 2');
    if (!openid || typeof openid !== 'string') throw new Error('openid is required');

    const accessToken = await this._getAccessToken(options.accessToken);

    const res = await this.ctx.curl(`${MEDIA_CHECK_ASYNC_URL}?access_token=${accessToken}`, {
      method: 'POST',
      contentType: 'json',
      dataType: 'json',
      data: {
        media_url: mediaUrl,
        media_type: mediaType,
        version,
        scene,
        openid,
      },
    });

    return res.data;
  }
}

module.exports = SecurityService;
