import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface TransitRedirectLog {
  id?: number;
  trip_id: string;
  partner: string; // 'makemytrip', 'redbus', 'rome2rio'
  type: string; // 'train', 'bus', 'multimodal'
  source: string;
  destination: string;
  date: string;
  redirect_url: string;
  clicked_at?: Date;
}

export interface MultiModalRoute {
  segments: RouteSegment[];
  totalDuration?: string;
  totalPrice?: { min: number; max: number; currency: string };
}

export interface RouteSegment {
  mode: 'train' | 'bus' | 'auto' | 'walk' | 'ferry' | 'flight';
  from: string;
  to: string;
  operator?: string;
  duration?: string;
  price?: { min: number; max: number; currency: string };
  bookingUrl?: string;
}

@Injectable()
export class TransitService implements OnModuleInit {
  private readonly logger = new Logger(TransitService.name);

  constructor(
    @Inject('DATABASE_POOL') private readonly pool: any,
    private readonly httpService: HttpService,
  ) {}

  async onModuleInit() {
    await this.initSchema();
  }

  private async initSchema() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS transit_clicks (
          id SERIAL PRIMARY KEY,
          trip_id VARCHAR(100),
          partner VARCHAR(50) NOT NULL,
          type VARCHAR(20) NOT NULL,
          source VARCHAR(255) NOT NULL,
          destination VARCHAR(255) NOT NULL,
          date VARCHAR(20),
          redirect_url TEXT NOT NULL,
          clicked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_transit_clicks_trip ON transit_clicks(trip_id);
        CREATE INDEX IF NOT EXISTS idx_transit_clicks_partner ON transit_clicks(partner);
      `);
      this.logger.log('Transit clicks table initialized');
    } catch (err: any) {
      this.logger.warn(`Transit schema init: ${err.message}`);
    }
  }

  // ─── Deep Link Generators ─────────────────────────────────

  /**
   * Generate a MakeMyTrip railway deep link.
   * Requires IRCTC station codes (e.g., NDLS for New Delhi, BBS for Bhubaneswar).
   */
  generateTrainLink(sourceCode: string, destCode: string, date: string): string {
    // date should be YYYYMMDD
    const formattedDate = date.replace(/-/g, '');
    return `https://www.makemytrip.com/railways/listing?srcStn=${encodeURIComponent(sourceCode.toUpperCase())}&destStn=${encodeURIComponent(destCode.toUpperCase())}&date=${formattedDate}`;
  }

  /**
   * Generate a redBus deep link for bus tickets.
   * Uses city names directly.
   */
  generateBusLink(source: string, destination: string, date: string): string {
    // redBus expects DD-Mon-YYYY format
    const formattedDate = this.formatDateForRedBus(date);
    const srcSlug = source.toLowerCase().replace(/\s+/g, '-');
    const destSlug = destination.toLowerCase().replace(/\s+/g, '-');
    return `https://www.redbus.in/bus-tickets/${srcSlug}-to-${destSlug}?fromCityName=${encodeURIComponent(source)}&toCityName=${encodeURIComponent(destination)}&onward=${formattedDate}`;
  }

  /**
   * Generate a Rome2Rio deep link for multi-modal routing.
   */
  generateRome2RioLink(source: string, destination: string): string {
    const srcSlug = source.replace(/\s+/g, '-');
    const destSlug = destination.replace(/\s+/g, '-');
    return `https://www.rome2rio.com/map/${encodeURIComponent(srcSlug)}/${encodeURIComponent(destSlug)}`;
  }

  /**
   * Get all transit options (train, bus, multimodal) for a route.
   */
  getTransitOptions(source: string, destination: string, date: string, sourceStationCode?: string, destStationCode?: string) {
    const options: any[] = [];

    // Train option (requires station codes)
    if (sourceStationCode && destStationCode) {
      options.push({
        mode: 'train',
        partner: 'makemytrip',
        label: `🚂 Train: ${source} → ${destination}`,
        description: `Indian Railways via MakeMyTrip`,
        bookingUrl: this.generateTrainLink(sourceStationCode, destStationCode, date),
        icon: 'train',
      });
    }

    // Bus option
    options.push({
      mode: 'bus',
      partner: 'redbus',
      label: `🚌 Bus: ${source} → ${destination}`,
      description: `State & Private Buses via redBus`,
      bookingUrl: this.generateBusLink(source, destination, date),
      icon: 'bus',
    });

    // Multi-modal option
    options.push({
      mode: 'multimodal',
      partner: 'rome2rio',
      label: `🗺️ All Routes: ${source} → ${destination}`,
      description: `Train + Bus + Auto combined routes via Rome2Rio`,
      bookingUrl: this.generateRome2RioLink(source, destination),
      icon: 'map',
    });

    return options;
  }

  /**
   * Log a redirect click and return the redirect URL.
   */
  async logAndRedirect(
    partner: string,
    type: string,
    tripId: string,
    source: string,
    destination: string,
    date: string,
  ): Promise<string> {
    let redirectUrl: string;

    switch (partner) {
      case 'makemytrip':
        redirectUrl = this.generateTrainLink(source, destination, date);
        break;
      case 'redbus':
        redirectUrl = this.generateBusLink(source, destination, date);
        break;
      case 'rome2rio':
        redirectUrl = this.generateRome2RioLink(source, destination);
        break;
      default:
        throw new Error(`Unknown partner: ${partner}`);
    }

    // Log the click
    try {
      await this.pool.query(
        `INSERT INTO transit_clicks (trip_id, partner, type, source, destination, date, redirect_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tripId, partner, type, source, destination, date, redirectUrl],
      );
    } catch (e: any) {
      this.logger.warn(`Failed to log transit click: ${e.message}`);
    }

    return redirectUrl;
  }

  /**
   * Get click analytics for a trip.
   */
  async getClickAnalytics(tripId: string) {
    try {
      const result = await this.pool.query(
        `SELECT partner, type, COUNT(*) as clicks, MAX(clicked_at) as last_click
         FROM transit_clicks WHERE trip_id = $1
         GROUP BY partner, type
         ORDER BY clicks DESC`,
        [tripId],
      );
      return result.rows;
    } catch (err: any) {
      return [];
    }
  }

  /**
   * Common Indian railway station codes lookup.
   * This serves as a lightweight local resolver; can be extended with a RapidAPI IRCTC wrapper.
   */
  resolveStationCode(cityName: string): string | null {
    const stationMap: Record<string, string> = {
      // Metro cities
      'new delhi': 'NDLS', 'delhi': 'DLI', 'mumbai': 'CSMT', 'mumbai central': 'BCT',
      'kolkata': 'HWH', 'howrah': 'HWH', 'chennai': 'MAS', 'bangalore': 'SBC',
      'bengaluru': 'SBC', 'hyderabad': 'SC', 'secunderabad': 'SC',
      // Tier-2 cities
      'pune': 'PUNE', 'ahmedabad': 'ADI', 'jaipur': 'JP', 'lucknow': 'LKO',
      'kanpur': 'CNB', 'varanasi': 'BSB', 'agra': 'AGC', 'bhopal': 'BPL',
      'patna': 'PNBE', 'chandigarh': 'CDG', 'amritsar': 'ASR',
      'guwahati': 'GHY', 'bhubaneswar': 'BBS', 'thiruvananthapuram': 'TVC',
      'kochi': 'ERS', 'ernakulam': 'ERS', 'coimbatore': 'CBE',
      'visakhapatnam': 'VSKP', 'vizag': 'VSKP',
      'nagpur': 'NGP', 'indore': 'INDB', 'surat': 'ST',
      'madurai': 'MDU', 'jodhpur': 'JU', 'udaipur': 'UDZ',
      'dehradun': 'DDN', 'haridwar': 'HW', 'rishikesh': 'RKSH',
      'goa': 'MAO', 'margao': 'MAO', 'vasco': 'VSG',
      'jammu': 'JAT', 'ranchi': 'RNC', 'raipur': 'R',
      'mysore': 'MYS', 'mysuru': 'MYS', 'shimla': 'SML',
      'darjeeling': 'DJ', 'puri': 'PURI', 'tirupati': 'TPTY',
      // Tourist spots
      'gwalior': 'GWL', 'khajuraho': 'KURJ', 'ajmer': 'AII',
      'pushkar': 'AII', 'manali': 'JOG', 'kullu': 'JOG',
    };

    return stationMap[cityName.toLowerCase().trim()] || null;
  }

  // ─── Helpers ────────────────────────────────────────────

  private formatDateForRedBus(dateStr: string): string {
    // Input: YYYY-MM-DD or YYYYMMDD → Output: DD-Mon-YYYY
    const clean = dateStr.replace(/-/g, '');
    const year = clean.substring(0, 4);
    const month = parseInt(clean.substring(4, 6), 10);
    const day = clean.substring(6, 8);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${day}-${months[month - 1]}-${year}`;
  }
}
