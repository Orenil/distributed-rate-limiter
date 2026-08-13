import { Module } from '@nestjs/common';
import { RateLimitModule } from './rate-limit.module';

@Module({
  imports: [RateLimitModule],
})
export class AppModule {}
