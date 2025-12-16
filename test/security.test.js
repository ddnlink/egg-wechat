'use strict';

const mock = require('egg-mock');
const assert = require('assert');

describe('test/security.test.js', () => {
  let app;

  before(() => {
    app = mock.app({
      baseDir: 'apps/mp-test',
    });
    return app.ready();
  });

  after(() => app.close());
  afterEach(mock.restore);

  it('should call msgSecCheck with v2 params', async () => {
    const ctx = app.mockContext();

    app.mockService('wechat.mp', 'getToken', async () => {
      return { access_token: 'mock_access_token' };
    });

    let captured;
    mock(ctx, 'curl', async (url, options) => {
      captured = { url, options };
      return {
        data: {
          errcode: 0,
          errmsg: 'ok',
          result: { suggest: 'pass', label: 100 },
          trace_id: 'trace',
          detail: [],
        },
      };
    });

    const res = await ctx.service.wechat.security.msgSecCheck({
      openid: 'OPENID',
      scene: 2,
      version: 2,
      content: 'hello world',
      title: 't',
      nickname: 'n',
      signature: 's',
    });

    assert(res && res.errcode === 0);
    assert(captured.url.includes('https://api.weixin.qq.com/wxa/msg_sec_check?access_token=mock_access_token'));
    assert(captured.options.method === 'POST');
    assert(captured.options.contentType === 'json');
    assert(captured.options.dataType === 'json');
    assert.deepStrictEqual(captured.options.data, {
      openid: 'OPENID',
      scene: 2,
      version: 2,
      content: 'hello world',
      title: 't',
      nickname: 'n',
      signature: 's',
    });
  });

  it('should call mediaCheckAsync with snake_case body', async () => {
    const ctx = app.mockContext();

    app.mockService('wechat.mp', 'getToken', async () => {
      return { access_token: 'mock_access_token' };
    });

    let captured;
    mock(ctx, 'curl', async (url, options) => {
      captured = { url, options };
      return {
        data: {
          errcode: 0,
          errmsg: 'ok',
          trace_id: 'trace_media',
        },
      };
    });

    const res = await ctx.service.wechat.security.mediaCheckAsync({
      openid: 'OPENID',
      scene: 3,
      version: 2,
      mediaUrl: 'https://example.com/a.png',
      mediaType: 2,
    });

    assert(res && res.trace_id === 'trace_media');
    assert(captured.url.includes('https://api.weixin.qq.com/wxa/media_check_async?access_token=mock_access_token'));
    assert.deepStrictEqual(captured.options.data, {
      media_url: 'https://example.com/a.png',
      media_type: 2,
      version: 2,
      scene: 3,
      openid: 'OPENID',
    });
  });

});
