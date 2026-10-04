import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface RuralStay {
  id?: number;
  name: string;
  lat: number;
  lon: number;
  type: string; // guest_house, camp_site, hostel, homestay, dharamshala
  contact_whatsapp?: string;
  contact_phone?: string;
  website?: string;
  source: string; // 'overpass', 'govt', 'manual'
  price_band: 'budget' | 'mid' | 'premium'; // ₹0-500 | ₹500-2000 | ₹2000+
  village_name?: string;
  district?: string;
  state?: string;
  amenities?: string[];
  description?: string;
  osm_id?: string;
}

@Injectable()
export class RuralStaysService implements OnModuleInit {
  private readonly logger = new Logger(RuralStaysService.name);
  private readonly OVERPASS_API = 'https://overpass-api.de/api/interpreter';

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
        CREATE TABLE IF NOT EXISTS rural_stays (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          lat DOUBLE PRECISION NOT NULL,
          lon DOUBLE PRECISION NOT NULL,
          type VARCHAR(50) NOT NULL DEFAULT 'guest_house',
          contact_whatsapp VARCHAR(20),
          contact_phone VARCHAR(20),
          website TEXT,
          source VARCHAR(30) NOT NULL DEFAULT 'overpass',
          price_band VARCHAR(10) NOT NULL DEFAULT 'budget',
          village_name VARCHAR(255),
          district VARCHAR(255),
          state VARCHAR(255),
          amenities JSONB DEFAULT '[]',
          description TEXT,
          osm_id VARCHAR(50) UNIQUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_rural_stays_coords ON rural_stays(lat, lon);
        CREATE INDEX IF NOT EXISTS idx_rural_stays_price ON rural_stays(price_band);
        CREATE INDEX IF NOT EXISTS idx_rural_stays_state ON rural_stays(state);
        CREATE INDEX IF NOT EXISTS idx_rural_stays_osm ON rural_stays(osm_id);
      `);
      this.logger.log('Rural stays table initialized');
    } catch (err: any) {
      this.logger.warn(`Rural stays schema init: ${err.message}`);
    }
  }

  /**
   * Geocode a location string into coordinates using Nominatim API.
   */
  async geocode(query: string): Promise<{ lat: number; lon: number } | null> {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: { 'User-Agent': 'JetSet.AI/1.0 (contact@jetset.ai)' },
          timeout: 10000,
        }),
      );
      const data = response.data;
      if (data && data.length > 0) {
        return {
          lat: parseFloat(data[0].lat),
          lon: parseFloat(data[0].lon),
        };
      }
    } catch (err: any) {
      this.logger.warn(`Nominatim geocode failed for ${query}: ${err.message}`);
    }
    return null;
  }

  /**
   * Query Overpass API for unlisted village stays near coordinates.
   * Searches within a configurable radius (default 15km) for:
   * - guest houses, camp sites, hostels, chalets, wilderness huts
   */
  async fetchFromOverpass(lat: number, lon: number, radiusKm: number = 15): Promise<RuralStay[]> {
    const radiusMeters = radiusKm * 1000;

    const query = `
      [out:json][timeout:25];
      (
        node["tourism"="guest_house"](around:${radiusMeters},${lat},${lon});
        node["tourism"="camp_site"](around:${radiusMeters},${lat},${lon});
        node["tourism"="hostel"](around:${radiusMeters},${lat},${lon});
        node["tourism"="chalet"](around:${radiusMeters},${lat},${lon});
        node["tourism"="wilderness_hut"](around:${radiusMeters},${lat},${lon});
        way["tourism"="guest_house"](around:${radiusMeters},${lat},${lon});
        way["tourism"="camp_site"](around:${radiusMeters},${lat},${lon});
      );
      out center body;
    `;

    try {
      const response = await firstValueFrom(
        this.httpService.post(this.OVERPASS_API, `data=${encodeURIComponent(query)}`, {
          headers: { 
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'User-Agent': 'JetSet.AI/1.0 (contact@jetset.ai)'
          },
          timeout: 30000,
        }),
      );

      const elements = response.data?.elements || [];
      this.logger.log(`Overpass returned ${elements.length} stays near (${lat}, ${lon})`);

      return elements.map((el: any) => {
        const elLat = el.lat || el.center?.lat;
        const elLon = el.lon || el.center?.lon;
        const tags = el.tags || {};

        return {
          name: tags.name || tags['name:en'] || `${tags.tourism || 'Stay'} near village`,
          lat: elLat,
          lon: elLon,
          type: this.mapOsmType(tags.tourism),
          contact_phone: tags.phone || tags['contact:phone'] || null,
          contact_whatsapp: tags['contact:whatsapp'] || tags.phone || null,
          website: tags.website || tags['contact:website'] || null,
          source: 'overpass',
          price_band: this.inferPriceBand(tags),
          village_name: tags['addr:village'] || tags['addr:hamlet'] || tags['addr:city'] || null,
          district: tags['addr:district'] || null,
          state: tags['addr:state'] || null,
          amenities: this.extractAmenities(tags),
          description: tags.description || tags.note || null,
          osm_id: `${el.type}/${el.id}`,
        } as RuralStay;
      });
    } catch (err: any) {
      this.logger.warn(`Overpass query failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Discover, upsert, and return rural stays near a destination.
   * Fetches fresh data from Overpass, merges into Supabase, returns combined results.
   */
  async discoverStays(
    lat: number,
    lon: number,
    radiusKm: number = 15,
    priceBand?: string,
  ): Promise<RuralStay[]> {
    // 1. Fetch from Overpass
    const overpassStays = await this.fetchFromOverpass(lat, lon, radiusKm);

    // 2. Upsert into DB in the background (fire-and-forget) to avoid blocking the HTTP response
    (async () => {
      for (const stay of overpassStays) {
        try {
          await this.pool.query(
            `INSERT INTO rural_stays (name, lat, lon, type, contact_whatsapp, contact_phone, website, source, price_band, village_name, district, state, amenities, description, osm_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT (osm_id) DO UPDATE SET
               name = EXCLUDED.name,
               contact_phone = COALESCE(EXCLUDED.contact_phone, rural_stays.contact_phone),
               website = COALESCE(EXCLUDED.website, rural_stays.website),
               amenities = EXCLUDED.amenities,
               updated_at = CURRENT_TIMESTAMP`,
            [
              stay.name, stay.lat, stay.lon, stay.type,
              stay.contact_whatsapp, stay.contact_phone, stay.website,
              stay.source, stay.price_band, stay.village_name,
              stay.district, stay.state,
              JSON.stringify(stay.amenities || []),
              stay.description, stay.osm_id,
            ],
          );
        } catch (e: any) {
          // Skip duplicates or bad rows silently
        }
      }
    })();

    // 3. Query DB for previously stored manual/govt entries
    let query = `
      SELECT * FROM rural_stays
      WHERE lat BETWEEN $1 AND $2
        AND lon BETWEEN $3 AND $4
        AND source != 'overpass'
    `;
    const latDelta = radiusKm / 111.0; // ~1 degree = 111km
    const lonDelta = radiusKm / (111.0 * Math.cos((lat * Math.PI) / 180));
    const params: any[] = [lat - latDelta, lat + latDelta, lon - lonDelta, lon + lonDelta];

    if (priceBand && ['budget', 'mid', 'premium'].includes(priceBand)) {
      query += ` AND price_band = $5`;
      params.push(priceBand);
    }

    let existingStays: RuralStay[] = [];
    try {
      const result = await this.pool.query(query, params);
      existingStays = result.rows;
    } catch (err: any) {
      this.logger.warn(`DB query for existing rural stays failed: ${err.message}`);
    }

    // 4. Merge and Sort
    let allStays = [...existingStays, ...overpassStays];
    
    if (priceBand && ['budget', 'mid', 'premium'].includes(priceBand)) {
      allStays = allStays.filter(s => s.price_band === priceBand);
    }
    
    // Sort by proximity
    allStays.sort((a, b) => {
      const distA = Math.abs(a.lat - lat) + Math.abs(a.lon - lon);
      const distB = Math.abs(b.lat - lat) + Math.abs(b.lon - lon);
      return distA - distB;
    });

    // Remove duplicates based on osm_id or lat/lon
    const uniqueStays = Array.from(new Map(allStays.map(s => [s.osm_id || `${s.lat}-${s.lon}`, s])).values());

    return uniqueStays.slice(0, 50);
  }

  /**
   * Search stays by state/district name (text-based fallback when no coords available).
   */
  async searchByRegion(state: string, district?: string, priceBand?: string): Promise<RuralStay[]> {
    let query = `SELECT * FROM rural_stays WHERE LOWER(state) = LOWER($1)`;
    const params: any[] = [state];

    if (district) {
      query += ` AND LOWER(district) = LOWER($2)`;
      params.push(district);
    }
    if (priceBand && ['budget', 'mid', 'premium'].includes(priceBand)) {
      query += ` AND price_band = $${params.length + 1}`;
      params.push(priceBand);
    }

    query += ` ORDER BY name ASC LIMIT 50`;

    try {
      const result = await this.pool.query(query, params);
      return result.rows;
    } catch (err: any) {
      this.logger.warn(`Region search failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Generate a pre-filled WhatsApp deep link for contacting a host.
   */
  generateWhatsAppLink(phone: string, villageName: string, date?: string): string {
    const cleanPhone = phone.replace(/[^0-9+]/g, '');
    const dateStr = date || 'your earliest available date';
    const message = `Hi, I found your homestay in ${villageName} on JetSet.AI. Are you available on ${dateStr}?`;
    return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`;
  }

  /**
   * Enrich a single stay result with contact links.
   */
  enrichStayWithLinks(stay: RuralStay, travelDate?: string): RuralStay & { whatsappLink?: string } {
    const enriched: any = { ...stay };

    if (stay.contact_whatsapp || stay.contact_phone) {
      enriched.whatsappLink = this.generateWhatsAppLink(
        stay.contact_whatsapp || stay.contact_phone || '',
        stay.village_name || stay.name,
        travelDate,
      );
    }

    return enriched;
  }

  // ─── Helpers ───────────────────────────────────────────

  private mapOsmType(tourism: string): string {
    const map: Record<string, string> = {
      guest_house: 'homestay',
      camp_site: 'camp_site',
      hostel: 'hostel',
      chalet: 'homestay',
      wilderness_hut: 'dharamshala',
    };
    return map[tourism] || 'guest_house';
  }

  private inferPriceBand(tags: Record<string, string>): 'budget' | 'mid' | 'premium' {
    // Heuristic: camp sites and wilderness huts are budget,
    // guest houses with websites tend to be mid, others budget
    if (tags.tourism === 'camp_site' || tags.tourism === 'wilderness_hut') return 'budget';
    if (tags.stars && parseInt(tags.stars) >= 3) return 'premium';
    if (tags.website) return 'mid';
    return 'budget';
  }

  private extractAmenities(tags: Record<string, string>): string[] {
    const amenities: string[] = [];
    if (tags.internet_access === 'wlan' || tags.internet_access === 'yes') amenities.push('WiFi');
    if (tags.parking === 'yes') amenities.push('Parking');
    if (tags.swimming_pool === 'yes') amenities.push('Pool');
    if (tags.restaurant === 'yes' || tags.food === 'yes') amenities.push('Food');
    if (tags.electricity === 'yes') amenities.push('Electricity');
    if (tags.drinking_water === 'yes') amenities.push('Drinking Water');
    return amenities;
  }
}
