import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { RuralStaysService } from './rural-stays.service';
import { RuralStaysController } from './rural-stays.controller';

@Module({
  imports: [HttpModule, ConfigModule],
  providers: [RuralStaysService],
  controllers: [RuralStaysController],
  exports: [RuralStaysService],
})
export class RuralStaysModule {}
