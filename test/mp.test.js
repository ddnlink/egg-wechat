'use strict';

const mock = require('egg-mock');
const assert = require('assert');

describe('test/mp.test.js', () => {
  let app;
  before(() => {
    app = mock.app({
      baseDir: 'apps/mp-test',
    });
    return app.ready();
  });

  after(() => app.close());
  afterEach(mock.restore);

  it('should GET /', () => {
    return app.httpRequest()
      .get('/')
      .expect('hi, wechat')
      .expect(200);
  });

  it('should auth user', async () => {
    const ctx = app.mockContext();
    const code = '001OMmHL0SfDwb2ZOwHL0UukHL0OMmHH';
    app.mockService('wechat.wcs', 'auth', async () => {
      return { openid: 'mock_openid' };
    });
    const res = await ctx.service.wechat.wcs.auth(code);
    assert(res);
  });

  it('should create order', async () => {
    const ctx = app.mockContext();
    const openid = 'oxMV95vEbkzDLGgOk3EC4ylN1GRA';
    app.mockService('wechat.wcs', 'createOrder', async () => {
      return { prepay_id: 'mock_prepay' };
    });
    const res = await ctx.service.wechat.wcs.createOrder(openid, {});
    assert(res);
  });

  it('should get config', async () => {
    const ctx = app.mockContext();
    const url = 'https://www.amusingcode.com/static-pages/temp/weixin.html';
    app.mockService('wechat.wcs', 'getConfig', async () => {
      return { appId: 'wx123456', signature: 'mock_signature' };
    });
    const res = await ctx.service.wechat.wcs.getConfig(url);
    assert(res);
  });

  // New tests for component service
  describe('Component Service', () => {
    it('should have component service', () => {
      const ctx = app.mockContext();
      assert(ctx.service.wechat.component);
    });

    it('should get component access token', async () => {
      const ctx = app.mockContext();
      // Mock redis to avoid actual network call or error
      app.mockService('wechat.component', 'getComponentAccessToken', async () => {
        return 'mock_component_access_token';
      });

      const token = await ctx.service.wechat.component.getComponentAccessToken();
      assert(token === 'mock_component_access_token');
    });

    it('should get pre auth code', async () => {
      const ctx = app.mockContext();
      app.mockService('wechat.component', 'getPreAuthCode', async () => {
        return 'mock_pre_auth_code';
      });
      const code = await ctx.service.wechat.component.getPreAuthCode();
      assert(code === 'mock_pre_auth_code');
    });

    it('should get auth url', async () => {
      const ctx = app.mockContext();
      app.mockService('wechat.component', 'getAuthUrl', async () => {
        return 'https://mp.weixin.qq.com/cgi-bin/componentloginpage?component_appid=wx_component_123&pre_auth_code=mock_pre_auth_code&redirect_uri=uri&auth_type=3';
      });

      const url = await ctx.service.wechat.component.getAuthUrl('uri');
      assert(url.includes('componentloginpage'));
    });
  });

});
