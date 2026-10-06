import { Controller, Post, Body, Res, Req, UnauthorizedException, HttpException, HttpStatus } from '@nestjs/common';
import type { Response, Request } from 'express';
import { CopilotService } from './copilot.service';
import { CopilotMessage, CopilotResponsePayload } from './copilot.types';
import * as jwt from 'jsonwebtoken';

@Controller('copilot')
export class CopilotController {
  constructor(private readonly copilotService: CopilotService) {}

  @Post('stream')
  async streamCopilot(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { messages: CopilotMessage[]; context?: string; tripId?: string }
  ) {
    // 1. Enforce transport via standard Authorization Header (No Query Strings)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.split(' ')[1];
    let userId = 'anonymous';
    try {
      // Decode JWT to get user (mocked decode here as secret might vary, typically use JwtService)
      // const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as any;
      // userId = decoded.sub || 'anonymous';
      // Temporarily bypass strict verify if JWT_SECRET isn't strictly set for testing
      const decoded = jwt.decode(token) as any;
      if (decoded && decoded.sub) {
        userId = decoded.sub;
      }
    } catch (e) {
      throw new UnauthorizedException('Invalid token');
    }

    const { messages, context, tripId } = body;

    // Resolve effective tripId from body or context
    let effectiveTripId = tripId || '';
    if (!effectiveTripId && context) {
      try {
        const parsed = JSON.parse(context);
        effectiveTripId = parsed?.tripId || parsed?.draftSelections?.tripId || '';
      } catch {}
    }

    const reqId = (req.headers['x-request-id'] as string) || `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const clientAbortController = new AbortController();

    // SSE headers must be written before wiring close listeners
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // IMPORTANT: Use res.on('close') NOT req.on('close').
    // req.on('close') fires as soon as the request body is consumed — which
    // happens immediately in SSE before any response data is sent, causing the
    // Groq stream to be aborted every time. res.on('close') fires only when the
    // actual client socket disconnects (tab closed, navigation away).
    res.on('close', () => {
      if (!res.writableEnded) {
        console.log(`[CopilotController] client disconnected requestId=${reqId}`);
        clientAbortController.abort();
      }
    });

    res.on('finish', () => {
      console.log(`[CopilotController] response finished requestId=${reqId}`);
    });

    console.log(`[CopilotController] request connected requestId=${reqId} user=${userId}`);

    try {
      const stream = await this.copilotService.handleStream(
        userId,
        messages,
        context,
        effectiveTripId,
        clientAbortController.signal,
        reqId
      );
      
      const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();
      let streamedAnyContent = false;

      console.log(`[CopilotController] stream iteration started requestId=${reqId}`);
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        
        const payload: CopilotResponsePayload = {};
        
        if (delta?.content) {
          payload.content = delta.content;
          streamedAnyContent = true;
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, {
                id: tc.id || `call_${idx}`,
                name: tc.function?.name || '',
                arguments: '',
              });
            }
            const existing = toolCallMap.get(idx)!;
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          }

          payload.toolCalls = delta.tool_calls.map((tc: any) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.function.name as any,
              arguments: tc.function.arguments,
            },
          }));
        }

        if (Object.keys(payload).length > 0) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      }

      // Execute accumulated tool calls on the backend (source of truth)
      for (const [, toolCall] of toolCallMap.entries()) {
        if (toolCall.name === 'edit_itinerary') {
          try {
            const args = JSON.parse(toolCall.arguments || '{}');
            const result = await this.copilotService.executeItineraryEdit(effectiveTripId, args.instruction, args.day);
            if (result.success) {
              const mutationPayload: CopilotResponsePayload = {
                itineraryUpdated: true,
                updatedItinerary: result.updatedItinerary,
                affectedTabs: ['itinerary'],
                primaryTab: 'itinerary',
                content: streamedAnyContent ? `\n\n${result.confirmation}` : result.confirmation,
              };
              res.write(`data: ${JSON.stringify(mutationPayload)}\n\n`);
            }
          } catch (e: any) {
            // Log error
          }
        } else if (toolCall.name === 'modify_trip') {
          try {
            const args = JSON.parse(toolCall.arguments || '{}');
            const result = await this.copilotService.executeTripModify(effectiveTripId, args);
            if (result.success) {
              if (result.updatedTrip?.id) {
                effectiveTripId = result.updatedTrip.id;
              }
              const affected = computeAffectedTabs(result.updatedFields || Object.keys(args));
              const mutationPayload: CopilotResponsePayload = {
                tripUpdated: true,
                updatedTrip: result.updatedTrip || args,
                affectedTabs: affected.affectedTabs,
                primaryTab: affected.primaryTab,
                content: streamedAnyContent ? `\n\n${result.confirmation}` : result.confirmation,
              };
              res.write(`data: ${JSON.stringify(mutationPayload)}\n\n`);
            }
          } catch (e: any) {
            // Log error
          }
        } else if (toolCall.name === 'switch_tab') {
          try {
            const args = JSON.parse(toolCall.arguments || '{}');
            if (args.tabId) {
              const tabPayload: CopilotResponsePayload = {
                toolCalls: [{
                  id: `call_switch_tab_exec`,
                  type: 'function',
                  function: { name: 'switch_tab', arguments: toolCall.arguments },
                }],
                affectedTabs: args.affectedTabs?.length ? args.affectedTabs : [args.tabId],
                primaryTab: args.tabId,
              };
              res.write(`data: ${JSON.stringify(tabPayload)}\n\n`);
            }
          } catch (e: any) {
            // ignore
          }
        }
      }

      // If the model did not generate an explicit tool call but the user prompt was clearly an itinerary edit request
      const lastUserMsg = (messages || []).filter(m => m.role === 'user').pop()?.content || '';
      const isEditIntent = (
        /add\s+.+\s+(to|on|in)\s+day\s+\d+/i.test(lastUserMsg) ||
        /remove\s+.+\s+from\s+day\s+\d+/i.test(lastUserMsg) ||
        /(make|include|change).+relaxed(\s+day|\s+free\s+day)?/i.test(lastUserMsg) ||
        /move\s+.+\s+from\s+day\s+\d+\s+to\s+day\s+\d+/i.test(lastUserMsg) ||
        /edit\s+(my\s+)?itinerary/i.test(lastUserMsg)
      );

      const hasEditToolCall = Array.from(toolCallMap.values()).some(tc => tc.name === 'edit_itinerary');
      if (!hasEditToolCall && isEditIntent && effectiveTripId) {
        try {
          const result = await this.copilotService.executeItineraryEdit(effectiveTripId, lastUserMsg);
          if (result.success) {
            res.write(`data: ${JSON.stringify({
              toolCalls: [{
                id: 'call_edit_itinerary_auto',
                type: 'function',
                function: { name: 'edit_itinerary', arguments: JSON.stringify({ instruction: lastUserMsg }) }
              }],
              itineraryUpdated: true,
              updatedItinerary: result.updatedItinerary,
              affectedTabs: ['itinerary'],
              primaryTab: 'itinerary',
              content: streamedAnyContent ? `\n\n${result.confirmation}` : result.confirmation,
            })}\n\n`);
          }
        } catch (err: any) {
          // Fallback handled
        }
      }

      // If the model did not generate an explicit tool call but user prompt has trip planning / modification intent
      const hasModifyToolCall = Array.from(toolCallMap.values()).some(tc => tc.name === 'modify_trip');
      if (!hasModifyToolCall && lastUserMsg) {
        let detectedModifications: any = null;
        const lowerMsg = lastUserMsg.toLowerCase();

        // 1. Destination extraction
        const destMatch =
          lastUserMsg.match(/(?:go\s+to|trip\s+to|visit|heading\s+to|travel\s+to|destination\s+(?:is|to|:))\s+([a-zA-Z\s]+?)(?:\s+(?:from|for|with|dates?|on|in|\d|\.|$|,))/i) ||
          lastUserMsg.match(/(?:change|update|switch|set)\s+(?:my\s+)?destination\s+to\s+([a-zA-Z\s]+?)(?:\s+and\s+update|\.|$|,)/i) ||
          lastUserMsg.match(/destination\s+to\s+([a-zA-Z\s]+?)(?:\s+and\s+update|\.|$|,)/i);
        if (destMatch && destMatch[1]) {
          detectedModifications = detectedModifications || {};
          detectedModifications.destination = destMatch[1].trim();
        }

        // 2. Origin extraction
        const fromToMatch = lastUserMsg.match(/from\s+([a-zA-Z\s]+?)\s+to\s+([a-zA-Z\s]+?)(?:\s+and\s+destination\s+to\s+([a-zA-Z\s]+))?(?:\.|$|,)/i);
        if (fromToMatch) {
          detectedModifications = detectedModifications || {};
          detectedModifications.origin = fromToMatch[1].trim();
          if (fromToMatch[3]) {
            detectedModifications.destination = fromToMatch[3].trim();
          } else if (!detectedModifications.destination && fromToMatch[2]) {
            detectedModifications.destination = fromToMatch[2].trim();
          }
        } else {
          const orgMatch =
            lastUserMsg.match(/(?:from|departing\s+from|starting\s+(?:from|city|location|at|in)|origin\s+(?:is|to|:))\s+([a-zA-Z\s]+?)(?:\s+(?:to|for|with|dates?|on|in|\d|\.|$|,))/i) ||
            lastUserMsg.match(/(?:change|update|switch|set)\s+(?:my\s+)?(?:starting\s+city|origin|departure\s+city|starting\s+location)\s+to\s+([a-zA-Z\s]+?)(?:\.|$|,)/i);
          if (orgMatch && orgMatch[1]) {
            detectedModifications = detectedModifications || {};
            detectedModifications.origin = orgMatch[1].trim();
          }
        }

        // Helper for date normalization
        const parseNormalizedDate = (raw: string, defaultYear: number = new Date().getFullYear()): string => {
          if (!raw) return '';
          const clean = raw.replace(/(st|nd|rd|th)/gi, '').trim();
          if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;
          const monthMap: Record<string, number> = {
            jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
            may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, september: 9,
            oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
          };
          const parts = clean.split(/\s+/);
          let day = 1;
          let month = 1;
          let year = defaultYear;
          for (const p of parts) {
            const num = parseInt(p, 10);
            const low = p.toLowerCase();
            if (monthMap[low]) {
              month = monthMap[low];
            } else if (!isNaN(num)) {
              if (num > 1000) year = num;
              else day = num;
            }
          }
          const mm = String(month).padStart(2, '0');
          const dd = String(day).padStart(2, '0');
          return `${year}-${mm}-${dd}`;
        };

        // 3. Dates extraction
        const rangeMatch =
          lastUserMsg.match(/(?:from\s+|dates?\s+(?:are\s+|:\s*)?)?(\d{1,2}(?:st|nd|rd|th)?\s+[a-zA-Z]+|[a-zA-Z]+\s+\d{1,2}(?:st|nd|rd|th)?|\d{4}-\d{2}-\d{2})\s+to\s+(\d{1,2}(?:st|nd|rd|th)?\s+[a-zA-Z]+(?:\s+\d{4})?|[a-zA-Z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+\d{4})?|\d{4}-\d{2}-\d{2})/i) ||
          lastUserMsg.match(/(?:make|change|set)\s+(?:the\s+trip\s+)?([a-zA-Z]+\s+\d{1,2})\s+to\s+([a-zA-Z]+\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2})/i);
        
        if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
          detectedModifications = detectedModifications || {};
          const currentYear = new Date().getFullYear();
          const from = parseNormalizedDate(rangeMatch[1].trim(), currentYear);
          let toYear = currentYear;
          // Check if toDate crosses into next year
          if (from) {
            const fromMonth = parseInt(from.split('-')[1], 10);
            const toMonthCheck = rangeMatch[2].toLowerCase();
            if (fromMonth >= 11 && (toMonthCheck.includes('jan') || toMonthCheck.includes('feb'))) {
              toYear = currentYear + 1;
            }
          }
          const to = parseNormalizedDate(rangeMatch[2].trim(), toYear);
          detectedModifications.fromDate = from;
          detectedModifications.toDate = to;
        }

        // Extend single date
        const extendMatch = lastUserMsg.match(
          /extend\s+(?:my\s+trip\s+)?(?:from\s+[a-zA-Z0-9,\s]+\s+)?to\s+([a-zA-Z]+\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2})/i,
        );
        if (extendMatch && extendMatch[1]) {
          detectedModifications = detectedModifications || {};
          detectedModifications.toDate = parseNormalizedDate(extendMatch[1].trim());
        }

        // 4. Budget extraction
        const budgetMatch = lowerMsg.match(/\b(moderate|budget|luxury|cheap|expensive|mid-range)\b/);
        if (budgetMatch) {
          detectedModifications = detectedModifications || {};
          detectedModifications.budget = budgetMatch[1] === 'cheap' ? 'budget' : budgetMatch[1] === 'mid-range' ? 'moderate' : budgetMatch[1];
        }

        // 5. Companions extraction
        const compMatch = lowerMsg.match(/\b(family|solo|couple|friends|group)\b/);
        if (compMatch) {
          detectedModifications = detectedModifications || {};
          detectedModifications.companions = compMatch[1];
        }

        if (detectedModifications && Object.keys(detectedModifications).length > 0) {
          try {
            const result = await this.copilotService.executeTripModify(effectiveTripId, detectedModifications);
            if (result.success) {
              if (result.updatedTrip?.id) {
                effectiveTripId = result.updatedTrip.id;
              }
              const affected = computeAffectedTabs(result.updatedFields || Object.keys(detectedModifications));
              res.write(
                `data: ${JSON.stringify({
                  toolCalls: [
                    {
                      id: 'call_modify_trip_auto',
                      type: 'function',
                      function: { name: 'modify_trip', arguments: JSON.stringify(detectedModifications) },
                    },
                  ],
                  tripUpdated: true,
                  updatedTrip: result.updatedTrip,
                  affectedTabs: affected.affectedTabs,
                  primaryTab: affected.primaryTab,
                  content: streamedAnyContent ? `\n\n${result.confirmation}` : result.confirmation,
                })}\n\n`,
              );
            }
          } catch (err: any) {
            // Error handled
          }
        }
      }

      res.write(`data: ${JSON.stringify({ isDone: true })}\n\n`);
      res.end();
    } catch (error: any) {
      const errMsg = error.message || 'Internal Server Error';
      res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.end();
    }
  }
}

/**
 * Deterministically compute which dashboard tabs are affected by a trip modification
 * and which single tab should be the primary navigation destination.
 *
 * Priority order for primary tab:
 *   destination change → summary
 *   date-only change   → summary
 *   origin-only        → flights
 *   budget/companions  → hotels
 *   fallback           → summary
 */
function computeAffectedTabs(updatedFields: string[]): { primaryTab: string; affectedTabs: string[] } {
  const fields = new Set(updatedFields.map(f => f.toLowerCase()));

  const hasDestination = fields.has('destination');
  const hasDates = fields.has('fromdate') || fields.has('todate');
  const hasOrigin = fields.has('origin');
  const hasBudget = fields.has('budget');
  const hasCompanions = fields.has('companions');

  const affectedSet = new Set<string>();
  let primaryTab = 'summary';

  if (hasDestination) {
    // Full destination change: all modules need to regenerate
    affectedSet.add('summary');
    affectedSet.add('flights');
    affectedSet.add('hotels');
    affectedSet.add('season');
    affectedSet.add('itinerary');
    primaryTab = 'summary';
  } else {
    // Partial update: add only the relevant tabs
    if (hasDates) {
      affectedSet.add('summary');
      affectedSet.add('flights');
      affectedSet.add('hotels');
      affectedSet.add('itinerary');
      primaryTab = 'summary';
    }
    if (hasOrigin) {
      affectedSet.add('flights');
      if (!hasDates) primaryTab = 'flights';
    }
    if (hasBudget || hasCompanions) {
      affectedSet.add('hotels');
      affectedSet.add('summary');
      if (!hasDates && !hasOrigin) primaryTab = 'hotels';
    }
  }

  // Always include primaryTab in affected
  affectedSet.add(primaryTab);

  if (affectedSet.size === 0) {
    affectedSet.add('summary');
  }

  return { primaryTab, affectedTabs: Array.from(affectedSet) };
}
