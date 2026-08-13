import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Post } from '@nestjs/common';
import { ConfigStore } from '../core/config-store';
import { RateLimiter } from '../core/limiter';
import { CheckRequest, RouteConfig } from '../core/types';
import { CONFIG_STORE, RATE_LIMITER } from './tokens';

/** POST /v1/check body. */
interface CheckBody {
  route?: string;
  key?: string;
  tenant?: string;
}

function assertCheckBody(body: CheckBody): asserts body is CheckRequest {
  if (!body.route || !body.key || !body.tenant) {
    throw new BadRequestException('route, key, and tenant are all required');
  }
}

/**
 * The sidecar's HTTP surface: a rate-limit decision endpoint plus a hot-reload config
 * endpoint (no redeploy needed to change a limit — see ConfigStore).
 */
@Controller('v1')
export class RateLimitController {
  constructor(
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CONFIG_STORE) private readonly config: ConfigStore,
  ) {}

  @Post('check')
  async check(@Body() body: CheckBody) {
    assertCheckBody(body);
    if (!this.config.getRoute(body.route)) {
      throw new NotFoundException(`No rate-limit configuration for route "${body.route}"`);
    }
    return this.limiter.check(body);
  }

  @Get('config')
  listConfig() {
    return this.config.listRoutes();
  }

  /** Hot-reload a route's limits/fail-mode without restarting the process. */
  @Post('config')
  updateConfig(@Body() body: RouteConfig) {
    if (!body.route || !Array.isArray(body.limits) || !body.failMode) {
      throw new BadRequestException('route, limits[], and failMode are required');
    }
    this.config.updateRoute(body);
    return { ok: true, route: this.config.getRoute(body.route) };
  }
}
