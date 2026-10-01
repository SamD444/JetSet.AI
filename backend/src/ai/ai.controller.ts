import { Controller, Get, Post, Query, Body, Res, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AiService } from './ai.service';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get('summary')
  async getSummary(@Query('tripId') tripId: string, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    await this.aiService.getSummaryStream(
      tripId,
      (chunk) => {
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      },
      () => {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    );
  }

  @Post('chat')
  async getChat(
    @Body() body: { tripId: string; messages: { role: 'user' | 'model'; content: string }[], context?: string },
    @Res() res: Response
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let parsedContext: any = {};
    try {
      if (body.context) parsedContext = JSON.parse(body.context);
    } catch {}

    await this.aiService.getChatStream(
      body.tripId,
      body.messages || [],
      parsedContext,
      (chunk) => {
        if (chunk.startsWith('__JSON__:')) {
          res.write(`data: ${chunk.substring(9)}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
        }
      },
      () => {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    );
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadDocument(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded.');
    }
    return this.aiService.processTravelDocument(file);
  }
}
