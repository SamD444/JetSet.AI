import { Injectable, Logger } from '@nestjs/common';
import Groq from 'groq-sdk';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class LlmService {
  private groq: Groq;
  private readonly logger = new Logger(LlmService.name);

  constructor(private configService: ConfigService) {
    const key = this.configService.get<string>('TUFFY_GROQ_API_KEY');
    if (key && key.trim()) {
      this.logger.log('[Tuffy Groq] Groq client initialized for Tuffy Agent (model: openai/gpt-oss-120b)');
    } else {
      this.logger.error('[Tuffy Groq] TUFFY_GROQ_API_KEY is not set — Tuffy will fail to respond!');
    }
    this.groq = new Groq({
      apiKey: key,
    });
  }

  async getChatCompletionStream(
    messages: any[],
    systemPrompt: string,
    abortSignal?: AbortSignal,
    reqId?: string,
  ): Promise<AsyncIterable<any>> {
    this.logger.log(`[Tuffy Groq] Starting chat completion stream requestId=${reqId || 'unknown'}`);

    // Guard: if the abort signal is already fired before we even call Groq, bail out now.
    if (abortSignal?.aborted) {
      this.logger.warn(`[Tuffy Groq] abortSignal already aborted before Groq call requestId=${reqId || 'unknown'}`);
      throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    }

    let rawStream: any;
    try {
      rawStream = await this.groq.chat.completions.create(
        {
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages.map(m => ({ ...m, role: m.role === 'model' ? 'assistant' : m.role })),
          ],
          model: 'openai/gpt-oss-120b',
          stream: true,
          tools: [
            {
              type: 'function',
              function: {
                name: 'search_destinations',
                description: 'Search for travel destinations based on query',
                parameters: {
                  type: 'object',
                  properties: {
                    query: { type: 'string', description: 'The search query' },
                  },
                  required: ['query'],
                },
              },
            },
            {
              type: 'function',
              function: {
                name: 'get_transit_schedule',
                description: 'Get transit schedule for a route',
                parameters: {
                  type: 'object',
                  properties: {
                    origin: { type: 'string' },
                    destination: { type: 'string' },
                    date: { type: 'string' },
                  },
                  required: ['origin', 'destination', 'date'],
                },
              },
            },
            {
              type: 'function',
              function: {
                name: 'fetch_homestays',
                description: 'Fetch homestays for a destination',
                parameters: {
                  type: 'object',
                  properties: {
                    location: { type: 'string' },
                    checkIn: { type: 'string' },
                    checkOut: { type: 'string' },
                  },
                  required: ['location', 'checkIn', 'checkOut'],
                },
              },
            },
            {
              type: 'function',
              function: {
                name: 'request_booking_confirmation',
                description: 'Request confirmation to book a trip or homestay',
                parameters: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['flight', 'homestay'] },
                    itemId: { type: 'string' },
                  },
                  required: ['type', 'itemId'],
                },
              },
            },
            {
              type: 'function',
              function: {
                name: 'navigate_to_page',
                description: 'Navigate the user to a specific page or route in the application if their request falls outside the current view',
                parameters: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', description: 'The path to navigate to, e.g., /flights, /hotels, /results' },
                  },
                  required: ['path'],
                },
              },
            },
            {
              type: 'function',
              function: {
                name: 'switch_tab',
                description: 'Switch the dashboard tab if the user wants to view flights, hotels, or their itinerary.',
                parameters: {
                  type: 'object',
                  properties: {
                    tabId: { type: 'string', enum: ['summary', 'flights', 'hotels', 'season', 'itinerary'] },
                  },
                  required: ['tabId'],
                },
              },
            },
            {
              type: 'function',
              function: {
                name: 'modify_trip',
                description: 'Plan a new trip or update trip parameters whenever the user requests a trip plan, states travel intentions (destination, origin, dates, budget, companions), or wants to change/extend existing trip parameters.',
                parameters: {
                  type: 'object',
                  properties: {
                    origin: { type: 'string', description: 'Departure / starting city or airport (e.g., "Bhubaneswar", "Bengaluru", "New York")' },
                    destination: { type: 'string', description: 'Destination city or country (e.g., "Singapore", "Cusco", "Paris")' },
                    fromDate: { type: 'string', description: 'Departure/start date in YYYY-MM-DD format (e.g., "2026-12-22")' },
                    toDate: { type: 'string', description: 'Return/end date in YYYY-MM-DD format (e.g., "2027-01-02")' },
                    budget: { type: 'string', description: 'Budget level (e.g., "budget", "moderate", "luxury")' },
                    companions: { type: 'string', description: 'Travel companions (e.g., "solo", "couple", "family", "friends")' },
                    interests: { type: 'array', items: { type: 'string' }, description: 'Travel interests or activities' },
                  },
                },
              },
            },
            {
              type: 'function',
              function: {
                name: 'edit_itinerary',
                description: 'Edit or regenerate the travel itinerary based on user instructions. Use when the user wants to add activities, remove items, swap days, change pace, or fully regenerate their itinerary.',
                parameters: {
                  type: 'object',
                  properties: {
                    instruction: { type: 'string', description: "The user's edit instruction (e.g., \"add a museum visit on day 2\", \"make it more relaxed\", \"swap day 1 and day 3\")" },
                    regenerate: { type: 'boolean', description: 'Set to true to fully regenerate the itinerary from scratch' },
                  },
                  required: ['instruction'],
                },
              },
            },
          ],
        },
        {
          signal: abortSignal,
        },
      );
    } catch (error) {
      if (abortSignal?.aborted || (error as any)?.name === 'AbortError' || (error as any)?.name === 'APIUserAbortError') {
        this.logger.warn(`[Tuffy Groq] stream aborted before first chunk requestId=${reqId || 'unknown'}`);
      } else {
        this.logger.error(`[Tuffy Groq] error creating Groq stream requestId=${reqId || 'unknown'}`, error);
      }
      throw error;
    }

    // Wrap the raw Groq stream in a diagnostic async generator.
    // This lets us log: first chunk received, total chunks, and stream completion or error.
    const logger = this.logger;

    async function* diagnosticStream(): AsyncGenerator<any> {
      let chunkCount = 0;
      try {
        for await (const chunk of rawStream) {
          if (chunkCount === 0) {
            logger.log(`[Tuffy Groq] first chunk received requestId=${reqId || 'unknown'}`);
          }
          chunkCount++;
          yield chunk;
        }
        logger.log(`[Tuffy Groq] stream completed (${chunkCount} chunks) requestId=${reqId || 'unknown'}`);
      } catch (err: any) {
        if (abortSignal?.aborted || err?.name === 'AbortError' || err?.name === 'APIUserAbortError') {
          logger.warn(`[Tuffy Groq] stream aborted after ${chunkCount} chunks requestId=${reqId || 'unknown'}`);
        } else {
          logger.error(`[Tuffy Groq] stream error after ${chunkCount} chunks requestId=${reqId || 'unknown'}`, err);
        }
        throw err;
      }
    }

    return diagnosticStream();
  }
}
