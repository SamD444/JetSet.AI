import {
  Controller,
  Get,
  Query,
  Res,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { TransitService } from './transit.service';

@Controller('transit')
export class TransitController {
  constructor(private readonly transitService: TransitService) {}

  /**
   * GET /transit/options?source=Delhi&destination=Jaipur&date=2026-12-25&srcCode=NDLS&destCode=JP
   * Get all available transit options (train, bus, multimodal) for a route.
   */
  @Get('options')
  getTransitOptions(
    @Query('source') source: string,
    @Query('destination') destination: string,
    @Query('date') date: string,
    @Query('srcCode') srcCode?: string,
    @Query('destCode') destCode?: string,
  ) {
    if (!source || !destination || !date) {
      throw new HttpException(
        'source, destination, and date query parameters are required',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Auto-resolve station codes if not provided
    const resolvedSrc = srcCode || this.transitService.resolveStationCode(source);
    const resolvedDest = destCode || this.transitService.resolveStationCode(destination);

    const options = this.transitService.getTransitOptions(
      source,
      destination,
      date,
      resolvedSrc || undefined,
      resolvedDest || undefined,
    );

    return {
      source,
      destination,
      date,
      stationCodes: {
        source: resolvedSrc || 'not_found',
        destination: resolvedDest || 'not_found',
      },
      options,
    };
  }

  /**
   * GET /transit/redirect?partner=makemytrip&type=train&tripId=abc&source=NDLS&destination=JP&date=20261225
   * Logs the click, then issues an HTTP 302 redirect to the booking partner.
   */
  @Get('redirect')
  async redirect(
    @Query('partner') partner: string,
    @Query('type') type: string,
    @Query('tripId') tripId: string,
    @Query('source') source: string,
    @Query('destination') destination: string,
    @Query('date') date: string,
    @Res() res: Response,
  ) {
    if (!partner || !type || !source || !destination) {
      throw new HttpException(
        'partner, type, source, and destination are required',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const redirectUrl = await this.transitService.logAndRedirect(
        partner,
        type,
        tripId || 'anonymous',
        source,
        destination,
        date || '',
      );

      return res.redirect(302, redirectUrl);
    } catch (err: any) {
      throw new HttpException(
        `Redirect failed: ${err.message}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * GET /transit/resolve-station?city=Bhubaneswar
   * Resolve a city name to its Indian Railways station code.
   */
  @Get('resolve-station')
  resolveStation(@Query('city') city: string) {
    if (!city) {
      throw new HttpException('city query parameter is required', HttpStatus.BAD_REQUEST);
    }

    const code = this.transitService.resolveStationCode(city);

    return {
      city,
      stationCode: code,
      found: !!code,
    };
  }

  /**
   * GET /transit/analytics?tripId=abc
   * Get click analytics for a trip's transit redirects.
   */
  @Get('analytics')
  async getAnalytics(@Query('tripId') tripId: string) {
    if (!tripId) {
      throw new HttpException('tripId is required', HttpStatus.BAD_REQUEST);
    }

    const analytics = await this.transitService.getClickAnalytics(tripId);
    return { tripId, analytics };
  }
}
