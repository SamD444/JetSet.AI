import { Injectable, Logger, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { firstValueFrom } from 'rxjs';
import * as fs from 'fs';
import * as path from 'path';
import { TripsService } from '../trips/trips.service';
import { AiService } from '../ai/ai.service';
import { normalizeAndHash } from '../common/normalize';

@Injectable()
export class HotelsService {
  private readonly logger = new Logger(HotelsService.name);
  private readonly serpApiBaseUrl = 'https://serpapi.com/search.json';
  private readonly inFlightRequests = new Map<string, Promise<any>>();

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly tripsService: TripsService,
    private readonly aiService: AiService,
  ) {}

  private resolveIataFromCache(keyword: string): string | null {
    if (!keyword) return null;
    const cleanKeyword = keyword.trim().toUpperCase();
    
    // If it's already a 3-letter IATA code
    if (cleanKeyword.length === 3 && /^[A-Z]{3}$/.test(cleanKeyword)) {
      return cleanKeyword;
    }

    try {
      const cachePath = path.join(process.cwd(), 'data', 'airport_mappings_cache.json');
      if (fs.existsSync(cachePath)) {
        const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        
        // Exact match first
        if (cacheData[cleanKeyword]) {
          return cacheData[cleanKeyword];
        }

        // Fuzzy matches (e.g., if cleanKeyword is "PARIS", and cache has "PARIS, FRANCE")
        for (const [key, value] of Object.entries(cacheData)) {
          const upperKey = key.toUpperCase();
          if (upperKey.includes(cleanKeyword) || cleanKeyword.includes(upperKey)) {
            return value as string;
          }
        }
      }
    } catch (e: any) {
      this.logger.error(`Error reading airport mapping cache: ${e.message}`);
    }

    // Static fallback list if cache doesn't match or fails
    const staticMap: Record<string, string> = {
      'THAILAND': 'BKK',
      'BANGKOK': 'BKK',
      'PHUKET': 'HKT',
      'CHIANG MAI': 'CNX',
      'PATTAYA': 'BKK',
      'KRABI': 'KBV',
      'KOH SAMUI': 'USM',
      'SAMUI': 'USM',
      'VIETNAM': 'HAN',
      'HANOI': 'HAN',
      'HO CHI MINH': 'SGN',
      'DA NANG': 'DAD',
      'BALI': 'DPS',
      'INDONESIA': 'DPS',
      'JAKARTA': 'CGK',
      'MALDIVES': 'MLE',
      'MALE': 'MLE',
      'SRI LANKA': 'CMB',
      'COLOMBO': 'CMB',
      'NEPAL': 'KTM',
      'KATHMANDU': 'KTM',
      'SINGAPORE': 'SIN',
      'MALAYSIA': 'KUL',
      'KUALA LUMPUR': 'KUL',
      'JAPAN': 'HND',
      'TOKYO': 'HND',
      'TYO': 'HND',
      'KYOTO': 'KIX',
      'OSAKA': 'KIX',
      'PARIS': 'CDG',
      'PAR': 'CDG',
      'NEW YORK': 'JFK',
      'NYC': 'JFK',
      'DELHI': 'DEL',
      'DEL': 'DEL',
      'BHUBANESWAR': 'BBI',
      'BBI': 'BBI',
      'KOLKATA': 'CCU',
      'MUMBAI': 'BOM',
      'LONDON': 'LHR',
      'LON': 'LHR',
      'DUBAI': 'DXB',
      'ROME': 'FCO',
      'BARCELONA': 'BCN',
      'FRANKFURT': 'FRA',
      'ZURICH': 'ZRH',
      'SYDNEY': 'SYD',
    };
    
    for (const [key, value] of Object.entries(staticMap)) {
      if (cleanKeyword === key || cleanKeyword.includes(key) || key.includes(cleanKeyword)) {
        return value;
      }
    }

    return null;
  }

  private getCityNameFromIata(cityCode: string): string {
    if (!cityCode) return '';
    const upperCode = cityCode.trim().toUpperCase();

    // 1. Static reverse mapping of common IATA codes
    const staticIataToCity: Record<string, string> = {
      'CDG': 'Paris',
      'ORY': 'Paris',
      'PAR': 'Paris',
      'JFK': 'New York',
      'LGA': 'New York',
      'EWR': 'New York',
      'NYC': 'New York',
      'LHR': 'London',
      'LGW': 'London',
      'LCY': 'London',
      'LON': 'London',
      'HND': 'Tokyo',
      'NRT': 'Tokyo',
      'TYO': 'Tokyo',
      'DEL': 'Delhi',
      'BOM': 'Mumbai',
      'BLR': 'Bengaluru',
      'MAA': 'Chennai',
      'HYD': 'Hyderabad',
      'CCU': 'Kolkata',
      'PNQ': 'Pune',
      'GOI': 'Goa',
      'GOX': 'Goa',
      'COK': 'Kochi',
      'BBI': 'Bhubaneswar',
      'JAI': 'Jaipur',
      'LKO': 'Lucknow',
      'TRV': 'Trivandrum',
      'AMD': 'Ahmedabad',
      'ATQ': 'Amritsar',
      'DXB': 'Dubai',
      'SIN': 'Singapore',
      'BKK': 'Bangkok',
      'DPS': 'Bali',
      'MLE': 'Maldives',
      'KTM': 'Kathmandu',
      'CMB': 'Colombo',
      'FCO': 'Rome',
      'BCN': 'Barcelona',
      'AMS': 'Amsterdam',
      'FRA': 'Frankfurt',
      'ZRH': 'Zurich',
      'IST': 'Istanbul',
      'DOH': 'Doha',
      'AUH': 'Abu Dhabi',
      'SVO': 'Moscow',
      'PEK': 'Beijing',
      'PVG': 'Shanghai',
      'HKG': 'Hong Kong',
      'KUL': 'Kuala Lumpur',
      'SYD': 'Sydney',
      'LAX': 'Los Angeles',
      'SFO': 'San Francisco',
      'ORD': 'Chicago',
      'YYZ': 'Toronto',
      'CPT': 'Cape Town',
      'NBO': 'Nairobi',
      'CAI': 'Cairo',
      'MEX': 'Mexico City',
      'GIG': 'Rio de Janeiro',
      'GRU': 'Sao Paulo'
    };

    if (staticIataToCity[upperCode]) {
      return staticIataToCity[upperCode];
    }

    // 2. Fallback to airport_mappings_cache.json search
    try {
      const cachePath = path.join(process.cwd(), 'data', 'airport_mappings_cache.json');
      if (fs.existsSync(cachePath)) {
        const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        for (const [key, value] of Object.entries(cacheData)) {
          if ((value as string).toUpperCase() === upperCode) {
            const cityName = key.split(',')[0].trim();
            return cityName.replace(/\b\w/g, c => c.toUpperCase());
          }
        }
      }
    } catch (e: any) {
      this.logger.error(`Error reversing airport mapping cache: ${e.message}`);
    }

    return upperCode;
  }

  async getHotelAutocomplete(keyword: string): Promise<any> {
    const iataCode = this.resolveIataFromCache(keyword);
    if (iataCode) {
      return {
        data: [
          {
            address: {
              cityCode: iataCode,
            },
            iataCode: iataCode,
          }
        ]
      };
    }
    return { data: [] };
  }

  async getHotelsByCity(
    cityCode: string,
    checkin?: string,
    checkout?: string,
    tripId?: string,
    curr?: string,
    cityNameQuery?: string,
  ): Promise<any> {
    const today = new Date();
    const finalCheckin = checkin || new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const finalCheckout = checkout || new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    let budgetTier = 'moderate';
    let tripData: any = null;
    let targetCurrency = curr || 'USD';
    if (tripId) {
      try {
        tripData = await this.tripsService.getTrip(tripId);
        if (tripData) {
          if (tripData.budget) budgetTier = tripData.budget;
          if (tripData.currency && !curr) targetCurrency = tripData.currency;
        }
      } catch (err: any) {
        this.logger.warn(`Could not load trip details for ID ${tripId} during hotel search: ${err.message}`);
      }
    }

    // Generate normalized SHA-256 cache key (include cityNameQuery to avoid cross-city cache hits under same airport)
    const cacheKey = normalizeAndHash('hotels_search_v2', {
      cityCode,
      checkin: finalCheckin,
      checkout: finalCheckout,
      currency: targetCurrency,
      budgetTier,
      cityNameQuery: cityNameQuery || '',
    });

    const cachedData = await this.cacheManager.get(cacheKey);
    if (cachedData) {
      this.logger.debug('Returning cached hotels search results');
      return cachedData;
    }

    // Request deduplication
    const inFlight = this.inFlightRequests.get(cacheKey);
    if (inFlight) {
      this.logger.debug('Reusing in-flight request for identical hotel query');
      return inFlight;
    }

    const promise = (async () => {
      const serpApiKey = this.configService.get<string>('SERPAPI_KEY_HOTELS') || this.configService.get<string>('SERPAPI_KEY') || '';
      if (!serpApiKey) {
        this.logger.warn(`SERPAPI_KEY_HOTELS is not configured. Returning mock stays.`);
        const mockHotels = this.generateMockHotels(cityCode, budgetTier, targetCurrency);
        const enrichedHotels = await this.processHotelsWithScoringAndGrok(mockHotels, tripData);
        const mockResult = { data: enrichedHotels };
        await this.cacheManager.set(cacheKey, mockResult, 1800000); // 30 min cache
        return mockResult;
      }

      try {
        let cityName = this.getCityNameFromIata(cityCode);
        if (cityNameQuery) {
          let cleaned = cityNameQuery.split('(')[0].trim();
          cleaned = cleaned.replace(/\b[A-Z]{3}\b/g, '').trim();
          cleaned = cleaned.replace(/Days \d+-\d+/gi, '').trim();
          if (cleaned) {
            cityName = cleaned;
          }
        }
        const query = `${cityName} hotels`;
        this.logger.log(`Searching Google Hotels via SerpAPI for query: "${query}" on dates ${finalCheckin} to ${finalCheckout} in currency ${targetCurrency}`);

        const params: Record<string, string> = {
          engine: 'google_hotels',
          q: query,
          check_in_date: finalCheckin,
          check_out_date: finalCheckout,
          adults: '1',
          currency: targetCurrency,
          hl: 'en',
          api_key: serpApiKey,
        };

        const response = await firstValueFrom(
          this.httpService.get(this.serpApiBaseUrl, { params, timeout: 20000 })
        );

        const responseData = response.data;
        let mappedHotels: any[] = [];

        if (responseData && responseData.properties && responseData.properties.length > 0) {
          mappedHotels = responseData.properties.map((prop: any, idx: number) => {
            let priceStr = '';
            let sourceCurrency = 'USD';

            if (prop.rate_per_night) {
              const lowestStr = prop.rate_per_night.lowest || '';
              if (lowestStr) {
                // Determine source currency symbol
                if (lowestStr.includes('₹') || lowestStr.includes('INR') || lowestStr.toLowerCase().includes('rs')) {
                  sourceCurrency = 'INR';
                } else if (lowestStr.includes('€') || lowestStr.includes('EUR')) {
                  sourceCurrency = 'EUR';
                } else if (lowestStr.includes('£') || lowestStr.includes('GBP')) {
                  sourceCurrency = 'GBP';
                } else if (lowestStr.includes('¥') || lowestStr.includes('JPY')) {
                  sourceCurrency = 'JPY';
                }

                // Extract numeric value (remove commas first to avoid e.g. "10,500" matching as "10")
                const cleanLowest = lowestStr.replace(/,/g, '');
                const match = cleanLowest.match(/\d+/);
                if (match) {
                  priceStr = match[0];
                }
              } else if (prop.rate_per_night.extracted_lowest) {
                priceStr = prop.rate_per_night.extracted_lowest.toString();
              }
            }

            // Skip hotel properties that do not have valid price data
            if (!priceStr) {
              return null;
            }

            // Perform currency conversion from source to requested targetCurrency
            let priceVal = parseFloat(priceStr);
            let priceInUsd = priceVal;
            if (sourceCurrency === 'INR') priceInUsd = priceVal / 83;
            else if (sourceCurrency === 'EUR') priceInUsd = priceVal / 0.92;
            else if (sourceCurrency === 'GBP') priceInUsd = priceVal / 0.79;
            else if (sourceCurrency === 'JPY') priceInUsd = priceVal / 155;

            let convertedPrice = priceInUsd;
            const target = targetCurrency.toUpperCase();
            if (target === 'INR') convertedPrice = priceInUsd * 83;
            else if (target === 'EUR') convertedPrice = priceInUsd * 0.92;
            else if (target === 'GBP') convertedPrice = priceInUsd * 0.79;
            else if (target === 'JPY') convertedPrice = priceInUsd * 155;

            priceStr = Math.round(convertedPrice).toString();

            const ratingNum = prop.overall_rating || prop.rating || 8.0;

            return {
              hotelId: prop.hotel_class_id || prop.property_token || `HOTEL-${cityCode.toUpperCase()}-${idx}-${prop.name.replace(/\s+/g, '-').substring(0, 8)}`,
              name: prop.name,
              geoCode: {
                latitude: prop.gps_coordinates?.latitude || 0,
                longitude: prop.gps_coordinates?.longitude || 0,
              },
              distance: {
                value: 1.5,
              },
              price: priceStr,
              rating: ratingNum,
              image: prop.thumbnail || (prop.images && prop.images[0]?.thumbnail) || (prop.images && prop.images[0]) || null,
            };
          }).filter((h: any) => h !== null);

          // If all hotels were skipped due to missing pricing, generate mock hotels as fallback
          if (mappedHotels.length === 0) {
            this.logger.warn(`All found hotels lacked pricing. Generating fallback mock hotels.`);
            mappedHotels = this.generateMockHotels(cityCode, budgetTier, targetCurrency);
          }
        } else {
          this.logger.warn(`No hotels found in SerpAPI search response. Generating fallback mock hotels.`);
          mappedHotels = this.generateMockHotels(cityCode, budgetTier, targetCurrency);
        }

        const enrichedHotels = await this.processHotelsWithScoringAndGrok(mappedHotels, tripData);
        const result = { data: enrichedHotels };
        await this.cacheManager.set(cacheKey, result, 1800000); // 30 min cache
        return result;

      } catch (error: any) {
        this.logger.error(`SerpAPI hotel search failed: ${error.message}. Returning mock stays fallback.`);
        const mockHotels = this.generateMockHotels(cityCode, budgetTier, targetCurrency);
        const enrichedHotels = await this.processHotelsWithScoringAndGrok(mockHotels, tripData);
        const fallbackResult = { data: enrichedHotels };
        return fallbackResult;
      }
    })();

    this.inFlightRequests.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.inFlightRequests.delete(cacheKey);
    }
  }

  // Not used in frontend currently, but stubbed out to map to mock data
  async getHotelOffers(hotelIds: string, adults: number = 1, checkInDate?: string, checkOutDate?: string): Promise<any> {
    return { data: [] };
  }

  async getHotelRatings(hotelIds: string): Promise<any> {
    return { data: [] };
  }

  async bookHotel(bookingData: any): Promise<any> {
    // Avoid Booking.com calls for booking, return success redirect information
    return { status: 'success', message: 'Booking link generated successfully.' };
  }

  private generateMockHotels(cityCode: string, budgetTier?: string, currency: string = 'USD'): any[] {
    const defaultCoords: Record<string, { lat: number; lng: number }> = {
      'PAR': { lat: 48.8566, lng: 2.3522 },
      'TYO': { lat: 35.6762, lng: 139.6503 },
      'NYC': { lat: 40.7128, lng: -74.0060 },
      'DEL': { lat: 28.6139, lng: 77.2090 },
      'BBI': { lat: 20.2961, lng: 85.8245 },
      'LON': { lat: 51.5074, lng: -0.1278 },
    };

    const center = defaultCoords[cityCode.toUpperCase()] || { lat: 48.8566, lng: 2.3522 };

    let hotelNames = [
      'Grand Plaza Hotel',
      'The Crystal Palace Stay',
      'Emerald Boutique Inn',
      'Skyline View Apartments',
      'Riverfront Premium Resort',
      'Urban Luxury Suites'
    ];
    let priceBase = 80;
    let priceMultiplier = 35;

    const tier = (budgetTier || '').toLowerCase();
    if (tier === 'budget' || tier === 'low') {
      hotelNames = [
        'Eco Budget Hostel',
        'Backpacker Haven',
        'Comfort Value Inn',
        'Smart Stay Rooms',
        'City Center Dorms',
        'Subway Line Lodge'
      ];
      priceBase = 45;
      priceMultiplier = 12;
    } else if (tier === 'luxury' || tier === 'high') {
      hotelNames = [
        'Royal Palace Resort',
        'The Majestic Ritz',
        'Grand Horizon Suites',
        'Imperial Oasis & Spa',
        'Prestige Park Chateau',
        'Vanguard Luxury Villa'
      ];
      priceBase = 280;
      priceMultiplier = 75;
    }

    return hotelNames.map((name, idx) => {
      const latOffset = (idx % 2 === 0 ? 1 : -1) * (0.005 * idx + 0.002);
      const lngOffset = (idx % 3 === 0 ? 1 : -1) * (0.006 * idx + 0.001);
      const rating = 7.8 + (idx * 0.3) % 2.1;
      let price = priceBase + idx * priceMultiplier;

      const cleanCurr = (currency || 'USD').toUpperCase();
      if (cleanCurr === 'INR') {
        price = Math.round(price * 83);
      } else if (cleanCurr === 'EUR') {
        price = Math.round(price * 0.92);
      } else if (cleanCurr === 'GBP') {
        price = Math.round(price * 0.79);
      } else if (cleanCurr === 'JPY') {
        price = Math.round(price * 155);
      }

      return {
        hotelId: `HOTEL-${cityCode.toUpperCase()}-${idx}`,
        name: `${name} ${cityCode.toUpperCase()}`,
        geoCode: {
          latitude: center.lat + latOffset,
          longitude: center.lng + lngOffset,
        },
        distance: {
          value: 1.0 + idx * 0.8,
        },
        price: price.toString(),
        rating: parseFloat(rating.toFixed(1)),
      };
    });
  }

  private async processHotelsWithScoringAndGrok(hotels: any[], tripData: any): Promise<any[]> {
    const enrichedHotels = this.calculateBackendHotelScores(hotels, tripData);
    
    // Sort by Match Score (descending)
    enrichedHotels.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));

    // calculateBackendHotelScores provides comprehensive 5-factor scoring (budget fit, companion suitability,
    // interests match, location convenience, review quality) and personalized match reasons deterministically.
    this.logger.log(`[Deterministic] Enriched and ranked ${enrichedHotels.length} hotels with 5-factor scoring and personalized match reasons`);
    return enrichedHotels;
  }

  private calculateBackendHotelScores(hotels: any[], trip: any): any[] {
    if (!trip) {
      return hotels.map(h => ({
        ...h,
        matchScore: 70,
        matchReason: 'Fits standard travel options.'
      }));
    }

    const budget = ((trip.budget as string) || '').toLowerCase();
    const companions = ((trip.companions as string) || '').toLowerCase();
    const interests = (trip.interests as string[]) || [];

    return hotels.map((h) => {
      const price = parseFloat(h.price || '100');
      const rating = h.rating || 7.0;
      
      const distanceVal = typeof h.distance === 'object' && h.distance !== null
        ? (h.distance.value ?? 1.5)
        : (typeof h.distance === 'number' ? h.distance : 1.5);

      let score = 15; // base
      let reasons: string[] = [];

      // 1. BUDGET FIT — highest priority (up to 25 points)
      let budgetScore = 0;
      if (budget.includes('budget') || budget.includes('low')) {
        if (price < 70) {
          budgetScore = 25;
          reasons.push('Excellent budget-friendly pricing');
        } else if (price < 100) {
          budgetScore = 18;
          reasons.push('Good value for a budget stay');
        } else if (price < 150) {
          budgetScore = 8;
        } else {
          budgetScore = 0; // Overpriced for budget traveler — penalize
          reasons.push('Slightly above typical budget range');
        }
      } else if (budget.includes('luxury') || budget.includes('high')) {
        if (price >= 250) {
          budgetScore = 25;
          reasons.push('Premium luxury experience');
        } else if (price >= 180) {
          budgetScore = 18;
          reasons.push('High-end comfort at a great price');
        } else if (price >= 120) {
          budgetScore = 10;
        } else {
          budgetScore = 2; // Too cheap for luxury traveler
        }
      } else { // Mid-Range / Moderate
        if (price >= 80 && price <= 180) {
          budgetScore = 25;
          reasons.push('Excellent mid-range value');
        } else if (price >= 60 && price <= 220) {
          budgetScore = 15;
          reasons.push('Reasonably priced comfortable stay');
        } else {
          budgetScore = 5;
        }
      }
      score += budgetScore;

      // 2. COMPANION SUITABILITY — second highest priority (up to 25 points)
      let companionScore = 0;
      const nameLower = h.name.toLowerCase();
      if (companions.includes('solo')) {
        if (nameLower.includes('hostel') || nameLower.includes('dorm')) {
          companionScore = 25;
          reasons.push('Social hostel ideal for solo travelers');
        } else if (distanceVal < 1.5) {
          companionScore = 18;
          reasons.push('Central location — easy solo navigation');
        } else if (distanceVal < 3.0) {
          companionScore = 10;
        }
      } else if (companions.includes('family')) {
        if (nameLower.includes('resort') || nameLower.includes('apart') || nameLower.includes('suite')) {
          companionScore = 25;
          reasons.push('Spacious family-friendly accommodation');
        } else if (rating >= 8.5) {
          companionScore = 18;
          reasons.push('Highly rated — great for families');
        } else if (distanceVal < 2.0) {
          companionScore = 10;
        }
      } else if (companions.includes('couple')) {
        if (nameLower.includes('boutique') || nameLower.includes('plaza') || nameLower.includes('villa') || nameLower.includes('inn')) {
          companionScore = 25;
          reasons.push('Intimate boutique setting perfect for couples');
        } else if (rating >= 8.5) {
          companionScore = 18;
          reasons.push('Highly rated romantic stay');
        }
      } else if (companions.includes('friends')) {
        if (distanceVal < 2.0) {
          companionScore = 20;
          reasons.push('Central spot great for group exploration');
        } else if (nameLower.includes('hostel') || nameLower.includes('villa')) {
          companionScore = 18;
          reasons.push('Sociable accommodation ideal for friend groups');
        }
      }
      score += companionScore;

      // 3. INTERESTS MATCH (up to 20 points)
      let interestScore = 0;
      const matchedInterests = interests.filter(interest => {
        const li = interest.toLowerCase();
        if (li.includes('nature') && (nameLower.includes('park') || nameLower.includes('lake') || nameLower.includes('oasis') || nameLower.includes('resort') || nameLower.includes('garden'))) return true;
        if (li.includes('culture') && (nameLower.includes('plaza') || nameLower.includes('palace') || nameLower.includes('heritage') || nameLower.includes('chateau') || nameLower.includes('grand') || nameLower.includes('museum'))) return true;
        if (li.includes('shopping') && (nameLower.includes('center') || nameLower.includes('city') || nameLower.includes('mall') || nameLower.includes('market'))) return true;
        if (li.includes('food') && (nameLower.includes('kitchen') || nameLower.includes('bistro') || nameLower.includes('dining') || nameLower.includes('gastro'))) return true;
        if (li.includes('wellness') && (nameLower.includes('spa') || nameLower.includes('wellness') || nameLower.includes('retreat'))) return true;
        if (li.includes('adventure') && (nameLower.includes('lodge') || nameLower.includes('camp') || nameLower.includes('eco'))) return true;
        return false;
      });
      if (matchedInterests.length >= 2) {
        interestScore = 20;
        reasons.push(`Matches your interests in ${matchedInterests.slice(0, 2).join(' & ')}`);
      } else if (matchedInterests.length === 1) {
        interestScore = 12;
        reasons.push(`Suits your interest in ${matchedInterests[0]}`);
      }
      score += interestScore;

      // 4. LOCATION CONVENIENCE (up to 15 points)
      let locationScore = 0;
      if (distanceVal < 1.0) {
        locationScore = 15;
        reasons.push('Prime central location');
      } else if (distanceVal < 2.0) {
        locationScore = 10;
      } else if (distanceVal < 4.0) {
        locationScore = 5;
      }
      score += locationScore;

      // 5. REVIEW QUALITY — lowest priority (up to 15 points, was 30 before)
      let ratingScore = 0;
      if (rating >= 9.0) {
        ratingScore = 15;
        reasons.push('Outstanding guest reviews');
      } else if (rating >= 8.5) {
        ratingScore = 10;
        reasons.push('Excellent guest ratings');
      } else if (rating >= 7.5) {
        ratingScore = 6;
      } else if (rating >= 6.5) {
        ratingScore = 3;
      }
      score += ratingScore;

      score = Math.max(10, Math.min(100, score));
      const reason = reasons.join(', ') || 'Matches search options and parameters';

      return {
        ...h,
        matchScore: score,
        matchReason: `${reason}.`
      };
    });
  }
}
