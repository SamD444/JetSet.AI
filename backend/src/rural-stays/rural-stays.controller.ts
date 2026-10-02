import { Controller, Get, Query, HttpException, HttpStatus } from '@nestjs/common';
import { RuralStaysService } from './rural-stays.service';

@Controller('rural-stays')
export class RuralStaysController {
  constructor(private readonly ruralStaysService: RuralStaysService) {}

  /**
   * GET /rural-stays/discover?lat=27.18&lon=78.02&radius=15&priceBand=budget&date=2026-12-25
   * Discover rural stays near coordinates using Overpass + DB.
   */
  @Get('discover')
  async discover(
    @Query('q') q?: string,
    @Query('lat') lat?: string,
    @Query('lon') lon?: string,
    @Query('radius') radius?: string,
    @Query('priceBand') priceBand?: string,
    @Query('date') date?: string,
  ) {
    let latNum = lat ? parseFloat(lat) : NaN;
    let lonNum = lon ? parseFloat(lon) : NaN;

    if (q) {
      const coords = await this.ruralStaysService.geocode(q);
      if (coords) {
        latNum = coords.lat;
        lonNum = coords.lon;
      }
    }

    if (isNaN(latNum) || isNaN(lonNum)) {
      throw new HttpException(
        'Valid lat/lon or a resolvable location q is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const radiusKm = radius ? parseFloat(radius) : 15;
    const stays = await this.ruralStaysService.discoverStays(latNum, lonNum, radiusKm, priceBand);

    // Enrich each stay with WhatsApp deep links
    const enriched = stays.map(stay =>
      this.ruralStaysService.enrichStayWithLinks(stay, date),
    );

    return {
      count: enriched.length,
      radiusKm,
      center: { lat: latNum, lon: lonNum },
      priceBand: priceBand || 'all',
      stays: enriched,
    };
  }

  /**
   * GET /rural-stays/search?state=Rajasthan&district=Jaisalmer&priceBand=budget
   * Search rural stays by region name.
   */
  @Get('search')
  async searchByRegion(
    @Query('state') state: string,
    @Query('district') district?: string,
    @Query('priceBand') priceBand?: string,
  ) {
    if (!state) {
      throw new HttpException('state query parameter is required', HttpStatus.BAD_REQUEST);
    }

    const stays = await this.ruralStaysService.searchByRegion(state, district, priceBand);

    return {
      count: stays.length,
      region: { state, district: district || 'all' },
      priceBand: priceBand || 'all',
      stays,
    };
  }

  /**
   * GET /rural-stays/whatsapp-link?phone=919876543210&village=Mandawa&date=2026-12-25
   * Generate a WhatsApp deep link for a host.
   */
  @Get('whatsapp-link')
  generateWhatsAppLink(
    @Query('phone') phone: string,
    @Query('village') village: string,
    @Query('date') date?: string,
  ) {
    if (!phone || !village) {
      throw new HttpException(
        'phone and village query parameters are required',
        HttpStatus.BAD_REQUEST,
      );
    }

    return {
      link: this.ruralStaysService.generateWhatsAppLink(phone, village, date),
    };
  }
}
