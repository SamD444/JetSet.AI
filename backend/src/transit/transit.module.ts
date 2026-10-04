import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { TransitService } from './transit.service';
import { TransitController } from './transit.controller';

@Module({
  imports: [HttpModule, ConfigModule],
  providers: [TransitService],
  controllers: [TransitController],
  exports: [TransitService],
})
export class TransitModule {}
