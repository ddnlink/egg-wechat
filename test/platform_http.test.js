'use strict';

const mock = require('egg-mock');
const assert = require('assert');
const WXBizMsgCrypt = require('wechat-crypto');

describe('test/platform_http.test.js', () => {
  let app;

  before(() => {
    app = mock.app({
      baseDir: 'apps/mp-test',
    });
    return app.ready();
  });

  after(() => app.close());
  afterEach(mock.restore);

  it('should handle encrypted component_verify_ticket notify and save ticket', async () => {
    const componentToken = 'test_component_token';
    const componentEncodingAESKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'; // 43 chars
    const componentAppId = 'wx1234567890abcdef';

    app.config.wechat = Object.assign({}, app.config.wechat || {}, {
      componentToken,
      componentEncodingAESKey,
      componentAppId,
    });

    const ctx = app.mockContext();

    const cryptor = new WXBizMsgCrypt(componentToken, componentEncodingAESKey, componentAppId);
    const plainXml = `<xml>
<AppId><![CDATA[${componentAppId}]]></AppId>
<CreateTime>1734480000</CreateTime>
<InfoType><![CDATA[component_verify_ticket]]></InfoType>
<ComponentVerifyTicket><![CDATA[ticket_test_123]]></ComponentVerifyTicket>
</xml>`;

    const encrypt = cryptor.encrypt(plainXml);
    const timestamp = '1734480001';
    const nonce = 'nonce_notify_123';
    const msgSignature = cryptor.getSignature(timestamp, nonce, encrypt);

    const requestXml = `<xml>
<Encrypt><![CDATA[${encrypt}]]></Encrypt>
<ToUserName><![CDATA[${componentAppId}]]></ToUserName>
</xml>`;

    ctx.query = {
      msg_signature: msgSignature,
      timestamp,
      nonce,
    };
    ctx.request.body = requestXml;
    ctx.request.rawBody = requestXml;

    let savedTicket = null;
    app.mockService('wechat.component', 'saveComponentVerifyTicket', async ticket => {
      savedTicket = ticket;
    });

    await ctx.service.wechat.platformHttp.notify();
    assert.strictEqual(ctx.body, 'success');
    assert.strictEqual(savedTicket, 'ticket_test_123');
  });

  it('should generate auth callback url with configured tenantIdParamName', async () => {
    app.config.wechat = Object.assign({}, app.config.wechat || {}, {
      tenantIdParamName: 'tenantId',
      publicBaseUrl: 'https://public.example.com',
    });

    const ctx = app.mockContext();
    ctx.query = { tenantId: 'tenant_001' };

    let capturedCallbackUrl = null;
    app.mockService('wechat.component', 'getAuthUrl', async (callbackUrl) => {
      capturedCallbackUrl = callbackUrl;
      return { pc: 'https://open.weixin.qq.com/cgi-bin/componentloginpage?pre_auth_code=pre_auth_code_test' };
    });

    const { url } = await ctx.service.wechat.platformHttp.getAuthUrl();
    assert.ok(url && url.includes('open.weixin.qq.com'));

    const u = new URL(capturedCallbackUrl);
    assert.ok([
      '/api/v1/wechat/component/auth_callback',
      '/v1/wechat/component/auth_callback',
    ].includes(u.pathname));
    assert.strictEqual(u.searchParams.get('tenantId'), 'tenant_001');
  });

  it('should resolve tenantId from query and pass to host handleAuthCallback', async () => {
    app.config.wechat = Object.assign({}, app.config.wechat || {}, {
      tenantIdParamName: 'tenantId',
      tenantIdQueryKeys: [ 'tenantId' ],
    });

    const ctx = app.mockContext();
    ctx.query = { auth_code: 'auth_code_123', tenantId: 'tenant_002' };

    app._testAuthCallbackArgs = null;
    await ctx.service.wechat.platformHttp.authCallback();

    assert.deepStrictEqual(app._testAuthCallbackArgs, { authCode: 'auth_code_123', tenantId: 'tenant_002' });
    assert.ok(String(ctx.body || '').includes('授权成功'));
  });
});
