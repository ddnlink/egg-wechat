'use strict';

const Service = require('egg').Service;

class ThirdWechatPlatformService extends Service {
  async handleAuthCallback(authCode, tenantId) {
    this.app._testAuthCallbackArgs = { authCode, tenantId };
  }
}

module.exports = ThirdWechatPlatformService;
